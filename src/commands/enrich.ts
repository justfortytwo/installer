// enrich: show the persona fields that are still empty, or save them from a file.
//
//   fortytwo enrich                  list the empty fields by topic and re-render
//   fortytwo enrich --answers <file> take the values from a JSON file and re-render
//
// init asks only for the required fields, so most of the persona manifest (bios,
// voice, vocabulary, domain) starts empty. enrich used to ask for each of them in
// a row (about 41 questions); now the assistant fills them through conversation:
// the owner asks it "help me fill in my profile", persona's onboarding skill
// interviews by topic and writes .fortytwo/onboarding/draft.json, and
// `fortytwo onboard` saves it. A bare `fortytwo enrich` is the status for that:
// the empty fields grouped by the persona file whose template uses them, and the
// next step. `--answers` stays for values the owner already has in a file.
//
// Split with `fortytwo onboard`: onboard saves values the assistant DRAFTED from
// fetched and uploaded content (untrusted, so it confirms each change and records
// provenance), plus deep-profile facts in memory. enrich --answers saves values
// the owner wrote, so there is nothing to confirm and no memory involved. Both
// write the same `answers` map. When enrich replaces a value onboard saved, it
// drops that key's `profileProvenance`, since the old source no longer applies.
//
// Every run that gets past the checks renders through renderPersona, like
// onboard, even when no answer changed: managed outputs are rewritten, captured
// outputs the owner already has are never overwritten, and a captured file the
// owner moved aside is written fresh. The report names only files whose content
// changed, and for each changed answer the kept captured files that use it.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readIdentity, writeIdentity, type Answers, type Identity } from '../state.js';
import {
  loadPersonaManifest, renderPersona, templateKeys, type PersonaFile, type PersonaManifestField, type RenderResult,
} from '../render.js';
import { escapeForTerminal } from '../onboard.js';
import { coerceList, isEmpty } from './init.js';

export interface EnrichFlags {
  answersFile?: string;
  help?: boolean;
}

export interface EnrichDeps {
  readIdentity: () => Identity | null;
  writeIdentity: (identity: Identity) => void;
  /** The installed persona's manifest fields. Throws when persona is not installed. */
  fields: () => PersonaManifestField[];
  /** Render the persona; `changed` lists the written outputs whose content differs from before. */
  render: (identity: Identity) => EnrichRender;
  /** Each persona output, in manifest order, with the answer keys its template references. */
  templateRefs: () => TemplateRef[];
  /** The parsed `--answers` file. Throws when it is missing or not JSON. */
  readAnswersFile: (path: string) => unknown;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface EnrichRender extends RenderResult {
  changed: string[];
}

export interface TemplateRef {
  output: string;
  mode: PersonaFile['mode'];
  keys: string[];
}

/** One answer enrich saved: `before` is absent when the field had no value. */
export interface AnswerChange {
  key: string;
  before?: string | string[];
  after: string | string[];
}

/** The empty fields of one persona file, or of the contact group. */
export interface TopicGroup {
  topic: string;
  keys: string[];
}

/** The group for fields no template references (owner_email, owner_address). */
export const CONTACT_TOPIC = 'contact (saved in identity.json only)';

export const NEXT_STEP =
  'Ask your assistant: "help me fill in my profile" (it interviews you by topic, then run fortytwo onboard to save).';

const USAGE = `Usage: fortytwo enrich [--answers <file.json>]

Without options: list the persona fields that are still empty, grouped by
the persona file that uses them, and re-render the persona (a file you
moved aside under context/ is written again). To fill the fields, ask your
assistant "help me fill in my profile", then run \`fortytwo onboard\`.
  --answers <file> save values from a JSON object keyed by field (only
                   empty fields are taken) and re-render the persona.
                   Files you already have under context/ are kept.
`;

export function parseEnrichArgs(argv: string[]): EnrichFlags | { error: string } {
  const flags: EnrichFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answers') {
      const v = argv[++i];
      if (!v) return { error: '--answers needs a file path' };
      flags.answersFile = v;
    } else if (a === '--help' || a === '-h') flags.help = true;
    else return { error: `unknown option ${a}` };
  }
  return flags;
}

/** The fields with no value yet (absent, blank or an empty list), in manifest order. */
export function emptyFields(fields: PersonaManifestField[], answers: Answers): PersonaManifestField[] {
  return fields.filter((f) => !Object.prototype.hasOwnProperty.call(answers, f.key) || isEmpty(answers[f.key]));
}

/**
 * Group empty fields by topic: the first persona output (manifest order) whose
 * template references the key. Topics keep manifest order; fields no template
 * references go last under CONTACT_TOPIC. Topics with no empty field are left out.
 */
export function groupByTopic(empty: PersonaManifestField[], refs: TemplateRef[]): TopicGroup[] {
  const groups = new Map<string, string[]>(refs.map((r) => [r.output, []]));
  const contact: string[] = [];
  for (const f of empty) {
    const ref = refs.find((r) => r.keys.includes(f.key));
    if (ref) groups.get(ref.output)!.push(f.key);
    else contact.push(f.key);
  }
  const out = [...groups].filter(([, keys]) => keys.length > 0).map(([topic, keys]) => ({ topic, keys }));
  if (contact.length > 0) out.push({ topic: CONTACT_TOPIC, keys: contact });
  return out;
}

/** The status lines for a bare `fortytwo enrich`. */
export function statusReport(groups: TopicGroup[]): string[] {
  const total = groups.reduce((n, g) => n + g.keys.length, 0);
  if (total === 0) return ['enrich: every persona field has a value.'];
  const lines = [`enrich: ${total} persona field(s) still empty.`];
  for (const g of groups) {
    lines.push('', `${g.topic} (${g.keys.length})`, ...wrapKeys(g.keys));
  }
  return lines;
}

/** Comma-separated keys, indented, wrapped near 78 columns. */
function wrapKeys(keys: string[], width = 78): string[] {
  const lines: string[] = [];
  let line = '';
  for (const [i, key] of keys.entries()) {
    const word = i < keys.length - 1 ? `${key},` : key;
    if (line && `  ${line} ${word}`.length > width) { lines.push(`  ${line}`); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(`  ${line}`);
  return lines;
}

/** A value on one line, for the change report. */
export function preview(v: string | string[], max = 60): string {
  const flat = (Array.isArray(v) ? v.join('; ') : v).replace(/\s*\n\s*/g, ' / ');
  const short = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
  return escapeForTerminal(short);
}

/**
 * Values from an `--answers` JSON object for the empty fields. Keys that are
 * not empty fields (unknown, or already set) are returned in `ignored`.
 * Lists accept an array of strings/numbers (trimmed, blanks dropped) or a
 * comma/newline separated string, like init; a list value with no usable item
 * is ignored too.
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
      const items = Array.isArray(v)
        ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean)
        : typeof v === 'string' ? coerceList(v) : [];
      if (items.length > 0) updates[key] = items;
      else ignored.push(key);
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

/**
 * What the render did, for the owner: the outputs whose content changed, then
 * for each changed answer key the captured files that use it but were kept as
 * the owner has them. Files that use no changed key are never named.
 */
export function renderReport(r: EnrichRender, refs: TemplateRef[], changedKeys: string[]): string[] {
  const lines: string[] = [];
  if (r.changed.length > 0) lines.push(`✓ persona files updated: ${r.changed.join(', ')}`);
  for (const key of changedKeys) {
    const using = refs.filter((f) => f.keys.includes(key));
    const kept = using.filter((f) => f.mode === 'captured' && r.skipped.includes(f.output)).map((f) => f.output);
    if (using.length === 0) {
      lines.push(`  ${key}: saved in .fortytwo/identity.json only (by design, no persona file shows it)`);
    } else if (kept.length > 0) {
      const onlyThere = kept.length === using.length;
      const one = kept.length === 1;
      lines.push(
        `! ${key} is ${onlyThere ? 'only' : 'also'} in ${kept.join(', ')} (kept as you have ${one ? 'it' : 'them'}): ` +
        `move ${one ? 'it' : 'them'} aside and run \`fortytwo enrich\` to regenerate ${one ? 'it' : 'them'}`,
      );
    }
  }
  return lines;
}

function renderAndReport(deps: EnrichDeps, identity: Identity, changedKeys: string[]): void {
  const r = deps.render(identity);
  const refs = changedKeys.length > 0 ? deps.templateRefs() : [];
  for (const line of renderReport(r, refs, changedKeys)) deps.out(`${line}\n`);
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

  const empty = emptyFields(fields, identity.answers);
  if (flags.answersFile === undefined) {
    const groups = groupByTopic(empty, deps.templateRefs());
    for (const line of statusReport(groups)) deps.out(`${line}\n`);
    // Holes from a newer persona are filled for rendering only; nothing is written.
    renderAndReport(deps, { ...identity, answers: mergeAnswers(fields, identity.answers, {}).answers }, []);
    if (empty.length > 0) deps.out(`\n${NEXT_STEP}\n`);
    return 0;
  }

  if (empty.length === 0) {
    deps.out('enrich: every persona field has a value.\n');
    renderAndReport(deps, identity, []);
    return 0;
  }

  let raw: unknown;
  try {
    raw = deps.readAnswersFile(flags.answersFile);
  } catch (e) {
    deps.err(`enrich: cannot read ${flags.answersFile}: ${(e as Error).message}\n`);
    return 2;
  }
  const parsed = answersFromFile(empty, raw);
  if ('error' in parsed) {
    deps.err(`enrich: ${flags.answersFile}: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.ignored.length > 0) {
    deps.out(`! ignored ${parsed.ignored.length} key(s) that are not empty persona fields: ${parsed.ignored.map((k) => escapeForTerminal(k)).join(', ')}\n`);
  }

  const merged = mergeAnswers(fields, identity.answers, parsed.updates);
  if (merged.changes.length === 0) {
    deps.out('enrich: nothing changed in .fortytwo/identity.json.\n');
    // Holes from a newer persona are filled for rendering only; nothing is written.
    renderAndReport(deps, { ...identity, answers: merged.answers }, []);
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

  renderAndReport(deps, updated, merged.changes.map((c) => c.key));
  return 0;
}

/** The real fs-backed deps for a project root. */
export function enrichDeps(root: string): EnrichDeps {
  return {
    readIdentity: () => readIdentity(root),
    writeIdentity: (identity) => writeIdentity(identity, root),
    fields: () => loadPersonaManifest(undefined, root).fields,
    render: (identity) => {
      const read = (output: string): string | null => {
        const abs = join(root, output);
        return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      };
      const before = new Map(loadPersonaManifest(undefined, root).files.map((f) => [f.output, read(f.output)]));
      const r = renderPersona(identity, { root });
      return { ...r, changed: r.written.filter((o) => read(o) !== before.get(o)) };
    },
    templateRefs: () => {
      const m = loadPersonaManifest(undefined, root);
      const tplRoot = resolve(m.templatesDir);
      return m.files.map((f) => {
        const tplPath = resolve(tplRoot, f.template);
        // Same guard as renderPersona: never read outside the templates dir.
        if (!tplPath.startsWith(tplRoot + sep)) throw new Error(`template path escapes templates dir: ${f.template}`);
        return { output: f.output, mode: f.mode, keys: templateKeys(readFileSync(tplPath, 'utf8')) };
      });
    },
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
  return performEnrich(enrichDeps(process.cwd()), parsed);
}
