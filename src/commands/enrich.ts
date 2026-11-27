// enrich: fill in the persona fields that are still empty, then re-render.
//
//   fortytwo enrich                  ask for every manifest field with no value yet
//   fortytwo enrich --all            ask for every field; Enter keeps the current value
//   fortytwo enrich --answers <file> take the values from a JSON file instead of asking
//
// init asks only for the required fields, so most of the persona manifest (bios,
// voice, vocabulary, domain) starts empty. enrich is where the owner types those
// in. It asks one field at a time; Enter skips a field and a line with only "."
// stops and saves what was answered so far.
//
// Split with `fortytwo onboard`: onboard saves values the assistant DRAFTED from
// fetched and uploaded content (untrusted, so it confirms each change and records
// provenance), plus deep-profile facts in memory. enrich saves values the owner
// types directly, so there is nothing to confirm and no memory involved. Both
// write the same `answers` map. When enrich replaces a value onboard saved, it
// drops that key's `profileProvenance`, since the old source no longer applies.
//
// Re-render goes through renderPersona like init and onboard: managed outputs are
// rewritten, captured outputs the owner already has are never overwritten.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readIdentity, writeIdentity, type Answers, type Identity } from '../state.js';
import { loadPersonaManifest, renderPersona, type PersonaManifestField, type RenderResult } from '../render.js';
import { escapeForTerminal } from '../onboard.js';
import { askList, coerceList, isEmpty, listPromptLabel } from './init.js';

export interface EnrichFlags {
  all?: boolean;
  answersFile?: string;
  help?: boolean;
}

export interface EnrichDeps {
  readIdentity: () => Identity | null;
  writeIdentity: (identity: Identity) => void;
  /** The installed persona's manifest fields. Throws when persona is not installed. */
  fields: () => PersonaManifestField[];
  render: (identity: Identity) => RenderResult;
  /** The parsed `--answers` file. Throws when it is missing or not JSON. */
  readAnswersFile: (path: string) => unknown;
  /** Present only when a person can answer in a terminal. */
  ask?: (prompt: string) => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** One answer enrich saved: `before` is absent when the field had no value. */
export interface AnswerChange {
  key: string;
  before?: string | string[];
  after: string | string[];
}

/** Typed on its own line, ends the prompting and saves what was answered. */
export const STOP_WORD = '.';

const USAGE = `Usage: fortytwo enrich [--all] [--answers <file.json>]

Ask for the persona fields that are still empty, save the answers to
.fortytwo/identity.json and re-render the persona. Files you already have
under context/ are kept as they are.
  Enter            skip a field (it stays empty)
  .                stop asking and save what you answered so far
  --all            also ask for fields that have a value (Enter keeps it)
  --answers <file> read the values from a JSON object keyed by field
                   (no prompts; works without a terminal)
`;

export function parseEnrichArgs(argv: string[]): EnrichFlags | { error: string } {
  const flags: EnrichFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') flags.all = true;
    else if (a === '--answers') {
      const v = argv[++i];
      if (!v) return { error: '--answers needs a file path' };
      flags.answersFile = v;
    } else if (a === '--help' || a === '-h') flags.help = true;
    else return { error: `unknown option ${a}` };
  }
  return flags;
}

/** The fields to ask about, in manifest order: the empty ones, or every one with `all`. */
export function pendingFields(
  fields: PersonaManifestField[],
  answers: Answers,
  opts: { all?: boolean } = {},
): PersonaManifestField[] {
  if (opts.all) return [...fields];
  return fields.filter((f) => !Object.prototype.hasOwnProperty.call(answers, f.key) || isEmpty(answers[f.key]));
}

/** A value on one line, for prompts and the change report. */
export function preview(v: string | string[], max = 60): string {
  const flat = (Array.isArray(v) ? v.join('; ') : v).replace(/\s*\n\s*/g, ' / ');
  const short = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
  return escapeForTerminal(short);
}

/**
 * Ask for each pending field. A blank answer skips it (the current value, if
 * any, stays). Lists are asked item by item like init. Only non-blank answers
 * are returned. Pure: `ask` is injected.
 */
export async function askFields(
  pending: PersonaManifestField[],
  answers: Answers,
  ask: (prompt: string) => Promise<string>,
): Promise<{ updates: Answers; stopped: boolean }> {
  const updates: Answers = {};
  let stopped = false;
  const ask_ = async (q: string): Promise<string> => {
    const a = await ask(q);
    if (a.trim() !== STOP_WORD) return a;
    stopped = true;
    return '';
  };
  for (const [i, f] of pending.entries()) {
    const current = Object.prototype.hasOwnProperty.call(answers, f.key) ? answers[f.key] : undefined;
    const has = current !== undefined && !isEmpty(current);
    const head = `(${i + 1}/${pending.length}) `;
    if (f.type === 'list') {
      const label = `${head}${listPromptLabel(f.prompt)}${has ? `\n  current: ${preview(current)} (Enter keeps it)` : ''}`;
      const items = await askList(label, ask_);
      if (items.length > 0) updates[f.key] = items;
    } else {
      const answer = (await ask_(`${head}${f.prompt}${has ? ` [${preview(current)}]` : ''}\n> `)).trim();
      if (answer) updates[f.key] = answer;
    }
    if (stopped) break;
  }
  return { updates, stopped };
}

/**
 * Values from an `--answers` JSON object for the pending fields. Keys that are
 * not pending (unknown, or already set without --all) are returned in `ignored`.
 * Lists accept an array or a comma/newline separated string, like init.
 */
export function answersFromFile(
  pending: PersonaManifestField[],
  raw: unknown,
): { updates: Answers; ignored: string[] } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the answers file must hold a JSON object' };
  const byKey = new Map(pending.map((f) => [f.key, f]));
  const updates: Answers = {};
  const ignored: string[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = byKey.get(key);
    if (!f) { ignored.push(key); continue; }
    if (f.type === 'list') {
      const items = coerceList(v);
      if (items.length > 0) updates[key] = items;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v).trim();
      if (s) updates[key] = s;
    } else if (v != null) {
      ignored.push(key);
    }
  }
  return { updates, ignored };
}

function sameValue(a: string | string[] | undefined, b: string | string[]): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

/**
 * Merge `updates` into `answers` (new object; inputs untouched). Only manifest
 * fields are taken. A manifest field absent from `answers` (a newer persona
 * added it) is filled with '' or [] so the renderer, which fails on a missing
 * variable, never sees a hole. Returns the changes that actually differ.
 */
export function mergeAnswers(
  fields: PersonaManifestField[],
  answers: Answers,
  updates: Answers,
): { answers: Answers; changes: AnswerChange[] } {
  const next: Answers = { ...answers };
  const changes: AnswerChange[] = [];
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(next, f.key);
    if (!has) next[f.key] = f.type === 'list' ? [] : '';
    if (!Object.prototype.hasOwnProperty.call(updates, f.key)) continue;
    const after = updates[f.key]!;
    const before = has ? answers[f.key] : undefined;
    if (sameValue(before, after)) continue;
    next[f.key] = after;
    changes.push({ key: f.key, ...(before !== undefined && !isEmpty(before) ? { before } : {}), after });
  }
  return { answers: next, changes };
}

export function formatAnswerChange(c: AnswerChange): string {
  return c.before === undefined
    ? `  + ${c.key}: ${preview(c.after)}`
    : `  ~ ${c.key}: ${preview(c.before)} -> ${preview(c.after)}`;
}

export async function performEnrich(deps: EnrichDeps, flags: EnrichFlags): Promise<number> {
  if (flags.help) { deps.out(USAGE); return 0; }

  const identity = deps.readIdentity();
  if (!identity) {
    deps.err('enrich: no .fortytwo/identity.json here; run `fortytwo init` first.\n');
    return 2;
  }
  let fields: PersonaManifestField[];
  try {
    fields = deps.fields();
  } catch (e) {
    deps.err(`enrich: ${(e as Error).message}\n`);
    return 2;
  }

  const pending = pendingFields(fields, identity.answers, { all: flags.all });
  if (pending.length === 0) {
    deps.out('enrich: every persona field has a value. Run `fortytwo enrich --all` to revisit them.\n');
    return 0;
  }

  let updates: Answers;
  if (flags.answersFile !== undefined) {
    let raw: unknown;
    try {
      raw = deps.readAnswersFile(flags.answersFile);
    } catch (e) {
      deps.err(`enrich: cannot read ${flags.answersFile}: ${(e as Error).message}\n`);
      return 2;
    }
    const parsed = answersFromFile(pending, raw);
    if ('error' in parsed) {
      deps.err(`enrich: ${flags.answersFile}: ${parsed.error}\n`);
      return 2;
    }
    if (parsed.ignored.length > 0) {
      deps.out(`! ignored ${parsed.ignored.length} key(s) that are not empty persona fields${flags.all ? '' : ' (use --all to replace set ones)'}: ${parsed.ignored.map((k) => escapeForTerminal(k)).join(', ')}\n`);
    }
    updates = parsed.updates;
  } else if (deps.ask) {
    deps.out(`${pending.length} field(s) to fill. Enter skips one; "${STOP_WORD}" stops and saves.\n`);
    updates = (await askFields(pending, identity.answers, deps.ask)).updates;
  } else {
    deps.err('enrich: needs a terminal to ask questions. Run it in one, or pass --answers <file.json>.\n');
    return 2;
  }

  const merged = mergeAnswers(fields, identity.answers, updates);
  if (merged.changes.length === 0) {
    deps.out('enrich: nothing changed; persona not re-rendered.\n');
    return 0;
  }

  let profileProvenance = identity.profileProvenance;
  if (profileProvenance) {
    profileProvenance = { ...profileProvenance };
    for (const c of merged.changes) delete profileProvenance[c.key];
  }
  const updated: Identity = { ...identity, answers: merged.answers, ...(profileProvenance ? { profileProvenance } : {}) };
  deps.writeIdentity(updated);
  deps.out(`✓ saved ${merged.changes.length} answer(s) to .fortytwo/identity.json:\n`);
  for (const c of merged.changes) deps.out(`${formatAnswerChange(c)}\n`);

  const r = deps.render(updated);
  deps.out(`✓ rendered persona: ${r.written.length} written, ${r.skipped.length} preserved\n`);
  if (r.skipped.length > 0) {
    deps.out(`  kept as you have them: ${r.skipped.join(', ')}. Your new answers show up in one of these only after you move it aside; the next render (an enrich or onboard that saves something) writes it fresh.\n`);
  }
  return 0;
}

/** The real fs-backed deps for a project root, without `ask`. */
export function enrichDeps(root: string): EnrichDeps {
  return {
    readIdentity: () => readIdentity(root),
    writeIdentity: (identity) => writeIdentity(identity, root),
    fields: () => loadPersonaManifest(undefined, root).fields,
    render: (identity) => renderPersona(identity, { root }),
    readAnswersFile: (path) => {
      const abs = resolve(root, path);
      if (!existsSync(abs)) throw new Error('no such file');
      return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
    },
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
  };
}

export async function runEnrich(argv: string[]): Promise<number> {
  const parsed = parseEnrichArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`enrich: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const base = enrichDeps(process.cwd());
  if (process.stdin.isTTY !== true || parsed.answersFile !== undefined || parsed.help) return performEnrich(base, parsed);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await performEnrich({ ...base, ask: (q) => rl.question(q) }, parsed);
  } finally {
    rl.close();
  }
}
