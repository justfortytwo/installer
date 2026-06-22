// pair — issue a one-time `/login` pairing code for a channel.
//
// Unlike init (which also provisions), pair is the standalone "bind another
// device/chat" verb. It mints a short-lived code; the owner sends `/login <code>`
// from the target chat, and the channel adapter confirms the binding (adding the
// chat to the allowlist and recording it in identity.json's `channels`).
//
// This is the lifecycle counterpart to `unbind`.

import type { Identity } from '../state.js';
import { readIdentity, writeIdentity } from '../state.js';

interface PairFlags {
  /** Which channel to pair. Defaults to telegram (the only adapter at v0). */
  channel?: 'telegram' | string;
  /** Optional TTL override for the code. */
  ttlSeconds?: number;
}

export async function runPair(_argv: string[]): Promise<number> {
  // TODO(impl):
  //   1. const identity = readIdentity() — require init has run; else instruct
  //      the user to run `create-fortytwo` first.
  //   2. const code = await issueChallenge(channel, { ttlSeconds })  // TODO(wire)
  //   3. print the code + the exact `/login <code>` instruction for that channel.
  //   4. the BINDING itself is confirmed asynchronously when the owner redeems
  //      the code in-channel; the adapter persists it, and a later doctor/enrich
  //      reconciles identity.json's `channels`. (Optionally poll for confirmation.)
  void readIdentity; void writeIdentity; void resolveChannel;
  throw new Error('TODO(wire): runPair — issueChallenge via @justfortytwo/<channel> adapter');
}

function resolveChannel(_flags: PairFlags, _identity: Identity | null): string {
  // TODO(impl): default to 'telegram'; validate the adapter is installed.
  return 'telegram';
}
