// update / rollback — move the engine across the declared semver ranges.
//
// Distribution policy: "semver ranges, latest-compatible". There is NO curated
// bill-of-materials. update:
//   1. RESOLVE latest-in-range for every installed @justfortytwo/* sibling
//      (the ranges in this CLI's fortytwo.compat).
//   2. INSTALL that set (npm).
//   3. ROTATE the ledger (state.json: previous := the pre-update set) the moment
//      the install lands, so rollback always targets the set that was running.
//   4. POST-VERIFY with doctor. On failure: leave the new set in place but LOUDLY
//      point at `fortytwo rollback` — rollback is MANUAL by design (never auto-
//      revert, so the user can inspect first). On success: reconcile machine-owned runtime assets only.
//      Existing context is never re-rendered by update.
//
// rollback re-installs state.json's `previous` set and rotates the ledger back.
// Both share the resolve/install primitives below and are unit-tested through an
// injected `*Deps` (so no test touches the network or the real npm).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive, liveRuntime } from '../runtime.js';
import { HEARTBEAT_STALE_MS } from './doctor.js';
import {
  recordVersionSet, readState,
  type VersionPin, type InstallState,
} from '../state.js';
import { compareSemver, readInstalledVersion, readSelfCompatRanges, readSelfVersion, satisfiesRange } from '../engine.js';
import { runDoctorChecks, defaultDoctorDeps, type CheckResult } from './doctor.js';
import { reconcileOneiros } from '../oneiros.js';
import { migrateChatToTranscript, type MigrationResult } from '../transcript-migration.js';
import {
  readProjectSetting, writeMcpJson, DEFAULT_DB_PATH, DEFAULT_OLLAMA_BASE_URL, CLI_PACKAGE, cliInstallSpec,
} from './init.js';

// --- pure: pick the latest published version satisfying a range ---

/** Semver precedence (-1 / 0 / 1), pre-release aware (`1.0.0-0 < 1.0.0`). */
export function compareVersions(a: string, b: string): number {
  return compareSemver(a, b);
}

/** Highest version in `versions` that satisfies `range`, or null if none do. */
export function pickLatestInRange(versions: string[], range: string): string | null {
  const ok = versions.filter((v) => satisfiesRange(v, range)).sort(compareVersions);
  return ok.at(-1) ?? null;
}

/** Resolve each declared range to its latest published in-range version. */
export async function resolveLatestInRange(
  ranges: Record<string, string>,
  fetchVersions: (pkg: string) => Promise<string[]>,
): Promise<VersionPin[]> {
  const pins: VersionPin[] = [];
  for (const [name, range] of Object.entries(ranges)) {
    const versions = await fetchVersions(name);
    const resolved = pickLatestInRange(versions, range);
    if (!resolved) {
      throw new Error(
        `no published version of ${name} satisfies ${range} (saw: ${versions.join(', ') || 'none'})`,
      );
    }
    pins.push({ name, range, resolved });
  }
  return pins;
}

// --- orchestration (injectable deps so tests stay hermetic) ---

export interface InstallResult { ok: boolean; detail: string }

export interface UpdateDeps {
  /** Running CLI, not the target project package; optional for embedded callers. */
  runningInstallerVersion?: () => string | null;
  persistInstaller?: (exactSpec: string) => InstallResult;
  readState: () => InstallState | null;
  runtimeActive?: () => boolean;
  installedVersion: (spec: string) => string | null;
  /** spec -> declared semver range (this CLI's fortytwo.compat). */
  compatRanges: Record<string, string>;
  /** Published versions for a package (registry query). */
  fetchVersions: (pkg: string) => Promise<string[]>;
  /** Install the given `name@version` specs. */
  install: (specs: string[]) => InstallResult;
  /** Post-install health check (doctor). */
  doctor: () => Promise<{ results: CheckResult[]; ok: boolean }>;
  /** Persist the resolved set, rotating current -> previous. */
  record: (pins: VersionPin[]) => void;
  /** Reconcile machine-owned runtime assets; never render persona context. */
  reconcile: () => Promise<void>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface RollbackDeps {
  readState: () => InstallState | null;
  install: (specs: string[]) => InstallResult;
  doctor: () => Promise<{ results: CheckResult[]; ok: boolean }>;
  record: (pins: VersionPin[]) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

function printChecks(results: CheckResult[], out: (s: string) => void): void {
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : r.required ? 'FAIL' : 'warn';
    out(`[${mark}] ${r.name}: ${r.detail}\n`);
  }
}

export async function performUpdate(deps: UpdateDeps, flags: { dryRun?: boolean }): Promise<number> {
  if (!deps.readState()) {
    deps.err('update: no install found — run `fortytwo init` first.\n');
    return 2;
  }

  if (!flags.dryRun && deps.runtimeActive?.()) {
    deps.err('update: stop the running runtime first (`fortytwo stop`, or your service manager), run `fortytwo update`, then `fortytwo start`. No packages or context were changed.\n');
    return 1;
  }

  if (deps.runningInstallerVersion) {
    const running = deps.runningInstallerVersion();
    const installed = deps.installedVersion(CLI_PACKAGE);
    if (!running || !deps.persistInstaller) {
      deps.err('update: cannot determine or persist the running installer version.\n');
      return 1;
    }
    if (installed && compareVersions(running, installed) < 0) {
      deps.err('update: the project installer is newer than this command. Use the project-local fortytwo update.\n');
      return 1;
    }
    const spec = cliInstallSpec(running, installed);
    if (spec) {
      deps.out(`update: pin project installer to ${spec}${flags.dryRun ? ' (dry-run)' : ''}\n`);
      if (!flags.dryRun) {
        const result = deps.persistInstaller(spec);
        if (!result.ok) {
          deps.err(`update: installer persistence failed (${result.detail}). Retry update before starting services.\n`);
          return 1;
        }
      }
    }
  }

  // The engine = the declared compat siblings that are CURRENTLY installed. We
  // upgrade what's there; we don't pull in siblings the user deliberately omitted.
  const ranges: Record<string, string> = {};
  const current: VersionPin[] = [];
  for (const [name, range] of Object.entries(deps.compatRanges)) {
    const resolved = deps.installedVersion(name);
    if (resolved === null) continue;
    ranges[name] = range;
    current.push({ name, range, resolved });
  }
  if (current.length === 0) {
    deps.err('update: no engine packages installed — run `fortytwo init` first.\n');
    return 2;
  }

  const target = await resolveLatestInRange(ranges, deps.fetchVersions);
  const versionOf = (pins: VersionPin[], name: string): string | undefined =>
    pins.find((p) => p.name === name)?.resolved;
  const changed = target.filter((t) => versionOf(current, t.name) !== t.resolved);

  if (changed.length === 0) {
    if (!flags.dryRun) await deps.reconcile();
    deps.out(
      'update: already at the latest in-range version:\n' +
      current.map((p) => `  ${p.name}@${p.resolved} (${p.range})`).join('\n') + '\n',
    );
    return 0;
  }

  deps.out(
    'update: resolving latest-in-range →\n' +
    target.map((t) => {
      const from = versionOf(current, t.name);
      return `  ${t.name}: ${from && from !== t.resolved ? `${from} → ${t.resolved}` : `${t.resolved} (unchanged)`}`;
    }).join('\n') + '\n',
  );

  if (flags.dryRun) {
    deps.out('update: --dry-run, nothing installed.\n');
    return 0;
  }

  const res = deps.install(target.map((t) => `${t.name}@${t.resolved}`));
  if (!res.ok) {
    // Nothing recorded: the ledger still points at the pre-update set, which is
    // what's (mostly) on disk — fix the error and retry, no rollback needed.
    deps.err(`update: install failed (${res.detail}). Nothing recorded — your previous set is intact; fix the error and retry.\n`);
    return 1;
  }

  // Install landed → rotate the ledger so `previous` = the pre-update set.
  deps.record(target);

  const { results, ok } = await deps.doctor();
  printChecks(results, deps.out);
  if (!ok) {
    deps.err('\nupdate: installed, but doctor reports required checks FAILED. Inspect, then run `fortytwo rollback` to restore the previous set.\n');
    return 1;
  }

  await deps.reconcile();
  deps.out('\nupdate: healthy — engine upgraded. Start services with `fortytwo start` (or your service manager).\n');
  return 0;
}

export async function performRollback(deps: RollbackDeps): Promise<number> {
  const state = deps.readState();
  if (!state) {
    deps.err('rollback: nothing to roll back — run `fortytwo init` first.\n');
    return 2;
  }
  if (!state.previous) {
    deps.err('rollback: no prior version set recorded (only one install so far, or already rolled back).\n');
    return 2;
  }
  const target = state.previous;
  deps.out('rollback: restoring the previous set →\n' + target.map((p) => `  ${p.name}@${p.resolved}`).join('\n') + '\n');

  const res = deps.install(target.map((p) => `${p.name}@${p.resolved}`));
  if (!res.ok) {
    deps.err(`rollback: install failed (${res.detail}). The ledger is unchanged; retry once the cause is fixed.\n`);
    return 1;
  }

  deps.record(target); // rotate the bad set into `previous` (single-step ledger)
  const { results, ok } = await deps.doctor();
  printChecks(results, deps.out);
  deps.out(ok ? '\nrollback: restored and healthy.\n' : '\nrollback: restored, but doctor still reports failures — inspect manually.\n');
  return ok ? 0 : 1;
}

// --- real wiring ---

/** The Ollama URL the memory server runs with now (its .mcp.json env), else .env, else the default. */
function currentOllamaBaseUrl(root: string): string {
  const path = join(root, '.mcp.json');
  if (existsSync(path)) {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> };
    const url = cfg.mcpServers?.['fortytwo-memory']?.env?.OLLAMA_BASE_URL;
    if (typeof url === 'string' && url.trim()) return url;
  }
  return readProjectSetting('OLLAMA_BASE_URL', root) ?? DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Post-update reconciliation of machine-owned runtime assets. The memory MCP
 * entry is re-wired FIRST (with the transcript extension when installed), so
 * moving chat out of memory never leaves the agent without transcript search.
 */
export async function reconcileRuntime(root: string): Promise<MigrationResult> {
  const dbPath = readProjectSetting('DB_PATH', root) ?? DEFAULT_DB_PATH;
  writeMcpJson(root, dbPath, currentOllamaBaseUrl(root));
  await reconcileOneiros(root, dbPath);
  return migrateChatToTranscript(root, dbPath);
}

/** Published versions of a package via `npm view`; [] if unknown/unreachable. */
export function fetchPublishedVersions(pkg: string): Promise<string[]> {
  return Promise.resolve().then(() => {
    const res = spawnSync('npm', ['view', pkg, 'versions', '--json'], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return [];
    try {
      const parsed = JSON.parse(res.stdout) as string[] | string;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
}

function npmInstall(specs: string[], root: string, flags: string[] = []): InstallResult {
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...flags, ...specs], { cwd: root, stdio: 'inherit' });
  if (res.status === 0) return { ok: true, detail: 'ok' };
  return { ok: false, detail: res.error ? res.error.message : `npm exited ${res.status}` };
}

function parseUpdateArgs(argv: string[]): { dryRun?: boolean } {
  return { dryRun: argv.includes('--dry-run') || argv.includes('-n') };
}

export async function runUpdate(argv: string[]): Promise<number> {
  const root = process.cwd();
  const deps: UpdateDeps = {
    runningInstallerVersion: readSelfVersion,
    persistInstaller: (spec) => npmInstall([spec], root, ['--save-exact']),
    readState: () => readState(root),
    runtimeActive: () => {
      if (liveRuntime(root)) return true;
      const heartbeat = defaultDoctorDeps().schedulerHeartbeat();
      return !!heartbeat && Date.now() - Date.parse(heartbeat.ts) <= HEARTBEAT_STALE_MS && isPidAlive(heartbeat.pid);
    },
    installedVersion: readInstalledVersion,
    compatRanges: readSelfCompatRanges(),
    fetchVersions: fetchPublishedVersions,
    install: (specs) => npmInstall(specs, root),
    doctor: () => runDoctorChecks(defaultDoctorDeps()),
    record: (pins) => { recordVersionSet(pins, root); },
    reconcile: async () => {
      const { moved } = await reconcileRuntime(root);
      if (moved > 0) process.stdout.write(`update: moved ${moved} chat row(s) from memory to the transcript\n`);
    },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
  return performUpdate(deps, parseUpdateArgs(argv));
}

export async function runRollback(_argv: string[]): Promise<number> {
  const root = process.cwd();
  const deps: RollbackDeps = {
    readState: () => readState(root),
    install: (specs) => npmInstall(specs, root),
    doctor: () => runDoctorChecks(defaultDoctorDeps()),
    record: (pins) => { recordVersionSet(pins, root); },
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
  return performRollback(deps);
}
