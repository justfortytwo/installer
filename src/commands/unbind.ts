// unbind — revoke a channel binding (the inverse of `pair`).
//
// Drops a paired chat from the allowlist so the assistant stops talking to it,
// and removes the binding from identity.json's `channels`. Use when a device is
// lost, a chat is decommissioned, or you want to re-pair fresh.

import { readIdentity, writeIdentity } from '../state.js';

interface UnbindFlags {
  channel?: 'telegram' | string;
  /** Which binding to drop, e.g. a specific chatId; default could prompt/select. */
  chatId?: string;
  /** Drop every binding for the channel. */
  all?: boolean;
}

export async function runUnbind(_argv: string[]): Promise<number> {
  // TODO(impl):
  //   const identity = readIdentity()  // require init has run
  //   resolve which binding(s) to revoke from flags (--chat-id / --all);
  //     confirm before removing.
  //   TODO(wire): call @justfortytwo/<channel> to revoke the binding server-side
  //     (remove from ALLOWED_CHAT_IDS / invalidate any pending challenge).
  //   prune identity.channels accordingly; writeIdentity(identity).
  //   report what was unbound.
  void readIdentity; void writeIdentity;
  void (null as unknown as UnbindFlags);
  throw new Error('TODO(wire): runUnbind — revoke channel binding via adapter + prune identity.json');
}
