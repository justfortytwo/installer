// pair — issue a one-time `/login` pairing code for a channel.
//
// Mints a short-lived code and PERSISTS it (via @justfortytwo/telegram's
// store-backed challenges) to the SAME bindings db the running bridge reads.
// The owner sends `/login <code>` from the target chat; the bridge — a separate
// process — redeems the persisted challenge and records the binding. This is the
// dynamic counterpart to the static ALLOWED_CHAT_IDS allowlist, and the
// lifecycle counterpart to `unbind`.

import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadTelegram } from '../engine.js';
import { liveRuntime, serviceRunning } from '../runtime.js';
import { readProjectSetting } from './init.js';

export interface PairFlags {
  /** Which channel to pair. Defaults to telegram (the only adapter at v0). */
  channel: string;
  /** Optional TTL override (seconds) for the code. */
  ttlSeconds?: number;
  /** Issue a code even though `fortytwo start` is not running Telegram (e.g. a hand-run bridge). */
  force?: boolean;
}

export function parsePairArgs(argv: string[]): PairFlags {
  const f: PairFlags = { channel: 'telegram' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    if (a === '--force') { f.force = true; continue; }
    const v = argv[++i] ?? '';
    if (a === '--channel') f.channel = v || 'telegram';
    else if (a === '--ttl') f.ttlSeconds = Number(v) || undefined;
  }
  return f;
}

/**
 * The bindings db the bridge uses — MUST match @justfortytwo/telegram's bridge
 * (`<root>/state/telegram-bindings.db`, overridable via TELEGRAM_BINDINGS_DB),
 * or a code minted here would land in a db the bridge never reads.
 */
export function resolveBindingsDbPath(root: string): string {
  // Shell env, else the project's .env — the same value `fortytwo start` passes the bridge.
  const custom = readProjectSetting('TELEGRAM_BINDINGS_DB', root);
  return custom ? resolve(root, custom) : resolve(root, 'state', 'telegram-bindings.db');
}

/**
 * Why a code minted now could not be redeemed, or null if Telegram is running
 * under `fortytwo start`. A code is only useful while the bridge is up to read
 * `/login <code>`, so pair refuses to print one otherwise.
 */
export function telegramUnavailableMessage(root: string, nowMs: number = Date.now()): string | null {
  const runtime = liveRuntime(root, nowMs);
  if (serviceRunning(runtime, 'telegram')) return null;
  const skipped = runtime?.skipped.find((s) => s.name === 'telegram');
  return [
    skipped ? `Telegram is not running (${skipped.reason}).` : 'Telegram is not running.',
    ...(skipped ? ['Fix that in .env, then restart Fortytwo:'] : ['Start Fortytwo with:']),
    '  fortytwo start',
    '',
    'Then run:',
    '  fortytwo pair',
    '',
    '(Running the bridge yourself? `fortytwo pair --force` issues a code anyway.)',
  ].join('\n');
}

type TgModule = {
  SqliteBindingStore: new (dbPath?: string) => unknown;
  TelegramAdapter: new (store: unknown, opts?: { ttlSeconds?: number }) => {
    issueChallenge: (owner: string) => { code: string; ttl: number };
  };
};

export async function runPair(argv: string[]): Promise<number> {
  const flags = parsePairArgs(argv);
  if (flags.channel !== 'telegram') {
    process.stderr.write(`pair: unsupported channel "${flags.channel}" (only telegram at v0).\n`);
    return 2;
  }
  if (!flags.force) {
    const why = telegramUnavailableMessage(process.cwd());
    if (why) {
      process.stderr.write(why + '\n');
      return 1;
    }
  }
  const tg = (await loadTelegram()) as unknown as TgModule | null;
  if (!tg || typeof tg.SqliteBindingStore !== 'function' || typeof tg.TelegramAdapter !== 'function') {
    process.stderr.write('pair: @justfortytwo/telegram (>=0.1.1, with persisted challenges) is not installed.\n');
    return 2;
  }
  const dbPath = resolveBindingsDbPath(process.cwd());
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new tg.SqliteBindingStore(dbPath);
  const adapter = new tg.TelegramAdapter(store, flags.ttlSeconds ? { ttlSeconds: flags.ttlSeconds } : {});
  const { code, ttl } = adapter.issueChallenge('owner');

  process.stdout.write(`Pairing code: ${code}\n`);
  process.stdout.write(`From your Telegram chat, send:  /login ${code}\n`);
  process.stdout.write(`(valid ${Math.round(ttl / 60)} min — the running bridge binds that chat to you)\n`);
  return 0;
}
