// state.ts — persistence for the two gitignored files under `.fortytwo/`.
//
// `.fortytwo/identity.json`  — captured answers from `init` (agent name, owner
//   details, channel bindings). This is the SOURCE OF TRUTH the persona
//   renderer (render.ts) reads to materialize `context/*`. It is gitignored: it
//   holds personal data and must never be versioned. Re-running `init` or
//   `enrich` mutates it; `render` only READS it.
//
// `.fortytwo/state.json`     — the installed version set (the resolved sibling
//   package versions at the last successful `update`/`init`). This is the
//   rollback ledger: before each update we snapshot the current set into
//   `previous` so `rollback` can restore it. Distribution policy is
//   "semver ranges, latest-compatible" — there is NO curated bill-of-materials,
//   so the only record of "what worked" is what we capture HERE at install time.
//
// Both files live under the project root's `.fortytwo/` dir. Neither is created
// until `init` runs. Reads of a missing file return `null` (callers decide if
// that's fatal) rather than throwing — except where a command explicitly
// requires prior init (e.g. rollback needs state.json).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FORTYTWO_DIR = '.fortytwo';
export const IDENTITY_FILE = 'identity.json';
export const STATE_FILE = 'state.json';

/** Owner details captured at init; rendered into context/OWNER.md by render.ts. */
export interface OwnerIdentity {
  name: string;
  // TODO(design): timezone, locale, pronouns, preferred-address — whatever the
  // persona package's manifest.json declares as required template variables.
  timezone?: string;
  locale?: string;
  [key: string]: unknown;
}

/** Channel binding captured at init/pair (e.g. the Telegram chat allowlist). */
export interface ChannelBinding {
  // TODO(wire): shape mirrors @justfortytwo/babelfish's binding record. The
  // pairing flow (issueChallenge -> /login) writes the confirmed chatId here.
  channel: 'telegram' | string;
  allowedChatIds?: string[];
  pairedAt?: string;
}

/**
 * `.fortytwo/identity.json` — captured answers. Persona templates render
 * against this. Secrets do NOT live here (they go to `.env`); only the
 * non-secret identity/answers the persona needs to render.
 */
export interface Identity {
  /** Schema version of THIS file's shape, so future CLI versions can migrate it. */
  identityVersion: number;
  /** The assistant's name (e.g. "Ford"). Drives ASSISTANT_ACTOR + persona templates. */
  agentName: string;
  owner: OwnerIdentity;
  channels?: ChannelBinding[];
  /** Free-form answers captured by `enrich` to deepen the persona over time. */
  enrichment?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One resolved sibling-package version pin. */
export interface VersionPin {
  name: string;     // e.g. "@justfortytwo/guide"
  range: string;    // the declared semver range (from package.json peerDeps / fortytwo.compat)
  resolved: string; // the concrete version installed (latest-in-range at install time)
}

/**
 * `.fortytwo/state.json` — installed version set + rollback ledger.
 * `current` is what's installed now; `previous` is the set BEFORE the last
 * update (the rollback target). Update safety = install latest-in-range, run
 * doctor (post-verify health check), and on success keep `current`; rollback is
 * MANUAL — the user runs `fortytwo rollback`, which restores `previous`.
 */
export interface InstallState {
  stateVersion: number;
  current: VersionPin[];
  previous: VersionPin[] | null;
  lastUpdatedAt: string;
}

function fortytwoPath(root: string, file: string): string {
  return join(resolve(root), FORTYTWO_DIR, file);
}

function readJson<T>(path: string): T | null {
  // TODO(impl): return null when the file is absent; throw on malformed JSON
  // (a corrupt state file is a real error the user must see, not silently eat).
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  // TODO(impl): mkdir -p `.fortytwo/`, write pretty-printed JSON atomically
  // (write to a temp file in the same dir, then rename) so a crash mid-write
  // can't truncate the rollback ledger.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// --- identity.json ---

export function readIdentity(root = process.cwd()): Identity | null {
  return readJson<Identity>(fortytwoPath(root, IDENTITY_FILE));
}

export function writeIdentity(identity: Identity, root = process.cwd()): void {
  // TODO(impl): stamp updatedAt; preserve createdAt if the file already exists.
  writeJson(fortytwoPath(root, IDENTITY_FILE), identity);
}

// --- state.json ---

export function readState(root = process.cwd()): InstallState | null {
  return readJson<InstallState>(fortytwoPath(root, STATE_FILE));
}

export function writeState(state: InstallState, root = process.cwd()): void {
  writeJson(fortytwoPath(root, STATE_FILE), state);
}

/**
 * Record a freshly-resolved version set, rotating the existing `current` into
 * `previous` so `rollback` has a target. Called by `update` (and `init`).
 * TODO(impl): on the very first install, `previous` stays null.
 */
export function recordVersionSet(next: VersionPin[], root = process.cwd()): InstallState {
  const prior = readState(root);
  const state: InstallState = {
    stateVersion: 1,
    current: next,
    previous: prior?.current ?? null,
    lastUpdatedAt: new Date().toISOString(),
  };
  writeState(state, root);
  return state;
}
