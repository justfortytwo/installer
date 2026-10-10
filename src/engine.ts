// engine.ts — access to the optional @justfortytwo/* engine siblings.
//
// The engine packages are NOT declared as dependencies or peerDependencies: their
// versions live only in package.json `fortytwo.compat` (installed by init, checked
// by doctor, moved by update). The CLI reaches them via dynamic import resolved
// from the project's node_modules, so a partial install (e.g. gate-only) never
// crashes the CLI — a missing sibling makes the dependent command/check report
// "not installed" instead of throwing.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, parse, resolve } from 'node:path';

// PROJECT-ROOTED RESOLUTION. Siblings live in the TARGET PROJECT's node_modules,
// never next to the installer: under `npx create-fortytwo` the installer runs from
// npm's exec cache (~/.npm/_npx/<hash>/node_modules), a separate tree. So every
// lookup below starts at the project root (the cwd every command operates on),
// not at import.meta.url — a bare `import(spec)` / `createRequire(import.meta.url)`
// would resolve from the exec cache and miss the engine `init` just installed.

/**
 * Directory of an installed sibling, found by walking up `<dir>/node_modules`
 * from the project root exactly like Node's resolver; null if absent. Pure fs,
 * so import-only `exports` maps (gate, telegram) can't defeat it the way they
 * defeat require.resolve.
 */
export function findSiblingDir(spec: string, projectRoot: string = process.cwd()): string | null {
  const segments = spec.split('/'); // e.g. ['@justfortytwo', 'gate']
  let dir = resolve(projectRoot);
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'node_modules', ...segments);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * The ESM entry file of a package's root export, relative to its dir: `exports`
 * (string, `"."`, or a bare conditions object; conditions `import` > `node` >
 * `default`, nested allowed), then `main`, then `index.js`. Null if the root is
 * not exported for import.
 */
export function resolveEsmEntry(pkg: { exports?: unknown; main?: unknown }): string | null {
  const pick = (target: unknown): string | null => {
    if (typeof target === 'string') return target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    const conditions = target as Record<string, unknown>;
    for (const c of ['import', 'node', 'default']) {
      if (c in conditions) {
        const hit = pick(conditions[c]);
        if (hit) return hit;
      }
    }
    return null;
  };
  const { exports } = pkg;
  if (exports !== undefined && exports !== null) {
    const isSubpathMap =
      typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
    return pick(isSubpathMap ? (exports as Record<string, unknown>)['.'] : exports);
  }
  return typeof pkg.main === 'string' && pkg.main ? pkg.main : 'index.js';
}

/** Dynamically import an engine sibling from the project; null if it is not installed. */
export async function loadSibling<T = Record<string, unknown>>(
  spec: string,
  projectRoot: string = process.cwd(),
): Promise<T | null> {
  const dir = findSiblingDir(spec, projectRoot);
  if (!dir) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; main?: unknown };
    const entry = resolveEsmEntry(pkg);
    if (!entry) return null;
    return (await import(pathToFileURL(join(dir, entry)).href)) as T;
  } catch {
    return null;
  }
}

export const loadGate = () => loadSibling<{ POLICY_SCHEMA_VERSION?: number }>('@justfortytwo/gate');
export const loadMemory = () =>
  loadSibling<{
    MEMORY_TOOL_CONTRACT_VERSION?: number;
    // openDb returns memory's DbHandles ({ k: Knex, ... }); typed loosely here to
    // avoid an installer-side dependency on knex's types (it's memory's dep).
    openDb?: (path: string) => { k: { schema: { hasTable(name: string): Promise<boolean> } } };
    runMigrations?: (k: unknown) => Promise<void>;
  }>('@justfortytwo/memory');
export const loadTelegram = () => loadSibling('@justfortytwo/telegram');

/**
 * Installed version of a sibling in the project (its package.json `version`), or
 * null. Same lookup as loadSibling, so the two always agree.
 */
export function readInstalledVersion(spec: string, projectRoot: string = process.cwd()): string | null {
  const dir = findSiblingDir(spec, projectRoot);
  if (!dir) return null;
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** Walk up from this module to find the installer's own package.json. */
function findSelfPackageJson(): Record<string, unknown> | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** The CLI's declared compat ranges (package.json `fortytwo.compat`). */
export function readSelfCompatRanges(): Record<string, string> {
  const pkg = findSelfPackageJson();
  const fortytwo = (pkg?.fortytwo ?? {}) as { compat?: Record<string, string> };
  return fortytwo.compat ?? {};
}

interface SemVer { core: [number, number, number]; pre: string[] }

/** Parse `1.2.3` / `1.2.3-0` / `^1.2.3-rc.1` (leading `v^~=` stripped); null if malformed. */
function parseSemver(v: string): SemVer | null {
  const m = /^[v^~=]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * Full semver precedence (-1 / 0 / 1), pre-release aware per semver 2.0:
 * `1.0.0-0 < 1.0.0-1 < 1.0.0`; numeric identifiers compare numerically and
 * sort below alphanumeric ones. Malformed inputs sort lowest.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return Math.sign(pb.pre.length - pa.pre.length);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Minimal semver-range satisfaction for the forms this CLI's compat contract
 * uses: exact (`1.2.3`, `1.0.0-0`) and caret (`^1.2.3`, with npm's 0.x rule
 * where the left-most non-zero element is the lock point). Avoids a runtime
 * dependency. Pre-releases follow npm: an exact pin matches only that exact
 * pre-release, and a caret range admits a pre-release version only when the
 * range itself carries a pre-release on the same major.minor.patch.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = parseSemver(range);
  if (!v || !r) return false;
  if (!range.trim().startsWith('^')) return compareSemver(version, range) === 0;
  if (v.pre.length > 0 && (r.pre.length === 0 || v.core.join('.') !== r.core.join('.'))) return false;
  if (compareSemver(version, range) < 0) return false;
  const [vMaj, vMin, vPatch] = v.core;
  const [rMaj, rMin, rPatch] = r.core;
  if (rMaj > 0) return vMaj === rMaj; // ^1.2.3 -> >=1.2.3 <2.0.0
  if (rMin > 0) return vMaj === 0 && vMin === rMin; // ^0.1.2 -> >=0.1.2 <0.2.0
  return vMaj === 0 && vMin === 0 && vPatch === rPatch; // ^0.0.z -> exact
}

/** GET {baseUrl}/api/tags; return installed model names, or null if unreachable. */
export async function fetchOllamaModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

export type MigrationState = 'ok' | 'missing' | 'pending' | 'unavailable';

/**
 * Migration health for the memory DB: 'missing' (no DB file → run init),
 * 'ok' (the migrated `memories` table exists), 'pending' (DB present but not
 * migrated), or 'unavailable' (memory package not installed / DB unreadable).
 */
export async function readMigrationState(dbPath: string): Promise<MigrationState> {
  const mem = await loadMemory();
  if (!mem || typeof mem.openDb !== 'function') return 'unavailable';
  if (!existsSync(dbPath)) return 'missing';
  let handle: { k: { schema: { hasTable(name: string): Promise<boolean> }; destroy?: () => Promise<void> }; close?: () => void } | undefined;
  try {
    handle = mem.openDb(dbPath);
    const migrated = await handle.k.schema.hasTable('memories');
    return migrated ? 'ok' : 'pending';
  } catch {
    return 'unavailable';
  } finally {
    try { await handle?.k?.destroy?.(); } catch { /* best-effort close */ }
    try { handle?.close?.(); } catch { /* best-effort close */ }
  }
}
