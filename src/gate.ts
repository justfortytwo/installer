// gate.ts — switch the optional safety gate on or off for a project.
//
// The gate (@justfortytwo/gate) is installed with every project but does nothing
// until Claude Code is told to run its PreToolUse hook. "On" means exactly that:
// a hook entry in the project's `.claude/settings.json`. That entry is the single
// switch; nothing else records the state. It is OFF unless the owner asks.
//
// Turning it on also puts a capability manifest and a Bash allowlist in place
// (assets/gate/), because without a manifest the hook fails closed and denies
// every tool call. Both files are the owner's to tune: an existing one is never
// overwritten, and turning the gate off leaves them where they are.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSiblingDir } from './engine.js';

export const GATE_PKG = '@justfortytwo/gate';
export const SETTINGS_FILE = join('.claude', 'settings.json');
export const MANIFEST_FILE = join('.claude', 'policy', 'capabilities.toml');
export const ALLOWLIST_FILE = join('rules', 'bash-allowlist.jsonl');

/** The gate's hook script inside its package; also how its hook entry is recognised. */
const HOOK_SCRIPT = 'gate-hook.js';

interface HookHandler { type?: unknown; command?: unknown; [k: string]: unknown }
interface HookGroup { matcher?: unknown; hooks?: unknown; [k: string]: unknown }
type Settings = Record<string, unknown>;

/** The policy files shipped with this CLI (`<package>/assets/gate`). */
export function gateAssetsDir(): string {
  // src/gate.ts and dist/gate.js both sit one level below the package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'gate');
}

/**
 * The hook command for this project. It goes through `$CLAUDE_PROJECT_DIR` (set
 * by Claude Code for every hook) so it keeps working after the session changes
 * directory and when the project folder is moved or mounted elsewhere. A gate
 * installed above the project (a workspace root) is addressed by absolute path.
 */
export function hookCommand(root: string, gateDir: string): string {
  const script = join(gateDir, 'dist', HOOK_SCRIPT);
  const rel = relative(resolve(root), script);
  if (rel.startsWith('..') || isAbsolute(rel)) return `node "${script}"`;
  return `node "$CLAUDE_PROJECT_DIR/${rel.split(sep).join('/')}"`;
}

function isGateHandler(h: unknown): boolean {
  const command = (h as HookHandler | null)?.command;
  return typeof command === 'string' && command.includes(HOOK_SCRIPT) && command.includes('gate');
}

function preToolUseGroups(settings: Settings): HookGroup[] {
  const hooks = settings['hooks'];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const groups = (hooks as Record<string, unknown>)['PreToolUse'];
  return Array.isArray(groups) ? (groups as HookGroup[]) : [];
}

/** The gate hook command wired in these settings, or null when there is none. */
export function findGateHook(settings: Settings): string | null {
  for (const group of preToolUseGroups(settings)) {
    const handlers = Array.isArray(group?.hooks) ? (group.hooks as unknown[]) : [];
    const hit = handlers.find(isGateHandler) as HookHandler | undefined;
    if (hit) return hit.command as string;
  }
  return null;
}

/** Settings with the gate hook added (unchanged when one is already there). Input untouched. */
export function withGateHook(settings: Settings, command: string): Settings {
  if (findGateHook(settings) !== null) return settings;
  const hooks = settings['hooks'];
  if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) {
    throw new Error('"hooks" is not an object');
  }
  const prior = (hooks as Record<string, unknown> | undefined)?.['PreToolUse'];
  if (prior !== undefined && !Array.isArray(prior)) throw new Error('"hooks.PreToolUse" is not an array');
  const group = { matcher: '*', hooks: [{ type: 'command', command }] };
  return { ...settings, hooks: { ...(hooks as object | undefined), PreToolUse: [...((prior as unknown[]) ?? []), group] } };
}

/** Settings with every gate hook removed; other hooks and settings are kept. Input untouched. */
export function withoutGateHook(settings: Settings): Settings {
  if (findGateHook(settings) === null) return settings;
  const groups = preToolUseGroups(settings)
    .map((group) => (Array.isArray(group?.hooks)
      ? { ...group, hooks: (group.hooks as unknown[]).filter((h) => !isGateHandler(h)) }
      : group))
    .filter((group) => !Array.isArray(group?.hooks) || (group.hooks as unknown[]).length > 0);
  const hooks = { ...(settings['hooks'] as Record<string, unknown>) };
  if (groups.length > 0) hooks['PreToolUse'] = groups;
  else delete hooks['PreToolUse'];
  const out = { ...settings };
  if (Object.keys(hooks).length > 0) out['hooks'] = hooks;
  else delete out['hooks'];
  return out;
}

/**
 * The project's `.claude/settings.json` ({} when absent). Throws when the file
 * is not a JSON object: it is the owner's file, so it is never replaced blind.
 */
export function readSettings(root: string): Settings {
  const path = join(root, SETTINGS_FILE);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${SETTINGS_FILE} is not valid JSON (${(e as Error).message}); fix it and run this again`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_FILE} is not a JSON object; fix it and run this again`);
  }
  return parsed as Settings;
}

function writeSettings(root: string, settings: Settings): void {
  const path = join(root, SETTINGS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export interface GateState {
  /** The wired hook command; null = the gate is off. */
  hook: string | null;
  /** Whether @justfortytwo/gate (with its hook script) is installed in the project. */
  installed: boolean;
  manifest: boolean;
  allowlist: boolean;
  /** Why the state could not be read (settings.json unreadable); the gate is then treated as off. */
  error?: string;
}

export function gateState(root: string): GateState {
  const gateDir = findSiblingDir(GATE_PKG, root);
  const state: GateState = {
    hook: null,
    installed: gateDir !== null && existsSync(join(gateDir, 'dist', HOOK_SCRIPT)),
    manifest: existsSync(join(root, MANIFEST_FILE)),
    allowlist: existsSync(join(root, ALLOWLIST_FILE)),
  };
  try {
    state.hook = findGateHook(readSettings(root));
  } catch (e) {
    state.error = (e as Error).message;
  }
  return state;
}

/** True when the gate hook is wired for this project. Never throws. */
export function gateOn(root: string): boolean {
  return gateState(root).hook !== null;
}

export interface GateChange {
  /** False when the gate was already in the requested state. */
  changed: boolean;
  /** Policy files created by this call (relative to the project root). */
  created: string[];
}

function copyIfAbsent(root: string, file: string, asset: string, created: string[]): void {
  const target = join(root, file);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(gateAssetsDir(), asset), 'utf8'), 'utf8');
  created.push(file);
}

/**
 * Turn the gate on: put the policy files in place when missing, then wire the
 * hook. Throws (changing nothing) when the gate package is not installed or
 * settings.json cannot be read.
 */
export function enableGate(root: string): GateChange {
  const gateDir = findSiblingDir(GATE_PKG, root);
  if (!gateDir || !existsSync(join(gateDir, 'dist', HOOK_SCRIPT))) {
    throw new Error(`${GATE_PKG} is not installed in this project (run \`fortytwo update\`)`);
  }
  const settings = readSettings(root);
  const next = withGateHook(settings, hookCommand(root, gateDir));
  // Policy first: a wired hook without a manifest denies every tool call.
  const created: string[] = [];
  copyIfAbsent(root, MANIFEST_FILE, 'capabilities.toml', created);
  copyIfAbsent(root, ALLOWLIST_FILE, 'bash-allowlist.jsonl', created);
  if (next !== settings) writeSettings(root, next);
  return { changed: next !== settings, created };
}

/** Turn the gate off: remove its hook. The policy files and pending approvals stay. */
export function disableGate(root: string): GateChange {
  const settings = readSettings(root);
  const next = withoutGateHook(settings);
  if (next !== settings) writeSettings(root, next);
  return { changed: next !== settings, created: [] };
}
