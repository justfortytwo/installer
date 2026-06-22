// init — first-run install + scaffold. The `create-fortytwo` happy path.
//
// End state after a successful init:
//   - .fortytwo/identity.json  written from captured answers (gitignored)
//   - .env                     written with secrets (gitignored)
//   - CLAUDE.md + context/*    rendered from @justfortytwo/persona templates
//   - .mcp.json                wired to the memory MCP server
//   - Ollama has EMBED_MODEL pulled; the memory DB is migrated
//   - .fortytwo/state.json     records the resolved sibling version set (rollback baseline)
//   - a one-time pairing code printed so the owner can /login from their channel
//
// Reference provisioning shape: fortytwo/scripts/wakeup.sh (preflight secrets,
// embedder reachability) and fortytwo/docker-compose.yml (ollama pull of
// qwen3-embedding:0.6b, db migrate, DB_PATH default db/fortytwo.db).

import type { Identity } from '../state.js';
import { writeIdentity, recordVersionSet } from '../state.js';
import { renderPersona } from '../render.js';

// The embedder model the engine standardizes on (privacy: local-only embeddings).
// Matches fortytwo's EMBED_MODEL default.
export const EMBED_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_DB_PATH = 'db/fortytwo.db';

interface InitFlags {
  /** Non-interactive: take all answers from flags/env instead of prompting. */
  yes?: boolean;
  agentName?: string;
  ownerName?: string;
  // secrets — captured to .env, NOT identity.json
  telegramBotToken?: string;
  allowedChatIds?: string;
  // provisioning overrides
  ollamaBaseUrl?: string;
  dbPath?: string;
}

/**
 * Resolve answers. Interactive by default; fully non-interactive when `--yes`
 * (or CI) is set, drawing from flags then env (FORTYTWO_AGENT_NAME,
 * TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS, OLLAMA_BASE_URL, DB_PATH, EMBED_MODEL).
 * TODO(impl): prompt loop (readline) for the interactive path; validate the
 * agent name is non-empty and the chat-id allowlist is present before writing.
 */
function resolveAnswers(_flags: InitFlags): { identity: Identity; secrets: Record<string, string> } {
  throw new Error('TODO(impl): resolveAnswers — prompt or read flags/env for agent + owner + secrets');
}

/**
 * Write secrets to a gitignored `.env`. Secrets NEVER go to identity.json or any
 * versioned file (wakeup.sh enforces TELEGRAM_BOT_TOKEN + ALLOWED_CHAT_IDS exist
 * here before boot). TODO(impl): merge-not-clobber an existing .env; also seed
 * OLLAMA_BASE_URL / EMBED_MODEL / DB_PATH so the engine reads them at runtime.
 */
function writeEnv(_secrets: Record<string, string>, _root: string): void {
  throw new Error('TODO(impl): writeEnv — write .env (gitignored), merge with existing');
}

/**
 * Provision local infra:
 *   1. ensure Ollama reachable at OLLAMA_BASE_URL; pull EMBED_MODEL if absent
 *      (mirrors docker-compose ollama-init: `ollama list | grep -q $EMBED_MODEL
 *      || ollama pull $EMBED_MODEL`). Warn-only on unreachable, like wakeup.sh —
 *      the engine degrades to FakeEmbedder, it does not hard-fail.
 *   2. run db migrations against DB_PATH.
 * TODO(wire): step 2 delegates to @justfortytwo/memory's runMigrations
 * (the engine owns the migration list; the CLI must not duplicate schema).
 */
async function provision(_secrets: Record<string, string>): Promise<void> {
  // TODO(wire): import { runMigrations } from '@justfortytwo/memory' and run it
  // against DB_PATH after ensuring the embedder model is present.
  throw new Error('TODO(wire): provision — ollama pull EMBED_MODEL + db migrate via @justfortytwo/memory');
}

/**
 * Snapshot the resolved sibling versions into state.json so update/rollback have
 * a baseline. Distribution policy is "semver ranges, latest-compatible": there
 * is no curated bill-of-materials, so the install-time resolved set IS the record.
 * TODO(wire): read the actually-installed versions of @justfortytwo/* from
 * node_modules (their package.json `version`) paired with the declared ranges
 * from this package's peerDeps / fortytwo.compat.
 */
function recordInstalledSet(_root: string): void {
  // TODO(wire): resolve installed versions, then recordVersionSet([...]).
  void recordVersionSet;
}

export async function runInit(_argv: string[]): Promise<number> {
  // TODO(impl) orchestration:
  //   const flags = parseFlags(argv)
  //   const { identity, secrets } = resolveAnswers(flags)
  //   writeIdentity(identity)                       // .fortytwo/identity.json
  //   writeEnv(secrets, root)                       // .env (secrets only)
  //   renderPersona(identity)                       // CLAUDE.md + context/*
  //   writeMcpJson(root)                            // wire memory MCP into .mcp.json
  //   await provision(secrets)                      // ollama pull + db migrate
  //   recordInstalledSet(root)                      // rollback baseline
  //   const code = await issuePairingCode(identity) // delegate to telegram adapter
  //   print next steps (attach, /login with the code)
  void writeIdentity; void renderPersona; void recordInstalledSet; void provision;
  throw new Error('TODO(impl): runInit — capture, write, render, provision, then issue pairing code');
}

/**
 * Issue the owner's first pairing code by delegating to the channel adapter.
 * TODO(wire): import { issueChallenge } from '@justfortytwo/telegram' and call
 * it; it mints a one-time /login code, persists the pending challenge, and the
 * owner redeems it from their Telegram chat to bind ALLOWED_CHAT_IDS. (In the
 * monolith the allowlist is static env; the adapter's issueChallenge is the
 * designed-future pairing handshake that supersedes hand-editing ALLOWED_CHAT_IDS.)
 */
async function issuePairingCode(_identity: Identity): Promise<string> {
  throw new Error('TODO(wire): issuePairingCode — @justfortytwo/telegram issueChallenge');
}

void issuePairingCode;
