// onboard — confirm and save the owner profile drafted by the onboarding interview.
//
//   fortytwo onboard                 review .fortytwo/onboarding/draft.json, confirm, save
//   fortytwo onboard --draft <path>  review another draft file
//   fortytwo onboard --dry-run       show what would change; save nothing
//
// The interview runs in the agent (persona's `onboarding` skill), which writes
// the draft. This verb is the only writer of the result, and it persists nothing
// until the owner confirms in a terminal. That is deliberate, like `forget`: the
// draft was distilled from fetched and uploaded content, so an injected
// instruction must never be able to save itself. There is no --yes.
//
// On confirmation:
//   - summary claims merge into .fortytwo/identity.json `answers` (+ their
//     `profileProvenance`), then the persona is re-rendered the usual way
//     (managed outputs rewritten, captured ones the owner already has kept);
//   - deep-profile facts are stored in memory, tagged `owner-profile`; a changed
//     fact supersedes its previous row (history kept).
// Re-running diffs against what is saved and asks only about real changes. When
// memory cannot be reached (not installed, embedder down), the summary still
// saves and the facts stay in the draft for the next run.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readIdentity, writeIdentity, type Identity } from '../state.js';
import { loadPersonaManifest, renderPersona, type PersonaManifestField, type RenderResult } from '../render.js';
import { loadSibling } from '../engine.js';
import { DEFAULT_DB_PATH, readMcpJson, readProjectSetting } from './init.js';
import {
  DEFAULT_DRAFT_PATH, PROFILE_TAG, applySummary, diffProfile, existingFactsFromRows, factToMemory, formatChange,
  parseDraft, type ExistingFact, type FactClaim, type ProfileChange, type SummaryClaim,
} from '../onboard.js';

export interface OnboardFlags {
  draft: string;
  dryRun?: boolean;
  help?: boolean;
}

/** The deep-profile side of memory, opened for one run. */
export interface ProfileMemory {
  existing(): Promise<ExistingFact[]>;
  store(claim: FactClaim, supersedes?: number): Promise<number>;
  close(): Promise<void>;
}

export interface OnboardDeps {
  /** The parsed draft JSON, or null when the file does not exist. Throws on invalid JSON. */
  readDraft: (path: string) => unknown | null;
  readIdentity: () => Identity | null;
  writeIdentity: (identity: Identity) => void;
  /** The installed persona's manifest fields. Throws when persona is not installed. */
  fields: () => PersonaManifestField[];
  render: (identity: Identity) => RenderResult;
  /** Memory for the deep profile, or a reason it is unavailable. */
  memory: () => Promise<ProfileMemory | { unavailable: string }>;
  /** Present only when a person can answer in a terminal. */
  ask?: (prompt: string) => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `Usage: fortytwo onboard [--draft <path>] [--dry-run]

Review the owner profile drafted by the onboarding interview (ask your
assistant to run its onboarding skill), then confirm what to save. Nothing is
saved without your confirmation in a terminal.
  --draft <path>  the draft to review (default ${DEFAULT_DRAFT_PATH})
  --dry-run       show what would change and save nothing
`;

export function parseOnboardArgs(argv: string[]): OnboardFlags {
  const flags: OnboardFlags = { draft: DEFAULT_DRAFT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--draft') flags.draft = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') flags.help = true;
  }
  return flags;
}

/** y = all, e = one by one, anything else = none. Pure: `ask` is injected. */
export async function confirmChanges(
  changes: ProfileChange[],
  ask: (prompt: string) => Promise<string>,
): Promise<ProfileChange[]> {
  const answer = (await ask(`Save ${changes.length} change(s)? [y]es / [e]ach / [N]o: `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return changes;
  if (answer !== 'e' && answer !== 'each') return [];
  const kept: ProfileChange[] = [];
  for (const c of changes) {
    const one = (await ask(`${formatChange(c).join('\n')}\n  Save this? [y/N]: `)).trim().toLowerCase();
    if (one === 'y' || one === 'yes') kept.push(c);
  }
  return kept;
}

function reportRender(deps: OnboardDeps, r: RenderResult): void {
  deps.out(`✓ rendered persona: ${r.written.length} written, ${r.skipped.length} preserved\n`);
  if (r.skipped.length > 0) {
    deps.out(`  kept as you have them: ${r.skipped.join(', ')}. To regenerate one from the saved profile, move it aside and run \`fortytwo onboard\` again.\n`);
  }
}

export async function performOnboard(deps: OnboardDeps, flags: OnboardFlags): Promise<number> {
  if (flags.help) { deps.out(USAGE); return 0; }

  const identity = deps.readIdentity();
  if (!identity) {
    deps.err('onboard: no .fortytwo/identity.json here; run `fortytwo init` first.\n');
    return 2;
  }
  let raw: unknown;
  try {
    raw = deps.readDraft(flags.draft);
  } catch (e) {
    deps.err(`onboard: ${flags.draft} is not valid JSON (${(e as Error).message}); nothing saved.\n`);
    return 2;
  }
  if (raw === null) {
    deps.err(`onboard: no draft at ${flags.draft}. Ask your assistant to run the onboarding interview; it writes the draft there.\n`);
    return 2;
  }
  let fields: PersonaManifestField[];
  try {
    fields = deps.fields();
  } catch (e) {
    deps.err(`onboard: ${(e as Error).message}\n`);
    return 2;
  }
  const parsed = parseDraft(raw, fields);
  if (!parsed.draft) {
    deps.err(`onboard: the draft was rejected; nothing saved:\n${parsed.errors.map((e) => `  - ${e}\n`).join('')}`);
    return 2;
  }
  const draft = parsed.draft;

  // Memory is opened only when there are facts to diff or save.
  let memory: ProfileMemory | null = null;
  let existing: ExistingFact[] = [];
  let pendingFacts = 0;
  if (draft.facts.length > 0) {
    const m = await deps.memory();
    if ('unavailable' in m) {
      pendingFacts = draft.facts.length;
    } else {
      try {
        existing = await m.existing();
        memory = m;
      } catch (e) {
        await m.close();
        pendingFacts = draft.facts.length;
        deps.out(`! memory could not be read (${(e as Error).message}).\n`);
      }
    }
    if (!memory) {
      if ('unavailable' in m) deps.out(`! ${m.unavailable}.\n`);
      deps.out(`! ${pendingFacts} deep-profile fact(s) left in the draft; re-run \`fortytwo onboard\` once memory is reachable.\n`);
    }
  }

  try {
    const { changes, unchanged } = diffProfile(
      memory ? draft : { ...draft, facts: [] },
      identity.answers,
      existing,
    );
    if (changes.length === 0) {
      deps.out(`✓ the saved profile already matches the draft (${unchanged} claim(s) unchanged).\n`);
      // Re-render from what is already saved: regenerates a captured file the
      // owner moved aside. Writes nothing new to the profile.
      if (!flags.dryRun) reportRender(deps, deps.render(identity));
      return pendingFacts > 0 ? 1 : 0;
    }
    deps.out(`Proposed profile changes (${unchanged} unchanged claim(s) not shown):\n`);
    for (const c of changes) deps.out(`${formatChange(c).join('\n')}\n`);
    if (flags.dryRun) {
      deps.out('dry run: nothing saved.\n');
      return 0;
    }
    if (!deps.ask) {
      deps.err('onboard: confirm in a terminal — run `fortytwo onboard` there; nothing saved.\n');
      return 2;
    }
    const kept = await confirmChanges(changes, deps.ask);
    if (kept.length === 0) {
      deps.out('onboard: nothing saved.\n');
      return 0;
    }

    let code = pendingFacts > 0 ? 1 : 0;
    const summary = kept.filter((c): c is Extract<ProfileChange, { kind: 'summary' }> => c.kind === 'summary');
    if (summary.length > 0) {
      const next = applySummary(identity.answers, identity.profileProvenance, summary.map((c) => c.claim as SummaryClaim));
      const updated: Identity = { ...identity, ...next };
      deps.writeIdentity(updated);
      deps.out(`✓ saved ${summary.length} persona value(s) to .fortytwo/identity.json\n`);
      reportRender(deps, deps.render(updated));
    }

    const facts = kept.filter((c): c is Extract<ProfileChange, { kind: 'fact' }> => c.kind === 'fact');
    if (facts.length > 0 && memory) {
      let saved = 0;
      for (const c of facts) {
        try {
          await memory.store(c.claim, c.supersedes);
          saved++;
        } catch (e) {
          deps.out(`! memory refused a fact (${(e as Error).message}); ${facts.length - saved} fact(s) not saved. The draft is kept: re-run \`fortytwo onboard\` once memory is reachable.\n`);
          code = 1;
          break;
        }
      }
      if (saved > 0) deps.out(`✓ saved ${saved} deep-profile fact(s) to memory (tag ${PROFILE_TAG})\n`);
    }
    return code;
  } finally {
    await memory?.close();
  }
}

type MemoryRow = { id: number; content: string; meta: string | null };
interface MemoryApi {
  openDb(path: string): { k?: { destroy?: () => Promise<void> }; close?: () => void };
  query(h: unknown, opts: Record<string, unknown>): Promise<MemoryRow[]>;
  store(h: unknown, embedder: unknown, m: Record<string, unknown>): Promise<number>;
  embedderFromEnv(env: Record<string, string | undefined>): unknown;
}

/**
 * Open memory the way the memory MCP server does: DB_PATH and the embedder
 * settings come from the `fortytwo-memory` entry in .mcp.json (its launch env),
 * falling back to the project's DB_PATH setting and the default path.
 */
export async function openProfileMemory(root: string): Promise<ProfileMemory | { unavailable: string }> {
  const mem = await loadSibling<Partial<MemoryApi>>('@justfortytwo/memory', root);
  if (!mem || typeof mem.store !== 'function' || typeof mem.query !== 'function' || typeof mem.openDb !== 'function' || typeof mem.embedderFromEnv !== 'function') {
    return { unavailable: '@justfortytwo/memory is not installed in this project' };
  }
  let mcpEnv: Record<string, string> = {};
  try {
    const entry = readMcpJson(root)?.mcpServers?.['fortytwo-memory'] as { env?: Record<string, unknown> } | undefined;
    for (const [k, v] of Object.entries(entry?.env ?? {})) if (typeof v === 'string') mcpEnv[k] = v;
  } catch {
    mcpEnv = {};
  }
  const dbPath = resolve(root, mcpEnv.DB_PATH ?? readProjectSetting('DB_PATH', root) ?? DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) return { unavailable: `the memory database ${dbPath} does not exist (run \`fortytwo init\`)` };
  const api = mem as MemoryApi;
  const h = api.openDb(dbPath);
  const embedder = api.embedderFromEnv({ ...process.env, ...mcpEnv });
  return {
    existing: async () => existingFactsFromRows(await api.query(h, { tag: PROFILE_TAG, limit: 100000 })),
    store: (claim, supersedes) => api.store(h, embedder, factToMemory(claim, supersedes)),
    close: async () => {
      try { await h.k?.destroy?.(); } catch { /* best-effort */ }
      try { h.close?.(); } catch { /* best-effort */ }
    },
  };
}

export async function runOnboard(argv: string[]): Promise<number> {
  const root = process.cwd();
  const flags = parseOnboardArgs(argv);
  const base: OnboardDeps = {
    readDraft: (path) => {
      const abs = resolve(root, path);
      return existsSync(abs) ? (JSON.parse(readFileSync(abs, 'utf8')) as unknown) : null;
    },
    readIdentity: () => readIdentity(root),
    writeIdentity: (identity) => writeIdentity(identity, root),
    fields: () => loadPersonaManifest(undefined, root).fields,
    render: (identity) => renderPersona(identity, { root }),
    memory: () => openProfileMemory(root),
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
  };
  if (process.stdin.isTTY !== true || flags.dryRun || flags.help) return performOnboard(base, flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await performOnboard({ ...base, ask: (q) => rl.question(q) }, flags);
  } finally {
    rl.close();
  }
}
