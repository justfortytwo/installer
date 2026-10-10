// runtime.ts — foreground supervisor for fortytwo's long-running services.
//
// `fortytwo start` runs the installed + configured services (the Telegram bridge,
// the scheduler daemon) as CHILD processes of one foreground process: it loads
// the project .env, spawns each service's own bin from the project's
// node_modules, prefixes and forwards their logs, and on SIGINT/SIGTERM — or as
// soon as any service exits — stops the rest and exits. It never daemonizes and
// never restarts a service: restart policy belongs to whatever runs
// `fortytwo start` (Docker/Podman, systemd, another supervisor). This is process
// lifecycle only; each service's logic stays in its own package.
//
// `.fortytwo/runtime.json` records the running supervisor (its pid, a heartbeat
// refreshed every few seconds, and its children). `status`, `stop` and `pair`
// read it, and it is removed on exit. A stale heartbeat means "not running", so a
// file left behind by a killed supervisor can never make `stop` signal a pid that
// has since been reused.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findSiblingDir } from './engine.js';

/** A long-running service `fortytwo start` can supervise. */
export interface ServiceSpec {
  name: string;
  /** npm package that ships the service. */
  pkg: string;
  /** Its bin name (the low-level command, e.g. for debugging). */
  bin: string;
  /** Env vars without which the service refuses to start; it is skipped instead. */
  requiredEnv: string[];
}

export const SERVICES: ServiceSpec[] = [
  { name: 'telegram', pkg: '@justfortytwo/telegram', bin: 'fortytwo-telegram-bridge', requiredEnv: ['TELEGRAM_BOT_TOKEN'] },
  { name: 'scheduler', pkg: '@justfortytwo/scheduler', bin: 'fortytwo-scheduler', requiredEnv: [] },
];

export interface PlannedService { name: string; script: string }
export interface SkippedService { name: string; reason: string }

/**
 * The environment the services run with. Precedence: the supervisor's own
 * process env (shell, container, systemd) > the project's .env > defaults.
 * FORTYTWO_ROOT defaults to the project root: the bridge resolves its bindings
 * db and config from it, and would otherwise fall back to its own package dir.
 */
export function buildServiceEnv(
  processEnv: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
  root: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...fileEnv };
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) env[k] = v;
  env.FORTYTWO_ROOT ??= resolve(root);
  return env;
}

/** Which services to run: installed in the project AND configured; the rest are skipped with a reason. */
export function planServices(
  root: string,
  env: NodeJS.ProcessEnv,
  specs: ServiceSpec[] = SERVICES,
): { run: PlannedService[]; skipped: SkippedService[] } {
  const run: PlannedService[] = [];
  const skipped: SkippedService[] = [];
  for (const spec of specs) {
    const dir = findSiblingDir(spec.pkg, root);
    if (!dir) { skipped.push({ name: spec.name, reason: `${spec.pkg} not installed` }); continue; }
    let bin: unknown;
    try {
      bin = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: unknown }).bin;
    } catch {
      bin = undefined;
    }
    const rel = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | undefined)?.[spec.bin];
    if (typeof rel !== 'string' || !rel) {
      skipped.push({ name: spec.name, reason: `${spec.pkg} has no ${spec.bin} bin` });
      continue;
    }
    const missing = spec.requiredEnv.filter((k) => !env[k]);
    if (missing.length > 0) { skipped.push({ name: spec.name, reason: `${missing.join(', ')} not set` }); continue; }
    run.push({ name: spec.name, script: join(dir, rel) });
  }
  return { run, skipped };
}

// --- runtime state (.fortytwo/runtime.json) ---

export interface RuntimeState {
  /** The `fortytwo start` supervisor process. */
  pid: number;
  startedAt: string;
  /** Refreshed every few seconds while the supervisor is alive. */
  heartbeatAt: string;
  services: { name: string; pid: number | null; state: 'running' | 'exited' }[];
  skipped: SkippedService[];
}

/** A heartbeat older than this means the supervisor is gone (killed without cleanup). */
export const RUNTIME_STALE_MS = 30_000;

export function runtimeStatePath(root: string): string {
  return join(resolve(root), '.fortytwo', 'runtime.json');
}

export function readRuntimeState(root: string): RuntimeState | null {
  try {
    return JSON.parse(readFileSync(runtimeStatePath(root), 'utf8')) as RuntimeState;
  } catch {
    return null;
  }
}

function writeRuntimeState(root: string, state: RuntimeState): void {
  const path = runtimeStatePath(root);
  mkdirSync(join(resolve(root), '.fortytwo'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

/** The running supervisor's state, or null if none: no file, stale heartbeat, or dead pid. */
export function liveRuntime(
  root: string,
  nowMs: number = Date.now(),
  alive: (pid: number) => boolean = isPidAlive,
): RuntimeState | null {
  const s = readRuntimeState(root);
  if (!s || typeof s.pid !== 'number') return null;
  const beat = new Date(s.heartbeatAt).getTime();
  if (!Number.isFinite(beat) || nowMs - beat > RUNTIME_STALE_MS) return null;
  return alive(s.pid) ? s : null;
}

/** True when a live `fortytwo start` is currently running the named service. */
export function serviceRunning(state: RuntimeState | null, name: string): boolean {
  return !!state?.services.some((s) => s.name === name && s.state === 'running');
}

// --- supervisor ---

export interface SuperviseOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  skipped?: SkippedService[];
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Where SIGINT/SIGTERM arrive (default: this process). Injected by tests. */
  signals?: EventEmitter;
  /** How long services get to exit after SIGTERM before SIGKILL. */
  graceMs?: number;
  /** runtime.json heartbeat interval. */
  heartbeatMs?: number;
}

/**
 * Run `services` as foreground children until a signal arrives or one of them
 * exits; then stop the others (SIGTERM, then SIGKILL after graceMs) and resolve
 * with the exit code: 0 for a requested stop, non-zero when a service failed.
 * Children are never detached, so none outlive the supervisor's shutdown.
 */
export function supervise(services: PlannedService[], opts: SuperviseOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => { process.stdout.write(l + '\n'); });
  const err = opts.err ?? ((l: string) => { process.stderr.write(l + '\n'); });
  const signals = opts.signals ?? process;
  const graceMs = opts.graceMs ?? 10_000;
  const startedAt = new Date().toISOString();

  return new Promise<number>((resolveExit) => {
    const children = new Map<string, ChildProcess>();
    const exited = new Set<string>();
    let stopping = false;
    let exitCode = 0;
    let killTimer: NodeJS.Timeout | undefined;

    const state = (): RuntimeState => ({
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      services: services.map((s) => ({
        name: s.name,
        pid: children.get(s.name)?.pid ?? null,
        state: exited.has(s.name) ? 'exited' : 'running',
      })),
      skipped: opts.skipped ?? [],
    });
    const beat = () => { try { writeRuntimeState(opts.root, state()); } catch { /* best-effort */ } };

    const killAll = (sig: NodeJS.Signals) => {
      for (const [name, child] of children) if (!exited.has(name)) child.kill(sig);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killAll('SIGTERM');
      killTimer = setTimeout(() => killAll('SIGKILL'), graceMs);
    };
    const onSignal = (sig: NodeJS.Signals) => {
      if (stopping) { err(`[fortytwo] ${sig} again: killing services now`); killAll('SIGKILL'); return; }
      out(`[fortytwo] ${sig} received: stopping services…`);
      stop();
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    signals.on('SIGINT', onSigint);
    signals.on('SIGTERM', onSigterm);
    const heartbeat = setInterval(beat, opts.heartbeatMs ?? 5_000);

    const finish = () => {
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
      try { rmSync(runtimeStatePath(opts.root), { force: true }); } catch { /* best-effort */ }
      resolveExit(exitCode);
    };
    const onExit = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
      if (exited.has(name)) return;
      exited.add(name);
      if (!stopping) {
        err(`[fortytwo] ${name} exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`}); stopping fortytwo`);
        exitCode = code && code !== 0 ? code : 1;
        stop();
      } else {
        out(`[fortytwo] ${name} stopped`);
      }
      beat();
      if (exited.size === services.length) finish();
    };

    for (const svc of services) {
      const child = spawn(process.execPath, [svc.script], {
        cwd: opts.root,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.set(svc.name, child);
      createInterface({ input: child.stdout! }).on('line', (l) => out(`[${svc.name}] ${l}`));
      createInterface({ input: child.stderr! }).on('line', (l) => err(`[${svc.name}] ${l}`));
      child.on('error', (e) => {
        err(`[fortytwo] ${svc.name} failed to start: ${e.message}`);
        onExit(svc.name, 1, null);
      });
      child.on('exit', (code, signal) => onExit(svc.name, code, signal));
    }
    beat();
  });
}
