// init — first-run install + scaffold. The `create-fortytwo` happy path.
//
// End state after a successful init:
//   - .fortytwo/identity.json  written from captured answers (gitignored)
//   - .env                     written with secrets + runtime config (gitignored)
//   - CLAUDE.md + context/*    rendered from @justfortytwo/persona templates
//   - .mcp.json                wired to the memory MCP server
//   - Ollama EMBED_MODEL checked/pulled at the chosen OLLAMA_BASE_URL (warn-only); the memory DB migrated
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
import { loadMemory, readInstalledVersion, readSelfCompatRanges, readSelfVersion, fetchOllamaModels, pullOllamaModel } from '../engine.js';
import { homedir } from 'node:os';
import { reconcileOneiros } from '../oneiros.js';
import { migrateChatSafely } from '../transcript-migration.js';
import { installShim, npmGlobalBin, type ShimResult } from '../shim.js';

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

/** The package that extends the memory MCP server with transcript tools. */
export const TRANSCRIPT_PACKAGE = '@justfortytwo/transcript';

/**
 * Add (or re-wire) the `fortytwo-memory` MCP server entry, preserving others.
 * `extensions` (package names) are loaded by memory via FORTYTWO_MCP_EXTENSIONS.
 * memory resolves them from its OWN npx install, so with extensions the launch
 * uses `-p` for every package: they then share one npx prefix.
 *
 * The entry's existing env is kept (a hand-set EMBED_PROVIDER / EMBED_API_KEY /
 * EMBED_MODEL or any other variable survives init and update). Only DB_PATH and
 * FORTYTWO_MCP_EXTENSIONS are always set; OLLAMA_BASE_URL and EMBED_MODEL are
 * set when given, else kept, else defaulted.
 */
export function buildMcpConfig(
  existing: McpConfig | null,
  opts: { dbPath: string; ollamaBaseUrl?: string; embedModel?: string; extensions?: string[] },
): McpConfig {
  const cfg: McpConfig = existing ?? { mcpServers: {} };
  cfg.mcpServers = cfg.mcpServers ?? {};
  const extensions = opts.extensions ?? [];
  const prior = cfg.mcpServers['fortytwo-memory'] as { env?: unknown } | undefined;
  const priorEnv = prior?.env && typeof prior.env === 'object' && !Array.isArray(prior.env)
    ? (prior.env as Record<string, unknown>)
    : {};
  // The memory MCP server reads these from its launch env (this block), not .env —
  // so the Ollama URL must be threaded here for a remote/custom endpoint to take effect.
  const env: Record<string, unknown> = {
    ...priorEnv,
    DB_PATH: opts.dbPath,
    EMBED_MODEL: opts.embedModel ?? priorEnv.EMBED_MODEL ?? EMBED_MODEL,
    OLLAMA_BASE_URL: opts.ollamaBaseUrl ?? priorEnv.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
  };
  if (extensions.length > 0) env.FORTYTWO_MCP_EXTENSIONS = extensions.join(',');
  else delete env.FORTYTWO_MCP_EXTENSIONS;
  cfg.mcpServers['fortytwo-memory'] = {
    command: 'npx',
    args: extensions.length > 0
      ? ['-y', '-p', '@justfortytwo/memory', ...extensions.flatMap((e) => ['-p', e]), 'fortytwo-memory']
      : ['-y', '@justfortytwo/memory'],
    env,
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

/**
 * The project's .mcp.json, or null when absent. Throws a clear error when it
 * exists but is not a JSON object: callers must never overwrite a file they
 * could not parse (it may hold the user's other MCP servers).
 */
export function readMcpJson(root: string): McpConfig | null {
  const path = join(root, '.mcp.json');
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}). Fix or remove it, then re-run; it was left untouched.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not valid JSON for an MCP config (expected an object). Fix or remove it, then re-run; it was left untouched.`);
  }
  return parsed as McpConfig;
}

/** Write (or re-wire) the `fortytwo-memory` entry; shared by init and update. */
export function writeMcpJson(root: string, dbPath: string, ollamaBaseUrl: string): void {
  const path = join(root, '.mcp.json');
  const existing = readMcpJson(root);
  // Wire the transcript extension only when the package is actually installed.
  const extensions = readInstalledVersion(TRANSCRIPT_PACKAGE, root) !== null ? [TRANSCRIPT_PACKAGE] : [];
  writeFileSync(
    path,
    JSON.stringify(buildMcpConfig(existing, { dbPath, ollamaBaseUrl, extensions }), null, 2) + '\n',
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
 * Make sure the project has what it runs on: the engine packages from
 * fortytwo.compat (only the missing ones) and this CLI itself, pinned exactly,
 * so `fortytwo` keeps working after `npx` exits. Presence is checked with the
 * SAME project-rooted resolver the renderer/doctor use, so an already-linked dev
 * tree or a prior install is a no-op. `--no-install` opts out (managed/offline
 * installs).
 */
async function ensureEngine(root: string, opts: { noInstall?: boolean }): Promise<void> {
  const specs = engineInstallSpecs(readSelfCompatRanges(), (s) => readInstalledVersion(s) !== null);
  const cliSpec = cliInstallSpec(
    readSelfVersion(),
    readInstalledVersion(CLI_PACKAGE),
    process.env.FORTYTWO_INSTALLER_SPEC,
  );
  if (specs.length === 0 && !cliSpec) return;
  if (opts.noInstall) {
    if (specs.length === 0) return; // the project CLI is optional under --no-install
    throw new Error(
      `init: engine packages are not installed: ${specs.join(', ')}\n` +
      `Install them (npm install ${specs.join(' ')}) or omit --no-install.`,
    );
  }
  if (!existsSync(join(root, 'package.json'))) {
    spawnSync('npm', ['init', '-y'], { cwd: root, stdio: 'ignore' });
  }
  if (specs.length > 0) {
    process.stdout.write(`Installing engine packages: ${specs.join(', ')}\n`);
    npmInstallOrThrow(root, specs, [], 'engine packages');
  }
  if (cliSpec) {
    // Exact pin: the project's CLI moves only when you re-run init with a newer
    // installer, never as a side effect of `npm install` or `fortytwo update`.
    process.stdout.write(`Adding the fortytwo CLI to this project: ${cliSpec}\n`);
    npmInstallOrThrow(root, [cliSpec], ['--save-exact'], 'the fortytwo CLI');
  }
}

function npmInstallOrThrow(root: string, specs: string[], flags: string[], what: string): void {
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...flags, ...specs], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    const why = res.error ? res.error.message : `npm exited ${res.status}`;
    throw new Error(`init: failed to install ${what} (${why}). Install manually: npm install ${flags.join(' ')} ${specs.join(' ')}`.replace(/  +/g, ' '));
  }
}

export const CLI_PACKAGE = '@justfortytwo/installer';

/**
 * The install spec that pins this CLI into the project (so node_modules/.bin/
 * fortytwo exists and package-lock.json records it), or null when the project
 * already has exactly this version. `override` (FORTYTWO_INSTALLER_SPEC) lets a
 * dev/CI run install a local tarball instead of the registry copy.
 */
export function cliInstallSpec(
  selfVersion: string | null,
  installedVersion: string | null,
  override?: string,
): string | null {
  if (!selfVersion || installedVersion === selfVersion) return null;
  return override || `${CLI_PACKAGE}@${selfVersion}`;
}

function recordInstalledSet(root: string): VersionPin[] {
  const pins = buildVersionPins(readSelfCompatRanges(), readInstalledVersion);
  recordVersionSet(pins, root);
  return pins;
}

/** Ollama HTTP calls ensureEmbedModel makes (injectable for tests). */
export interface EmbedModelDeps {
  listModels: (baseUrl: string) => Promise<string[] | null>;
  pullModel: (baseUrl: string, model: string) => Promise<string | null>;
  log: (line: string) => void;
}

const defaultEmbedModelDeps: EmbedModelDeps = {
  listModels: fetchOllamaModels,
  pullModel: pullOllamaModel,
  log: (line) => { process.stdout.write(line + '\n'); },
};

/**
 * Make sure `model` is available on the Ollama server at `baseUrl` — the SAME
 * endpoint written to .env and .mcp.json. Checks /api/tags first and pulls (over
 * HTTP, on that server) only when missing. Warn-only: returns a status note.
 */
export async function ensureEmbedModel(
  baseUrl: string,
  model: string,
  deps: EmbedModelDeps = defaultEmbedModelDeps,
): Promise<string> {
  const models = await deps.listModels(baseUrl);
  if (models === null) {
    return `! Ollama unreachable at ${baseUrl} — could not check or pull ${model} (semantic recall will degrade until it is available)`;
  }
  if (models.includes(model)) return `✓ embedder ${model} available at ${baseUrl}`;
  deps.log(`Pulling ${model} on ${baseUrl} (this can take a few minutes)…`);
  const err = await deps.pullModel(baseUrl, model);
  if (err) return `! could not pull ${model} via ${baseUrl}: ${err} (semantic recall will degrade until it is present)`;
  return `✓ pulled ${model} on ${baseUrl}`;
}

/**
 * Provision local infra: make the embedder model available (warn-only, like wakeup.sh —
 * the engine degrades to a fake embedder rather than hard-failing) and run the
 * memory DB migrations via the memory package (the engine owns the schema; the
 * CLI must not duplicate it).
 */
async function provision(opts: { ollamaBaseUrl: string; embedModel: string; dbPath: string }): Promise<string[]> {
  const notes: string[] = [];
  // 1. embedder model (best-effort), on the configured endpoint
  notes.push(await ensureEmbedModel(opts.ollamaBaseUrl, opts.embedModel));
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
  /** Explicit `--ollama-base-url`, if given (env/prompt resolution is in resolveOllamaBaseUrl). */
  ollamaBaseUrl?: string;
  dbPath: string;
}

/** Parse argv into structured init flags. `--key value` maps to a field/secret. */
function parseInitArgs(argv: string[]): InitFlags {
  const flags: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  let yes = false;
  let noInstall = false;
  let answersFile: string | undefined;
  let ollamaBaseUrl: string | undefined;
  // Shell env, else the DB_PATH a previous init saved in .env (a re-run keeps a custom path).
  let dbPath = readProjectSetting('DB_PATH') ?? DEFAULT_DB_PATH;
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
    else if (name === 'ollama-base-url') ollamaBaseUrl = val.trim() || undefined;
    else if (name === 'db-path') dbPath = val;
    else if (SECRET_FLAGS[name]) secrets[SECRET_FLAGS[name]] = val;
    else flags[name.replace(/-/g, '_')] = val; // --agent-name -> agent_name
  }
  if (process.env.TELEGRAM_BOT_TOKEN) secrets.TELEGRAM_BOT_TOKEN ??= process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.ALLOWED_CHAT_IDS) secrets.ALLOWED_CHAT_IDS ??= process.env.ALLOWED_CHAT_IDS;
  return { yes, noInstall, answersFile, flags, secrets, ollamaBaseUrl, dbPath };
}

/**
 * A list field's manifest prompt without its "one per line" hint. readline is
 * single-line (Enter — or Shift+Enter in many terminals — submits), so that hint
 * promised input the UI can't take; askList gives the real instructions instead.
 */
export function listPromptLabel(prompt: string): string {
  return prompt.replace(/,?\s*one (?:item |step )?per line\.?\s*$/i, '').trim();
}

/**
 * Collect a list one item per prompt; a blank entry ends it. Each answer is ONE
 * item, verbatim (trimmed) — commas inside it are kept. A required list re-asks
 * on an immediate blank instead of returning []. Pure: `ask` is injected.
 */
export async function askList(
  label: string,
  ask: (prompt: string) => Promise<string>,
  opts: { required?: boolean } = {},
): Promise<string[]> {
  const items: string[] = [];
  let prompt = `${label} — enter one at a time.\nPress Enter on an empty line when done.\n> `;
  while (true) {
    const item = (await ask(prompt)).trim();
    if (item) {
      items.push(item);
      prompt = '> ';
    } else if (items.length === 0 && opts.required) {
      prompt = '  (at least one is required)\n> ';
    } else {
      return items;
    }
  }
}

/** Ask for the required fields still missing, in order; lists item by item. Pure: `ask` is injected. */
export async function askMissingAnswers(
  fields: ManifestField[],
  missing: string[],
  answers: Answers,
  ask: (prompt: string) => Promise<string>,
): Promise<void> {
  for (const key of missing) {
    const field = fields.find((f) => f.key === key)!;
    answers[key] = field.type === 'list'
      ? await askList(listPromptLabel(field.prompt), ask, { required: field.required })
      : (await ask(`${field.prompt}\n> `)).trim();
  }
}

/** Prompt (readline) for the required fields still missing. TTY only. */
async function promptMissing(fields: ManifestField[], missing: string[], answers: Answers): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await askMissingAnswers(fields, missing, answers, (q) => rl.question(q));
  } finally {
    rl.close();
  }
}

/**
 * Interactively offer to capture the OPTIONAL Telegram channel secrets that
 * weren't already supplied (via `--telegram-bot-token` / `--allowed-chat-ids` or
 * the matching env vars). Each is skippable with a blank answer. Pure: the `ask`
 * fn is injected, so it unit-tests without a real readline/TTY. Returns only the
 * secrets to ADD (existing ones are never re-prompted).
 */
export async function collectChannelSecrets(
  existing: Record<string, string>,
  ask: (prompt: string) => Promise<string>,
): Promise<Record<string, string>> {
  const added: Record<string, string> = {};
  if (!existing.TELEGRAM_BOT_TOKEN) {
    const token = (await ask('Telegram bot token from @BotFather (blank to skip — Telegram is optional): ')).trim();
    if (token) added.TELEGRAM_BOT_TOKEN = token;
  }
  if (!existing.ALLOWED_CHAT_IDS) {
    const ids = (await ask('Allowed Telegram chat id(s), comma-separated (blank to skip — you can `fortytwo pair` later): ')).trim();
    if (ids) added.ALLOWED_CHAT_IDS = ids;
  }
  return added;
}

const isHttpUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
};

/** The value of `key` in .env content (last assignment wins; surrounding quotes stripped), or undefined. */
export function readEnvValue(content: string, key: string): string | undefined {
  return parseEnvContent(content)[key] || undefined;
}

/** All `KEY=value` assignments in .env content (last wins; surrounding quotes stripped; other lines ignored). */
export function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) vars[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

/**
 * A runtime setting for a command run inside the project: the shell env wins,
 * else the value `init` saved in `<root>/.env`. The CLI never loads .env into
 * process.env, so without this fallback doctor/forget silently used defaults
 * (e.g. localhost Ollama) whenever the variable was not exported.
 */
export function readProjectSetting(key: string, root: string = process.cwd()): string | undefined {
  const fromShell = process.env[key]?.trim();
  if (fromShell) return fromShell;
  const envPath = join(root, '.env');
  return existsSync(envPath) ? readEnvValue(readFileSync(envPath, 'utf8'), key) : undefined;
}

/**
 * Choose the Ollama endpoint for this init. Precedence:
 *   1. an explicit `--ollama-base-url` — used as-is, never re-asked;
 *   2. interactive: ask, with a default of the inherited OLLAMA_BASE_URL env,
 *      else the value already saved in the project's .env (so re-running init
 *      and pressing Enter keeps a custom endpoint), else http://localhost:11434;
 *      a typed URL is used exactly as entered (an invalid one is re-asked, up to
 *      3 tries);
 *   3. non-interactive (`ask` absent): that same default.
 * Pure: `ask` is injected, so it unit-tests without a TTY.
 */
export async function resolveOllamaBaseUrl(opts: {
  flag?: string;
  env?: string;
  /** OLLAMA_BASE_URL already in the project's .env (from a previous init). */
  saved?: string;
  ask?: (prompt: string) => Promise<string>;
}): Promise<string> {
  if (opts.flag) return opts.flag;
  const fallback = opts.env?.trim() || opts.saved?.trim() || DEFAULT_OLLAMA_BASE_URL;
  if (!opts.ask) return fallback;
  let prompt = `Ollama base URL — where the embedder runs (Enter for ${fallback}): `;
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await opts.ask(prompt)).trim();
    if (!answer) return fallback;
    if (isHttpUrl(answer)) return answer;
    prompt = `  "${answer}" is not an http(s) URL (e.g. http://ollama:11434). Ollama base URL (Enter for ${fallback}): `;
  }
  throw new Error('init: no valid Ollama base URL given (expected http(s)://host:port)');
}

/**
 * The closing "what now" lines. Points at the user-facing lifecycle
 * (`fortytwo start`, `fortytwo pair`), never at the internal service bins.
 * Telegram is optional: its bridge only starts with TELEGRAM_BOT_TOKEN, so say
 * so here rather than let `start` skip it silently.
 */
export function nextSteps(o: { hasBotToken: boolean; allowedChatIds?: string; cmd?: string }): string[] {
  const cmd = o.cmd ?? 'fortytwo';
  const lines = ['', 'Fortytwo is ready.', '', 'Start it with:', `  ${cmd} start`, ''];
  if (!o.hasBotToken) {
    lines.push('To use Telegram, first set TELEGRAM_BOT_TOKEN in .env (create a bot with @BotFather).');
  }
  if (o.allowedChatIds) {
    lines.push(`Telegram chat(s) ${o.allowedChatIds} are already authorized. To connect another, with fortytwo running:`);
  } else {
    lines.push('Then connect Telegram with:');
  }
  lines.push(`  ${cmd} pair`);
  return lines;
}

/**
 * The init report line for the user-level launcher, and the command to tell the
 * user to type: `fortytwo` when our launcher is on PATH, else `npx fortytwo`
 * (which runs the project-local CLI with no download).
 */
export function shimReport(r: ShimResult): { line: string; cmd: string } {
  switch (r.status) {
    case 'installed':
    case 'updated':
    case 'unchanged':
      return { line: `✓ fortytwo command: ${r.path} (runs the CLI of the project you are in)`, cmd: 'fortytwo' };
    case 'foreign':
      return {
        line: `! left ${r.path} alone (not installed by Fortytwo); this project's CLI runs with \`npx fortytwo\``,
        cmd: 'npx fortytwo',
      };
    case 'no-dir':
      return {
        line: '! no writable directory on your PATH for the fortytwo command; run it from this project with `npx fortytwo` (or set FORTYTWO_BIN_DIR and re-run init)',
        cmd: 'npx fortytwo',
      };
    case 'unsupported':
      return { line: `! no fortytwo launcher on ${r.platform}; run it from this project with \`npx fortytwo\``, cmd: 'npx fortytwo' };
  }
}

export async function runInit(argv: string[]): Promise<number> {
  const root = process.cwd();
  const opts = parseInitArgs(argv);
  // Fail before installing or writing anything if .mcp.json cannot be re-wired.
  readMcpJson(root);
  const interactive = process.stdin.isTTY === true && !opts.yes;

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

  // Interactively ask for the Ollama endpoint (Enter keeps the default) and offer
  // the optional Telegram secrets not already provided, so neither needs a second
  // manual .env edit. Non-TTY/--yes runs are unaffected (flags/env/defaults).
  const envPath = join(root, '.env');
  const urlSources = {
    flag: opts.ollamaBaseUrl,
    env: process.env.OLLAMA_BASE_URL,
    saved: existsSync(envPath) ? readEnvValue(readFileSync(envPath, 'utf8'), 'OLLAMA_BASE_URL') : undefined,
  };
  let ollamaBaseUrl: string;
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ask = (q: string) => rl.question(q);
      ollamaBaseUrl = await resolveOllamaBaseUrl({ ...urlSources, ask });
      Object.assign(opts.secrets, await collectChannelSecrets(opts.secrets, ask));
    } finally {
      rl.close();
    }
  } else {
    ollamaBaseUrl = await resolveOllamaBaseUrl(urlSources);
  }

  // Seed runtime config alongside any provided secrets.
  writeEnv(
    {
      OLLAMA_BASE_URL: ollamaBaseUrl, // same value as .mcp.json + the provision check/pull
      EMBED_MODEL,
      DB_PATH: opts.dbPath,
      ...opts.secrets,
    },
    root,
  );

  const render = renderPersona(identity, { root });
  writeMcpJson(root, opts.dbPath, ollamaBaseUrl);
  const provisionNotes = await provision({ ollamaBaseUrl, embedModel: EMBED_MODEL, dbPath: opts.dbPath });
  await reconcileOneiros(root, opts.dbPath);
  const migration = await migrateChatSafely(root, opts.dbPath);
  const pins = recordInstalledSet(root);
  const shim = shimReport(installShim({
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    platform: process.platform,
    override: process.env.FORTYTWO_BIN_DIR || undefined,
    npmGlobalBin,
  }));

  // Report.
  const out = process.stdout;
  out.write(`✓ wrote .fortytwo/identity.json (${Object.keys(answers).length} answers)\n`);
  out.write(`✓ wrote .env + .mcp.json (memory MCP wired)\n`);
  out.write(`✓ rendered persona: ${render.written.length} written, ${render.skipped.length} preserved\n`);
  for (const n of provisionNotes) out.write(`  ${n}\n`);
  if (migration.moved > 0) out.write(`✓ moved ${migration.moved} chat row(s) from memory to the transcript\n`);
  if (migration.error) out.write(`! chat migration skipped: ${migration.error} (memory left intact; fix the cause and re-run \`fortytwo init\` or \`fortytwo update\`)\n`);
  out.write(`✓ recorded ${pins.length} installed engine package(s)\n`);
  out.write(`${shim.line}\n`);
  out.write(nextSteps({
    cmd: shim.cmd,
    hasBotToken: !!opts.secrets.TELEGRAM_BOT_TOKEN,
    allowedChatIds: opts.secrets.ALLOWED_CHAT_IDS,
  }).join('\n') + '\n');
  return 0;
}
