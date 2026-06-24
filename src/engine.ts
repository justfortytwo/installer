// engine.ts — access to the optional @justfortytwo/* engine siblings.
//
// The installer declares the engine packages as OPTIONAL peerDependencies and
// reaches them via dynamic import, so a partial install (e.g. gate-only) never
// crashes the CLI — a missing sibling makes the dependent command/check report
// "not installed" instead of throwing.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

/** Dynamically import an engine sibling; null if it is not installed. */
export async function loadSibling<T = Record<string, unknown>>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T;
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
 * Installed version of a sibling (its package.json `version`), or null. Walks up
 * ancestor `node_modules` dirs exactly like Node's resolver — pure fs, so it is
 * immune to import-only `exports` maps (which defeat require.resolve) and to
 * bundled test runners where import.meta.resolve is unavailable. Matches where
 * loadSibling's dynamic import would find the package.
 */
export function readInstalledVersion(spec: string): string | null {
  const segments = spec.split('/'); // e.g. ['@justfortytwo', 'gate']
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'node_modules', ...segments, 'package.json');
    if (existsSync(candidate)) {
      try {
        return (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    }
    if (dir === root) return null;
    dir = dirname(dir);
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

/**
 * Minimal semver-range satisfaction for the forms this CLI's compat contract
 * uses: exact (`1.2.3`) and caret (`^1.2.3`, with npm's 0.x rule where the
 * left-most non-zero element is the lock point). Avoids a runtime dependency.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parse3 = (v: string): [number, number, number] => {
    const [a = 0, b = 0, c = 0] = v.replace(/^[v^~]/, '').split('.').map((n) => parseInt(n, 10));
    return [a, b, c];
  };
  const [vMaj, vMin, vPatch] = parse3(version);
  const [rMaj, rMin, rPatch] = parse3(range);
  if (Number.isNaN(vMaj) || Number.isNaN(rMaj)) return false;
  if (!range.startsWith('^')) return vMaj === rMaj && vMin === rMin && vPatch === rPatch;
  const geFloor =
    vMaj > rMaj || (vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPatch >= rPatch)));
  if (!geFloor) return false;
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
