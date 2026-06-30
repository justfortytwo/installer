// doctor — the post-verify health check. Run standalone, and also automatically
// at the end of `update` to decide whether an upgrade is healthy or needs rollback.
//
// Each check is independent and reported individually so a partial failure is
// actionable. Exit code is non-zero if ANY required check fails; warn-only
// checks (embedder) never fail the run.
//
// Checks are pure functions of an injected `DoctorDeps`, so they unit-test
// hermetically; `defaultDoctorDeps()` wires the real engine siblings + Ollama +
// the memory DB. CROSS-PACKAGE CONTRACTS asserted: gate's POLICY_SCHEMA_VERSION
// and memory's MEMORY_TOOL_CONTRACT_VERSION must equal what this CLI was built
// against, and installed siblings must satisfy the declared compat ranges.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadGate, loadMemory, readInstalledVersion, readSelfCompatRanges,
  satisfiesRange, fetchOllamaModels, readMigrationState, type MigrationState,
} from '../engine.js';
import { EMBED_MODEL, DEFAULT_OLLAMA_BASE_URL, DEFAULT_DB_PATH } from './init.js';

// The contract versions this CLI was authored against. A sibling advertising a
// different MAJOR has broken the contract — doctor must flag it loudly.
const EXPECTED_POLICY_SCHEMA = 1;
const EXPECTED_MEMORY_CONTRACT = 1;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed required check makes doctor exit non-zero; warn-only checks don't. */
  required: boolean;
}

/**
 * Heartbeat staleness threshold: 3× the scheduler's 30s poll interval.
 * If the heartbeat file is older than this, the daemon is considered stopped.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/** Everything the checks need, injectable so tests stay hermetic. */
export interface DoctorDeps {
  loadGate: () => Promise<{ POLICY_SCHEMA_VERSION?: number } | null>;
  loadMemory: () => Promise<{ MEMORY_TOOL_CONTRACT_VERSION?: number } | null>;
  installedVersion: (spec: string) => string | null;
  /** spec -> declared semver range (from this CLI's fortytwo.compat). */
  compatRanges: Record<string, string>;
  /** Installed Ollama model names, or null if unreachable. */
  ollamaModels: () => Promise<string[] | null>;
  embedModel: string;
  migrationState: () => Promise<MigrationState>;
  /** Returns the parsed heartbeat, or null if missing/unreadable. */
  schedulerHeartbeat: () => { pid: number; ts: string } | null;
  /** Returns the current time as an ISO string. */
  now: () => string;
}

async function checkGate(deps: DoctorDeps): Promise<CheckResult> {
  const name = 'safety gate';
  const gate = await deps.loadGate();
  if (!gate) {
    return { name, ok: false, required: true, detail: '@justfortytwo/gate is not installed' };
  }
  const v = gate.POLICY_SCHEMA_VERSION;
  if (v !== EXPECTED_POLICY_SCHEMA) {
    return { name, ok: false, required: true, detail: `policySchema version ${v} != expected ${EXPECTED_POLICY_SCHEMA}` };
  }
  return { name, ok: true, required: true, detail: `gate present, policySchema v${v}` };
}

async function checkMemoryContract(deps: DoctorDeps): Promise<CheckResult> {
  const name = 'memory-mcp contract';
  const mem = await deps.loadMemory();
  if (!mem) {
    return { name, ok: false, required: true, detail: '@justfortytwo/memory is not installed' };
  }
  const v = mem.MEMORY_TOOL_CONTRACT_VERSION;
  if (v !== EXPECTED_MEMORY_CONTRACT) {
    return { name, ok: false, required: true, detail: `memory tool contract version ${v} != expected ${EXPECTED_MEMORY_CONTRACT}` };
  }
  return { name, ok: true, required: true, detail: `memory present, tool contract v${v}` };
}

async function checkCompat(deps: DoctorDeps): Promise<CheckResult> {
  const name = 'peerDeps / fortytwo.compat';
  const drift: string[] = [];
  const seen: string[] = [];
  for (const [spec, range] of Object.entries(deps.compatRanges)) {
    const installed = deps.installedVersion(spec);
    if (installed === null) continue; // optional sibling not installed — not a drift
    seen.push(`${spec}@${installed}`);
    if (!satisfiesRange(installed, range)) drift.push(`${spec}@${installed} ∉ ${range}`);
  }
  if (drift.length > 0) {
    return { name, ok: false, required: true, detail: `compat drift: ${drift.join('; ')}` };
  }
  return { name, ok: true, required: true, detail: seen.length ? `in range: ${seen.join(', ')}` : 'no engine siblings installed' };
}

async function checkEmbedder(deps: DoctorDeps): Promise<CheckResult> {
  // Warn-only: a missing embedder degrades semantic recall (FakeEmbedder
  // fallback) but never blocks the assistant — mirrors wakeup.sh.
  const name = 'embedder model';
  const models = await deps.ollamaModels();
  if (models === null) {
    return { name, ok: false, required: false, detail: 'Ollama unreachable (semantic recall will degrade)' };
  }
  if (!models.includes(deps.embedModel)) {
    return { name, ok: false, required: false, detail: `model ${deps.embedModel} not pulled (run: ollama pull ${deps.embedModel})` };
  }
  return { name, ok: true, required: false, detail: `${deps.embedModel} present` };
}

async function checkMigrations(deps: DoctorDeps): Promise<CheckResult> {
  const name = 'db migrations';
  const state = await deps.migrationState();
  switch (state) {
    case 'ok':
      return { name, ok: true, required: true, detail: 'memory DB migrated' };
    case 'missing':
      return { name, ok: false, required: true, detail: 'no memory DB found — run `fortytwo init` first' };
    case 'pending':
      return { name, ok: false, required: true, detail: 'memory DB present but not migrated' };
    case 'unavailable':
      return { name, ok: false, required: false, detail: 'memory package not installed — cannot check migrations' };
  }
}

async function checkSchedulerHeartbeat(deps: DoctorDeps): Promise<CheckResult> {
  // Warn-only: a missing or stale scheduler daemon degrades proactive scheduling
  // but never blocks the assistant — mirrors the embedder check pattern.
  const name = 'scheduler daemon';
  const hb = deps.schedulerHeartbeat();
  if (hb === null) {
    return { name, ok: false, required: false, detail: 'scheduler daemon not running (no heartbeat found)' };
  }
  const nowMs = new Date(deps.now()).getTime();
  const tsMs = new Date(hb.ts).getTime();
  if (nowMs - tsMs > HEARTBEAT_STALE_MS) {
    return { name, ok: false, required: false, detail: `scheduler heartbeat stale — last seen ${hb.ts} (daemon may be stopped)` };
  }
  return { name, ok: true, required: false, detail: `scheduler daemon alive (pid ${hb.pid}, last seen ${hb.ts})` };
}

/**
 * Run all checks, return per-check results + aggregate. Reused by `update` as
 * the post-install verify step. Aggregate ok = every required check passed.
 */
export async function runDoctorChecks(deps: DoctorDeps): Promise<{ results: CheckResult[]; ok: boolean }> {
  const results = await Promise.all([
    checkGate(deps),
    checkMemoryContract(deps),
    checkCompat(deps),
    checkEmbedder(deps),
    checkMigrations(deps),
    checkSchedulerHeartbeat(deps),
  ]);
  const ok = results.every((r) => r.ok || !r.required);
  return { results, ok };
}

/** Wire the real engine siblings, Ollama, and memory DB into the checks. */
export function defaultDoctorDeps(): DoctorDeps {
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const embedModel = process.env.EMBED_MODEL ?? EMBED_MODEL;
  const hbPath = join(dirname(dbPath), 'scheduler.heartbeat');
  return {
    loadGate,
    loadMemory,
    installedVersion: readInstalledVersion,
    compatRanges: readSelfCompatRanges(),
    ollamaModels: () => fetchOllamaModels(ollamaBaseUrl),
    embedModel,
    migrationState: () => readMigrationState(dbPath),
    schedulerHeartbeat: () => {
      try {
        const raw = readFileSync(hbPath, 'utf-8');
        return JSON.parse(raw) as { pid: number; ts: string };
      } catch {
        return null;
      }
    },
    now: () => new Date().toISOString(),
  };
}

export async function runDoctor(_argv: string[]): Promise<number> {
  const { results, ok } = await runDoctorChecks(defaultDoctorDeps());
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : r.required ? 'FAIL' : 'warn';
    process.stdout.write(`[${mark}] ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(ok ? '\ndoctor: healthy\n' : '\ndoctor: required checks failed\n');
  return ok ? 0 : 1;
}
