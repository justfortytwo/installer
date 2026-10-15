import { readProcessIdentity } from '../src/process-identity.js';
// `fortytwo start` supervisor: real child processes from fixture service
// packages in a tmp project, signals injected through an EventEmitter.
//
// Fixture bins are tiny CommonJS scripts that print the env they received and
// then idle until SIGTERM — or misbehave (exit at once, ignore SIGTERM) — so the
// tests observe real spawn/stdio/signal behavior without Telegram or Claude.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServiceEnv, planServices, supervise, liveRuntime, readRuntimeState, runtimeStatePath,
  isPidAlive, sameRuntimeProcess, serviceRunning, RUNTIME_STALE_MS, type RuntimeState,
} from '../src/runtime.js';
import { telegramUnavailableMessage } from '../src/commands/pair.js';
import { statusLines } from '../src/commands/status.js';
import { nextSteps } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStatus } from '../src/commands/status.js';
import { runStop } from '../src/commands/stop.js';

// Idles until SIGTERM; reports the env it got as one JSON line.
const IDLE = (name: string) => `
console.log(JSON.stringify({ svc: ${JSON.stringify(name)}, token: process.env.TELEGRAM_BOT_TOKEN ?? null,
  root: process.env.FORTYTWO_ROOT ?? null, allowed: process.env.ALLOWED_CHAT_IDS ?? null,
  fromFile: process.env.FROM_FILE ?? null, cwd: process.cwd() }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;
const CRASH = `console.error('boom: cannot start'); process.exit(3);`;
const STUBBORN = `console.log('ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;

function fixturePkg(root: string, pkg: string, bin: string, body: string): void {
  const dir = join(root, 'node_modules', ...pkg.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '9.9.9', bin: { [bin]: 'svc.js' } }));
  writeFileSync(join(dir, 'svc.js'), body);
}

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft-runtime-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function harness(services: { name: string; body: string }[], env: NodeJS.ProcessEnv, graceMs = 2000) {
  const bins: Record<string, [string, string]> = {
    telegram: ['@justfortytwo/telegram', 'fortytwo-telegram-bridge'],
    scheduler: ['@justfortytwo/scheduler', 'fortytwo-scheduler'],
  };
  for (const s of services) fixturePkg(root, bins[s.name]![0], bins[s.name]![1], s.body);
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const { run, skipped } = planServices(root, env);
  const done = supervise(run, {
    root, env, skipped, signals, graceMs, heartbeatMs: 100,
    out: (l) => out.push(l), err: (l) => err.push(l),
  });
  const reported = (svc: string) => out.map((l) => l.match(new RegExp(`^\\[${svc}\\] (\\{.*\\})$`))?.[1]).find(Boolean);
  return { out, err, signals, done, run, skipped, reported };
}

describe('buildServiceEnv: process env > .env > defaults', () => {
  it('merges .env under the process env and defaults FORTYTWO_ROOT to the project', () => {
    const env = buildServiceEnv({ A: 'shell' }, { A: 'file', B: 'file' }, '/proj');
    expect(env).toMatchObject({ A: 'shell', B: 'file', FORTYTWO_ROOT: '/proj' });
    expect(buildServiceEnv({ FORTYTWO_ROOT: '/elsewhere' }, {}, '/proj').FORTYTWO_ROOT).toBe('/elsewhere');
    expect(buildServiceEnv({}, { FORTYTWO_ROOT: '/from-file' }, '/proj').FORTYTWO_ROOT).toBe('/from-file');
  });
  it('never invents ALLOWED_CHAT_IDS (unbound chats stay locked out until /login)', () => {
    expect(buildServiceEnv({}, { TELEGRAM_BOT_TOKEN: 't' }, '/proj').ALLOWED_CHAT_IDS).toBeUndefined();
  });
});

describe('planServices', () => {
  it('runs installed + configured services; skips the rest with a reason', () => {
    fixturePkg(root, '@justfortytwo/telegram', 'fortytwo-telegram-bridge', IDLE('telegram'));
    expect(planServices(root, {}).skipped).toEqual([
      { name: 'telegram', reason: 'TELEGRAM_BOT_TOKEN not set' },
      { name: 'scheduler', reason: '@justfortytwo/scheduler not installed' },
    ]);
    expect(planServices(root, { TELEGRAM_BOT_TOKEN: 't' }).run.map((s) => s.name)).toEqual(['telegram']);
  });
});

describe('supervise (fortytwo start)', () => {
  it('starts every configured service with the merged env, records them, and SIGTERM stops them all', async () => {
    const h = harness(
      [{ name: 'telegram', body: IDLE('telegram') }, { name: 'scheduler', body: IDLE('scheduler') }],
      buildServiceEnv({ ALLOWED_CHAT_IDS: undefined }, { TELEGRAM_BOT_TOKEN: 'from-dotenv', FROM_FILE: 'yes' }, root),
    );
    await until(() => !!h.reported('telegram') && !!h.reported('scheduler'));
    const tg = JSON.parse(h.reported('telegram')!);
    expect(tg).toMatchObject({ token: 'from-dotenv', fromFile: 'yes', root, allowed: null });
    expect(tg.cwd).toContain('ft-runtime-'); // spawned in the project

    const state = readRuntimeState(root)!;
    expect(state.pid).toBe(process.pid);
    expect(state.services.map((s) => [s.name, s.state])).toEqual([['telegram', 'running'], ['scheduler', 'running']]);
    const pids = state.services.map((s) => s.pid!);
    expect(pids.every(isPidAlive)).toBe(true);

    h.signals.emit('SIGTERM');
    expect(await h.done).toBe(0);
    expect(pids.some(isPidAlive)).toBe(false);          // no orphans
    expect(existsSync(runtimeStatePath(root))).toBe(false); // ownership released
    expect(h.out).toContain('[fortytwo] SIGTERM received: stopping services…');
  });

  it('SIGINT (Ctrl+C) also shuts children down cleanly', async () => {
    const h = harness([{ name: 'scheduler', body: IDLE('scheduler') }], buildServiceEnv({}, {}, root));
    await until(() => !!h.reported('scheduler'));
    const pid = readRuntimeState(root)!.services[0]!.pid!;
    h.signals.emit('SIGINT');
    expect(await h.done).toBe(0);
    expect(isPidAlive(pid)).toBe(false);
  });

  it('surfaces a service that fails at startup: non-zero exit, the others stopped', async () => {
    const h = harness(
      [{ name: 'telegram', body: CRASH }, { name: 'scheduler', body: IDLE('scheduler') }],
      buildServiceEnv({}, { TELEGRAM_BOT_TOKEN: 't' }, root),
    );
    expect(await h.done).toBe(3);
    expect(h.err).toContain('[telegram] boom: cannot start');
    expect(h.err.some((l) => /telegram exited unexpectedly \(code 3\); stopping fortytwo/.test(l))).toBe(true);
    expect(h.out).toContain('[fortytwo] scheduler stopped');
  });

  it('SIGKILLs a service that ignores SIGTERM after the grace period (no orphan)', async () => {
    const h = harness([{ name: 'scheduler', body: STUBBORN }], buildServiceEnv({}, {}, root), 300);
    await until(() => h.out.includes('[scheduler] ready'));
    const pid = readRuntimeState(root)!.services[0]!.pid!;
    h.signals.emit('SIGTERM');
    expect(await h.done).toBe(0);
    expect(isPidAlive(pid)).toBe(false);
  });
});

describe('runtime ownership (status / stop / pair read it)', () => {
  const state = (over: Partial<RuntimeState> = {}): RuntimeState => ({
    pid: process.pid, processIdentity: readProcessIdentity(process.pid)!, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    services: [{ name: 'telegram', pid: 1, state: 'running' }], skipped: [], ...over,
  });
  const write = (s: RuntimeState) => {
    mkdirSync(join(root, '.fortytwo'), { recursive: true });
    writeFileSync(runtimeStatePath(root), JSON.stringify(s));
  };

  it('is live only with a fresh heartbeat AND a living pid', () => {
    expect(liveRuntime(root)).toBeNull();
    write(state());
    expect(liveRuntime(root)?.pid).toBe(process.pid);
    expect(liveRuntime(root, Date.now() + RUNTIME_STALE_MS + 1000)).toBeNull(); // stale file: never trusted
    expect(liveRuntime(root, Date.now(), () => false)).toBeNull();           // dead pid
  });

  it('does not trust legacy records or an unreadable process identity', () => {
    const legacy = state(); delete legacy.processIdentity;
    write(legacy);
    expect(liveRuntime(root)).toBeNull();
    expect(sameRuntimeProcess(state(), () => true, () => null)).toBe(false);
  });

  it('keeps ownership scoped to the project and rejects invalid signal targets', () => {
    write(state());
    expect(liveRuntime(join(root, 'another-project'))).toBeNull();
    for (const pid of [0, -1, 1.5, NaN]) {
      write(state({ pid }));
      expect(liveRuntime(root)).toBeNull();
    }
  });

  it('rejects a reused live PID immediately despite a fresh heartbeat', () => {
    write({ ...state(), processIdentity: 'previous-process-generation' } as RuntimeState);
    expect(isPidAlive(process.pid)).toBe(true);
    expect(liveRuntime(root)).toBeNull();
  });

  it('start replaces a previous generation immediately and status rejects it', async () => {
    write({ ...state(), processIdentity: 'previous-container-generation' } as RuntimeState);
    fixturePkg(root, '@justfortytwo/scheduler', 'fortytwo-scheduler', CRASH);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runStatus([])).toBe(3);
      expect(await runStart([])).toBe(3); // service actually started and exited
    } finally { process.chdir(cwd); }
  });

  it('refuses a second start against the actual same supervisor', async () => {
    const h = harness([{ name: 'scheduler', body: IDLE('scheduler') }], buildServiceEnv({}, {}, root));
    const cwd = process.cwd();
    try {
      await until(() => !!h.reported('scheduler'));
      process.chdir(root);
      expect(liveRuntime(root)?.pid).toBe(process.pid);
      expect(await runStart([])).toBe(1);
    } finally {
      process.chdir(cwd);
      h.signals.emit('SIGTERM');
      await h.done;
    }
  });

  it('pair: warns and gives no code when Telegram is not running; null when it is', () => {
    expect(telegramUnavailableMessage(root)).toMatch(/^Telegram is not running\.\nStart Fortytwo with:\n  fortytwo start\n\nThen run:\n  fortytwo pair/);
    write(state({ services: [], skipped: [{ name: 'telegram', reason: 'TELEGRAM_BOT_TOKEN not set' }] }));
    expect(telegramUnavailableMessage(root)).toMatch(/^Telegram is not running \(TELEGRAM_BOT_TOKEN not set\)\./);
    write(state());
    expect(serviceRunning(liveRuntime(root), 'telegram')).toBe(true);
    expect(telegramUnavailableMessage(root)).toBeNull();
  });

  it('status lines', () => {
    const now = Date.now();
    expect(statusLines({ runtime: null, schedulerHeartbeat: null, memoryConfigured: true, nowMs: now })).toEqual([
      'Fortytwo   not running (start it with `fortytwo start`)',
      'Telegram   not running',
      'Scheduler  not running',
      'Memory     configured via MCP (Claude Code starts it on demand)',
    ]);
    const lines = statusLines({
      runtime: state(), schedulerHeartbeat: { pid: 2, ts: new Date(now - 4000).toISOString() }, memoryConfigured: false, nowMs: now,
    });
    expect(lines[1]).toBe('Telegram   running');
    expect(lines[2]).toBe('Scheduler  running (heartbeat 4s ago)');
  });
});

describe('fortytwo stop', () => {
  const quiet = async <T>(fn: () => Promise<T>) => {
    const o = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: () => boolean }).write = () => true;
    try { return await fn(); } finally { (process.stdout as unknown as { write: typeof o }).write = o; }
  };
  const record = (pid: number, heartbeatAt: string) => {
    mkdirSync(join(root, '.fortytwo'), { recursive: true });
    writeFileSync(runtimeStatePath(root), JSON.stringify({ pid, processIdentity: readProcessIdentity(pid), startedAt: heartbeatAt, heartbeatAt, services: [], skipped: [] }));
  };

  it('signals only the recorded supervisor while its heartbeat is fresh, and waits for it to exit', async () => {
    const sup = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"]);
    await until(() => sup.pid !== undefined && isPidAlive(sup.pid));
    expect(readProcessIdentity(sup.pid!)).toBeTruthy();
    expect(readProcessIdentity(sup.pid!)).toBe(readProcessIdentity(sup.pid!));
    record(sup.pid!, new Date().toISOString());
    const cwd0 = process.cwd();
    process.chdir(root);
    try {
      expect(await quiet(() => runStop([]))).toBe(0);
    } finally {
      process.chdir(cwd0);
    }
    expect(isPidAlive(sup.pid!)).toBe(false);
  });

  it('never signals an unrelated live child with a fresh mismatched identity', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const cwd = process.cwd();
    const kill = vi.spyOn(process, 'kill');
    try {
      await until(() => child.pid !== undefined && isPidAlive(child.pid));
      record(child.pid!, new Date().toISOString());
      const stale = { ...readRuntimeState(root)!, processIdentity: 'old-start-identity' };
      writeFileSync(runtimeStatePath(root), JSON.stringify(stale));
      process.chdir(root);
      expect(await quiet(() => runStop([], { timeoutMs: 1 }))).toBe(0);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toEqual([]);
      expect(isPidAlive(child.pid!)).toBe(true);
    } finally {
      kill.mockRestore();
      process.chdir(cwd);
      child.kill('SIGKILL');
    }
  });

  it('never signals a pid from a stale runtime file (it may have been reused)', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await until(() => bystander.pid !== undefined && isPidAlive(bystander.pid));
    record(bystander.pid!, new Date(Date.now() - RUNTIME_STALE_MS - 5000).toISOString());
    const cwd0 = process.cwd();
    process.chdir(root);
    try {
      expect(await quiet(() => runStop([]))).toBe(0); // "not running"
      expect(isPidAlive(bystander.pid!)).toBe(true);
    } finally {
      process.chdir(cwd0);
      bystander.kill('SIGKILL');
    }
  });
});

describe('init next steps', () => {
  it('points to fortytwo start + fortytwo pair, never to the internal service bins', () => {
    const text = nextSteps({ hasBotToken: true }).join('\n');
    expect(text).toContain('Fortytwo is ready.\n\nStart it with:\n  fortytwo start\n\nThen connect Telegram with:\n  fortytwo pair');
    for (const o of [{ hasBotToken: false }, { hasBotToken: true, allowedChatIds: '42' }]) {
      expect(nextSteps(o).join('\n')).not.toMatch(/fortytwo-telegram-bridge|fortytwo-scheduler/);
    }
    expect(nextSteps({ hasBotToken: false }).join('\n')).toContain('set TELEGRAM_BOT_TOKEN in .env');
  });
});
