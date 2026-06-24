// init — first-run install + scaffold. The `create-fortytwo` happy path.
//
// End state after a successful init:
//   - .fortytwo/identity.json  written from captured answers (gitignored)
//   - .env                     written with secrets + runtime config (gitignored)
//   - CLAUDE.md + context/*    rendered from @justfortytwo/persona templates
//   - .mcp.json                wired to the memory MCP server
//   - Ollama EMBED_MODEL pulled (warn-only); the memory DB migrated
//   - .fortytwo/state.json     records the resolved sibling version set (rollback baseline)
//   - next-step guidance: set ALLOWED_CHAT_IDS / attach the channel
//
// Authorization model (v0): the channel allowlist is the static ALLOWED_CHAT_IDS
// (written to .env); the bridge authorizes off it. The dynamic /login pairing
// handshake is a future enhancement — see pair.ts — and is intentionally NOT the
// init path yet.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Identity, Answers, VersionPin } from '../state.js';
import { writeIdentity, recordVersionSet } from '../state.js';
import { renderPersona, loadPersonaManifest } from '../render.js';
import { loadMemory, readInstalledVersion, readSelfCompatRanges } from '../engine.js';

// The embedder model the engine standardizes on (privacy: local-only embeddings).
export const EMBED_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_DB_PATH = 'db/fortytwo.db';

export interface ManifestField {
  key: string;
  prompt: string;
  type: 'string' | 'text' | 'list' | string;
  required?: boolean;
  default?: unknown;
}

export interface AnswerSources {
  /** A pre-filled answers map (e.g. from `--answers <file.json>`). Highest precedence. */
  answersFile?: Record<string, unknown>;
  /** process.env (read as FORTYTWO_<UPPER_KEY>). */
  env?: Record<string, string | undefined>;
  /** CLI flags, keyed by manifest field key. */
  flags?: Record<string, string>;
}

function envKey(key: string): string {
  return `FORTYTWO_${key.toUpperCase()}`;
}
function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
function coerceList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Resolve every manifest field from (in precedence order) the answers file, the
 * environment (FORTYTWO_<KEY>), CLI flags, then the manifest default. List
 * fields are coerced to arrays; null/absent values become '' or [] so the
 * renderer (which fails loud on null) never sees a hole. Required fields left
 * empty are reported back, not silently defaulted.
 */
export function resolveAnswers(
  fields: ManifestField[],
  sources: AnswerSources,
): { answers: Answers; missingRequired: string[] } {
  const env = sources.env ?? {};
  const flags = sources.flags ?? {};
  const file = sources.answersFile ?? {};
  const answers: Answers = {};
  const missingRequired: string[] = [];
  for (const f of fields) {
    const raw = file[f.key] ?? env[envKey(f.key)] ?? flags[f.key] ?? f.default ?? null;
    const value: string | string[] = f.type === 'list' ? coerceList(raw) : raw == null ? '' : String(raw);
    answers[f.key] = value;
    if (f.required && isEmpty(value)) missingRequired.push(f.key);
  }
  return { answers, missingRequired };
}

/**
 * Merge `vars` into existing `.env` content: update matching keys in place,
 * append new ones, preserve comments and unrelated lines. Secrets NEVER go to
 * identity.json — only here.
 */
export function mergeEnvContent(existing: string, vars: Record<string, string>): string {
  const out: string[] = [];
  const written = new Set<string>();
  for (const line of existing ? existing.split('\n') : []) {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (key && Object.prototype.hasOwnProperty.call(vars, key)) {
      out.push(`${key}=${vars[key]}`);
      written.add(key);
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(vars)) if (!written.has(k)) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

export interface McpConfig {
  mcpServers: Record<string, unknown>;
  [k: string]: unknown;
}

/** Add (or replace) the `fortytwo-memory` MCP server entry, preserving others. */
export function buildMcpConfig(
  existing: McpConfig | null,
  opts: { dbPath: string; ollamaBaseUrl?: string; embedModel?: string },
): McpConfig {
  const cfg: McpConfig = existing ?? { mcpServers: {} };
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers['fortytwo-memory'] = {
    command: 'npx',
    args: ['-y', '@justfortytwo/memory'],
    // The memory MCP server reads these from its launch env (this block), not .env —
    // so the Ollama URL must be threaded here for a remote/custom endpoint to take effect.
    env: {
      DB_PATH: opts.dbPath,
      EMBED_MODEL: opts.embedModel ?? EMBED_MODEL,
      OLLAMA_BASE_URL: opts.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    },
  };
  return cfg;
}

/** Pin each declared sibling to its installed version; skip the absent. */
export function buildVersionPins(
  compatRanges: Record<string, string>,
  readVersion: (spec: string) => string | null,
): VersionPin[] {
  const pins: VersionPin[] = [];
  for (const [name, range] of Object.entries(compatRanges)) {
    const resolved = readVersion(name);
    if (resolved) pins.push({ name, range, resolved });
  }
  return pins;
}

// --- filesystem wrappers (thin; the merge logic above is what's unit-tested) ---

function writeEnv(secrets: Record<string, string>, root: string): void {
  const path = join(root, '.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, mergeEnvContent(existing, secrets), 'utf8');
}

function writeMcpJson(root: string, dbPath: string, ollamaBaseUrl: string): void {
  const path = join(root, '.mcp.json');
  const existing: McpConfig | null = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as McpConfig)
    : null;
  writeFileSync(
    path,
    JSON.stringify(buildMcpConfig(existing, { dbPath, ollamaBaseUrl }), null, 2) + '\n',
    'utf8',
  );
}

/** Engine packages (from compat ranges) not yet resolvable, as `name@range` install specs. */
export function engineInstallSpecs(
  compatRanges: Record<string, string>,
  isPresent: (spec: string) => boolean,
): string[] {
  return Object.entries(compatRanges)
    .filter(([name]) => !isPresent(name))
    .map(([name, range]) => `${name}@${range}`);
}

/**
 * Make sure the engine packages the persona + commands need are installed in the
 * project. Fresh users get the `create-fortytwo`/`fortytwo` bins from
 * @justfortytwo/installer, but its engine siblings are OPTIONAL peers npm does
 * not auto-install — so init installs whichever are missing. Presence is checked
 * with the SAME resolver the renderer/doctor use (Node's upward node_modules
 * walk), so an already-linked dev tree or a prior install is a no-op.
 * `--no-install` opts out (managed/offline installs).
 */
async function ensureEngine(root: string, opts: { noInstall?: boolean }): Promise<void> {
  const specs = engineInstallSpecs(readSelfCompatRanges(), (s) => readInstalledVersion(s) !== null);
  if (specs.length === 0) return;
  if (opts.noInstall) {
    throw new Error(
      `init: engine packages are not installed: ${specs.join(', ')}\n` +
      `Install them (npm install ${specs.join(' ')}) or omit --no-install.`,
    );
  }
  process.stdout.write(`Installing engine packages: ${specs.join(', ')}\n`);
  if (!existsSync(join(root, 'package.json'))) {
    spawnSync('npm', ['init', '-y'], { cwd: root, stdio: 'ignore' });
  }
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...specs], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    const why = res.error ? res.error.message : `npm exited ${res.status}`;
    throw new Error(`init: failed to install engine packages (${why}). Install manually: npm install ${specs.join(' ')}`);
  }
}

function recordInstalledSet(root: string): VersionPin[] {
  const pins = buildVersionPins(readSelfCompatRanges(), readInstalledVersion);
  recordVersionSet(pins, root);
  return pins;
}

/**
 * Provision local infra: pull the embedder model (warn-only, like wakeup.sh —
 * the engine degrades to a fake embedder rather than hard-failing) and run the
 * memory DB migrations via the memory package (the engine owns the schema; the
 * CLI must not duplicate it).
 */
async function provision(opts: { ollamaBaseUrl: string; embedModel: string; dbPath: string }): Promise<string[]> {
  const notes: string[] = [];
  // 1. embedder model (best-effort)
  const pulled = spawnSync('ollama', ['pull', opts.embedModel], { stdio: 'ignore' });
  if (pulled.status !== 0) {
    notes.push(`! could not pull ${opts.embedModel} via ollama (semantic recall will degrade until it is present)`);
  }
  // 2. db migrations via the memory engine
  const mem = await loadMemory();
  if (mem && typeof mem.openDb === 'function' && typeof (mem as { runMigrations?: unknown }).runMigrations === 'function') {
    mkdirSync(dirname(resolve(opts.dbPath)), { recursive: true });
    const handle = mem.openDb(opts.dbPath) as { k: unknown; close?: () => void };
    try {
      await (mem as unknown as { runMigrations: (k: unknown) => Promise<void> }).runMigrations(handle.k);
      notes.push('✓ memory DB migrated');
    } finally {
      try { await (handle.k as { destroy?: () => Promise<void> })?.destroy?.(); } catch { /* best-effort */ }
      try { handle.close?.(); } catch { /* best-effort */ }
    }
  } else {
    notes.push('! @justfortytwo/memory not installed — skipped DB migration (run `fortytwo init` again after installing the engine)');
  }
  return notes;
}

interface InitFlags {
  yes?: boolean;
  noInstall?: boolean;
  answersFile?: string;
  flags: Record<string, string>;
  secrets: Record<string, string>;
  ollamaBaseUrl: string;
  dbPath: string;
}

/** Parse argv into structured init flags. `--key value` maps to a field/secret. */
function parseInitArgs(argv: string[]): InitFlags {
  const flags: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  let yes = false;
  let noInstall = false;
  let answersFile: string | undefined;
  let ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  let dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const SECRET_FLAGS: Record<string, string> = {
    'telegram-bot-token': 'TELEGRAM_BOT_TOKEN',
    'allowed-chat-ids': 'ALLOWED_CHAT_IDS',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--yes' || a === '-y') { yes = true; continue; }
    if (a === '--no-install') { noInstall = true; continue; }
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const val = argv[++i] ?? '';
    if (name === 'answers') answersFile = val;
    else if (name === 'ollama-base-url') ollamaBaseUrl = val;
    else if (name === 'db-path') dbPath = val;
    else if (SECRET_FLAGS[name]) secrets[SECRET_FLAGS[name]] = val;
    else flags[name.replace(/-/g, '_')] = val; // --agent-name -> agent_name
  }
  if (process.env.TELEGRAM_BOT_TOKEN) secrets.TELEGRAM_BOT_TOKEN ??= process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.ALLOWED_CHAT_IDS) secrets.ALLOWED_CHAT_IDS ??= process.env.ALLOWED_CHAT_IDS;
  return { yes, noInstall, answersFile, flags, secrets, ollamaBaseUrl, dbPath };
}

/** Prompt (readline) for the required fields still missing. TTY only. */
async function promptMissing(fields: ManifestField[], missing: string[], answers: Answers): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const key of missing) {
      const field = fields.find((f) => f.key === key)!;
      const ans = (await rl.question(`${field.prompt}\n> `)).trim();
      answers[key] = field.type === 'list' ? coerceList(ans) : ans;
    }
  } finally {
    rl.close();
  }
}

export async function runInit(argv: string[]): Promise<number> {
  const root = process.cwd();
  const opts = parseInitArgs(argv);

  // Bootstrap: install any missing engine packages before we need them.
  await ensureEngine(root, { noInstall: opts.noInstall });

  const manifest = loadPersonaManifest();
  const answersFile = opts.answersFile && existsSync(opts.answersFile)
    ? (JSON.parse(readFileSync(opts.answersFile, 'utf8')) as Record<string, unknown>)
    : undefined;

  const resolved = resolveAnswers(manifest.fields, { answersFile, env: process.env, flags: opts.flags });
  let { answers } = resolved;
  const { missingRequired } = resolved;

  if (missingRequired.length > 0) {
    const interactive = process.stdin.isTTY && !opts.yes;
    if (!interactive) {
      process.stderr.write(
        `init: missing required answers: ${missingRequired.join(', ')}\n` +
        `Provide them via --answers <file.json>, FORTYTWO_<KEY> env, or run interactively.\n`,
      );
      return 2;
    }
    await promptMissing(manifest.fields, missingRequired, answers);
    const recheck = resolveAnswers(manifest.fields, { answersFile: answers, env: {}, flags: {} });
    answers = recheck.answers;
    if (recheck.missingRequired.length > 0) {
      process.stderr.write(`init: still missing required answers: ${recheck.missingRequired.join(', ')}\n`);
      return 2;
    }
  }

  const identity: Identity = {
    identityVersion: 1,
    answers,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeIdentity(identity, root);

  // Seed runtime config alongside any provided secrets.
  writeEnv(
    {
      OLLAMA_BASE_URL: opts.ollamaBaseUrl,
      EMBED_MODEL,
      DB_PATH: opts.dbPath,
      ...opts.secrets,
    },
    root,
  );

  const render = renderPersona(identity, { root });
  writeMcpJson(root, opts.dbPath, opts.ollamaBaseUrl);
  const provisionNotes = await provision({ ollamaBaseUrl: opts.ollamaBaseUrl, embedModel: EMBED_MODEL, dbPath: opts.dbPath });
  const pins = recordInstalledSet(root);

  // Report.
  const out = process.stdout;
  out.write(`✓ wrote .fortytwo/identity.json (${Object.keys(answers).length} answers)\n`);
  out.write(`✓ wrote .env + .mcp.json (memory MCP wired)\n`);
  out.write(`✓ rendered persona: ${render.written.length} written, ${render.skipped.length} preserved\n`);
  for (const n of provisionNotes) out.write(`  ${n}\n`);
  out.write(`✓ recorded ${pins.length} installed engine package(s)\n`);
  // Telegram is an OPTIONAL channel; init only wires its secrets into .env when
  // you pass them (--telegram-bot-token / --allowed-chat-ids, or the matching env
  // vars). The bridge REFUSES TO START without TELEGRAM_BOT_TOKEN, so surface that
  // requirement here rather than letting the bridge fail on first launch.
  const next: string[] = ['\nNext — to use the Telegram channel (optional):'];
  if (!opts.secrets.TELEGRAM_BOT_TOKEN) {
    next.push("  • set TELEGRAM_BOT_TOKEN in .env — create a bot with @BotFather (the bridge won't start without it)");
  }
  next.push('  • start the channel bridge');
  if (opts.secrets.ALLOWED_CHAT_IDS) {
    next.push(`  • ${opts.secrets.ALLOWED_CHAT_IDS} is already authorized — add more chats with \`fortytwo pair\` → \`/login <code>\``);
  } else {
    next.push('  • authorize a chat: run `fortytwo pair` and send `/login <code>`, or set ALLOWED_CHAT_IDS in .env');
  }
  out.write(next.join('\n') + '\n');
  return 0;
}
