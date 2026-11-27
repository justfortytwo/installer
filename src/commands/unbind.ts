// unbind: revoke a channel binding (the inverse of `pair`).
//
// A Telegram chat can be authorized two ways: a binding in the bridge's
// bindings db (written when the chat redeems a `fortytwo pair` code) or the
// static ALLOWED_CHAT_IDS in .env. unbind removes matching bindings from the
// bindings db, which the bridge reads on every message, so access ends without
// a restart. It also prunes identity.json's `channels` and reminds the owner to
// drop the ids from ALLOWED_CHAT_IDS, which it does not edit.

import { existsSync } from 'node:fs';
import { loadTelegram } from '../engine.js';
import { readIdentity, writeIdentity, type ChannelBinding } from '../state.js';
import { readProjectSetting } from './init.js';
import { resolveBindingsDbPath } from './pair.js';

interface UnbindFlags {
  channel?: string;
  chatId?: string;
  all?: boolean;
}

/**
 * Pure prune: drop bindings matching the selector. With `all`, drop every
 * binding for the (optional) channel; otherwise drop bindings whose
 * allowedChatIds include `chatId`. Bindings for other channels are untouched.
 */
export function pruneChannels(
  channels: ChannelBinding[],
  sel: { channel?: string; chatId?: string; all?: boolean },
): { kept: ChannelBinding[]; removed: ChannelBinding[] } {
  const removed: ChannelBinding[] = [];
  const kept = channels.filter((c) => {
    if (sel.channel && c.channel !== sel.channel) return true;
    const match = sel.all === true || (sel.chatId != null && (c.allowedChatIds ?? []).includes(sel.chatId));
    if (match) { removed.push(c); return false; }
    return true;
  });
  return { kept, removed };
}

/** The part of telegram's BindingStore that unbind needs. */
export interface PairedChatStore {
  list(channelType?: string): Array<{ channelUserId: string }>;
  remove(channelType: string, channelUserId: string): void;
  /** Drops challenges with expiresAt <= now; a far-future `now` drops them all. */
  sweepChallenges?(now: number): void;
}

/**
 * Remove paired Telegram chats from the bindings store: every one with `all`,
 * otherwise the one whose id is `chatId`. Returns the removed chat ids.
 */
export function revokePairedChats(store: PairedChatStore, sel: { chatId?: string; all?: boolean }): string[] {
  const ids = store.list('telegram').map((b) => b.channelUserId)
    .filter((id) => sel.all === true || (sel.chatId != null && id === sel.chatId));
  for (const id of ids) store.remove('telegram', id);
  // Any chat can redeem a pending pairing code, so `--all` also voids codes
  // minted by `fortytwo pair` that have not expired yet.
  if (sel.all === true) store.sweepChallenges?.(Number.MAX_SAFE_INTEGER);
  return ids;
}

type TgStoreModule = { SqliteBindingStore?: new (dbPath: string) => PairedChatStore };

/**
 * Open the bridge's bindings db and revoke matching chats. Never creates the db:
 * no file means nothing was ever paired. Returns null when the db exists but
 * @justfortytwo/telegram is not installed to read it.
 */
async function revokeInBindingsDb(
  root: string,
  sel: { chatId?: string; all?: boolean },
): Promise<{ ids: string[]; codesCleared: boolean } | null> {
  const dbPath = resolveBindingsDbPath(root);
  if (!existsSync(dbPath)) return { ids: [], codesCleared: false };
  const tg = (await loadTelegram()) as unknown as TgStoreModule | null;
  if (!tg || typeof tg.SqliteBindingStore !== 'function') return null;
  const store = new tg.SqliteBindingStore(dbPath);
  const ids = revokePairedChats(store, sel);
  return { ids, codesCleared: sel.all === true && typeof store.sweepChallenges === 'function' };
}

/** Ids in ALLOWED_CHAT_IDS (shell env, else the project's .env), comma-separated. */
function allowedChatIds(root: string): string[] {
  return (readProjectSetting('ALLOWED_CHAT_IDS', root) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function parseUnbindArgs(argv: string[]): UnbindFlags {
  const flags: UnbindFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--all') flags.all = true;
    else if (a === '--channel') flags.channel = argv[++i];
    else if (a === '--chat-id') flags.chatId = argv[++i];
  }
  return flags;
}

export async function runUnbind(argv: string[]): Promise<number> {
  const root = process.cwd();
  const flags = parseUnbindArgs(argv);
  const identity = readIdentity(root);
  if (!identity) {
    process.stderr.write('unbind: no .fortytwo/identity.json — run `fortytwo init` first.\n');
    return 2;
  }
  if (!flags.all && !flags.chatId) {
    process.stderr.write('unbind: specify --chat-id <id> or --all (optionally --channel <name>).\n');
    return 2;
  }
  const { kept, removed } = pruneChannels(identity.channels ?? [], flags);
  if (removed.length) writeIdentity({ ...identity, channels: kept }, root);

  const telegramSelected = !flags.channel || flags.channel === 'telegram';
  const outcome = telegramSelected ? await revokeInBindingsDb(root, flags) : { ids: [], codesCleared: false };
  const revoked = outcome?.ids ?? null;
  const codesCleared = outcome?.codesCleared === true;
  if (revoked === null) {
    process.stderr.write('unbind: the Telegram bindings db exists but @justfortytwo/telegram is not installed, so paired chats were not revoked.\n');
  }

  // ALLOWED_CHAT_IDS authorizes on its own (the bridge checks it first), so
  // name every selected id it still lists, even when nothing else changed.
  const unbound = new Set([...removed.flatMap((c) => c.allowedChatIds ?? []), ...(revoked ?? [])]);
  if (flags.chatId) unbound.add(flags.chatId);
  const stillAllowed = (telegramSelected ? allowedChatIds(root) : [])
    .filter((id) => flags.all === true || unbound.has(id));
  const refused = (revoked ?? []).filter((id) => !stillAllowed.includes(id));

  if (removed.length === 0 && !revoked?.length && stillAllowed.length === 0 && !codesCleared) {
    process.stdout.write('unbind: no matching binding found; nothing changed.\n');
    return revoked === null ? 1 : 0;
  }
  if (removed.length) process.stdout.write(`✓ removed ${removed.length} binding(s) from identity.json\n`);
  if (refused.length) {
    process.stdout.write(`✓ revoked paired chat(s) ${refused.join(', ')}; the bridge refuses them from the next message\n`);
  }
  const keptByAllowlist = (revoked ?? []).filter((id) => stillAllowed.includes(id));
  if (keptByAllowlist.length) {
    process.stdout.write(`✓ removed the pairing for ${keptByAllowlist.join(', ')}\n`);
  }
  if (codesCleared) process.stdout.write('✓ cancelled any unused pairing codes\n');
  if (stillAllowed.length) {
    process.stdout.write(`  ${stillAllowed.join(', ')} ${stillAllowed.length === 1 ? 'is' : 'are'} still in ALLOWED_CHAT_IDS and keep${stillAllowed.length === 1 ? 's' : ''} access: remove ${stillAllowed.length === 1 ? 'it' : 'them'} from .env and restart fortytwo.\n`);
  }
  if (revoked === null) return 1;
  return 0;
}
