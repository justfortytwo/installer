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
//      revert, so the user can inspect first). On success: re-render the persona
//      scaffold (idempotent) in case a new template version shipped.
//
// rollback re-installs state.json's `previous` set and rotates the ledger back.
// Both share the resolve/install primitives below and are unit-tested through an
// injected `*Deps` (so no test touches the network or the real npm).

import { spawnSync } from 'node:child_process';
import {
  recordVersionSet, readState, readIdentity,
  type VersionPin, type InstallState,
} from '../state.js';
import { readInstalledVersion, readSelfCompatRanges, satisfiesRange } from '../engine.js';
import { runDoctorChecks, defaultDoctorDeps, type CheckResult } from './doctor.js';
import { renderPersona } from '../render.js';

// --- pure: pick the latest published version satisfying a range ---

/** Numeric semver compare (ignores any pre-release tag); -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^[v^~]/, '').split('-')[0]!.split('.').map((n) => parseInt(n, 10) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  return (a0! - b0!) || (a1! - b1!) || (a2! - b2!);
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
  readState: () => InstallState | null;
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
  /** Re-render the persona scaffold (idempotent). */
  render: () => void;
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

  deps.render();
  deps.out('\nupdate: healthy — engine upgraded.\n');
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

function npmInstall(specs: string[], root: string): InstallResult {
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...specs], { cwd: root, stdio: 'inherit' });
  if (res.status === 0) return { ok: true, detail: 'ok' };
  return { ok: false, detail: res.error ? res.error.message : `npm exited ${res.status}` };
}

function parseUpdateArgs(argv: string[]): { dryRun?: boolean } {
  return { dryRun: argv.includes('--dry-run') || argv.includes('-n') };
}

export async function runUpdate(argv: string[]): Promise<number> {
  const root = process.cwd();
  const deps: UpdateDeps = {
    readState: () => readState(root),
    installedVersion: readInstalledVersion,
    compatRanges: readSelfCompatRanges(),
    fetchVersions: fetchPublishedVersions,
    install: (specs) => npmInstall(specs, root),
    doctor: () => runDoctorChecks(defaultDoctorDeps()),
    record: (pins) => { recordVersionSet(pins, root); },
    render: () => { const id = readIdentity(root); if (id) renderPersona(id, { root }); },
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
