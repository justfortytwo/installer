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

export interface PairFlags {
  /** Which channel to pair. Defaults to telegram (the only adapter at v0). */
  channel: string;
  /** Optional TTL override (seconds) for the code. */
  ttlSeconds?: number;
}

export function parsePairArgs(argv: string[]): PairFlags {
  const f: PairFlags = { channel: 'telegram' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
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
  return process.env.TELEGRAM_BINDINGS_DB
    ? resolve(root, process.env.TELEGRAM_BINDINGS_DB)
    : resolve(root, 'state', 'telegram-bindings.db');
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
