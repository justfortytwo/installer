// onboard.ts — the owner-profile draft: its format, validation and diff.
//
// The onboarding interview itself is conversational work, so it runs in the
// agent (persona's `onboarding` skill): it collects links, uploaded texts and
// optional personality-test results, reads them as DATA (never instructions),
// and writes a draft to `.fortytwo/onboarding/draft.json`. Nothing in the draft
// is the profile yet. `fortytwo onboard` (commands/onboard.ts) is the only
// writer: it validates the draft here, diffs it against what is already saved,
// and persists only what the owner confirms in a terminal.
//
// Two destinations, one per claim list:
//   - `summary`: values for existing persona manifest fields (`owner_*`). They
//     merge into `.fortytwo/identity.json` answers, which the persona renders
//     from; their provenance goes to `identity.json` `profileProvenance`.
//   - `facts`:   the deep profile. Each becomes one memory row tagged
//     `owner-profile` (retrievable, not always loaded), with its provenance in
//     memory's source / observed / date / meta columns.
//
// Every claim carries provenance: source (link | upload | test | interview),
// an optional ref (the URL, file name or test name), the date and whether it
// was observed or inferred. A test result is self-report: it may become a fact,
// never a persona summary value (the always-loaded persona must not carry a
// personality label).
//
// Pure: no fs, no memory, no prompts. Everything here is unit-tested directly.

import type { Answers, ProfileProvenance } from './state.js';
import type { PersonaManifestField } from './render.js';

export const DRAFT_VERSION = 1;
/** Where the onboarding skill writes the draft, relative to the project root. */
export const DEFAULT_DRAFT_PATH = '.fortytwo/onboarding/draft.json';
/** Memory tag on every deep-profile fact; `fortytwo forget --tag owner-profile` removes them. */
export const PROFILE_TAG = 'owner-profile';

export const CLAIM_SOURCES = ['link', 'upload', 'test', 'interview'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];
export const OBSERVATIONS = ['observed', 'inferred'] as const;
export type Observation = (typeof OBSERVATIONS)[number];

export interface SummaryClaim extends ProfileProvenance {
  /** A persona manifest field key (`owner_*`). */
  key: string;
  value: string | string[];
}

export interface FactClaim extends ProfileProvenance {
  /** Stable id of the fact within the profile (e.g. `work.current-role`); a re-run with the same key updates it. */
  key: string;
  content: string;
}

export interface ProfileDraft {
  draftVersion: number;
  summary: SummaryClaim[];
  facts: FactClaim[];
}

// Caps keep a draft a profile, not a dump of fetched pages.
const MAX_LINE = 300;
const MAX_TEXT = 2000;
const MAX_FACT = 500;
const MAX_LIST_ITEMS = 20;
const MAX_FACTS = 200;
const FACT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Characters that can hide, reorder or rewrite text on a terminal or in the
// rendered persona: C0 controls (except tab and newline), DEL, C1 controls,
// bidi marks/overrides/isolates, zero-width characters, line and paragraph
// separators, and the BOM. None of them belongs in a profile value.
const UNSAFE_CHARS = '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF';
const CONTROL = new RegExp(`[${UNSAFE_CHARS}]`);
const UNSAFE_GLOBAL = new RegExp(`[${UNSAFE_CHARS}]`, 'g');
// Markdown structure that would let a summary value add sections or code
// blocks to the rendered persona: ATX headings and code fences.
const MARKDOWN_STRUCTURE = /^ {0,3}(#{1,6}(\s|$)|`{3,}|~{3,})/m;

/**
 * Make text safe to print on the owner's terminal: every character in
 * UNSAFE_CHARS becomes a visible \u{XXXX} escape. Newlines are kept. Use it on
 * anything that came from a draft, a fetched page, an upload or memory.
 */
export function escapeForTerminal(s: string): string {
  return s.replace(UNSAFE_GLOBAL, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** A trimmed string within `max`, single-line unless `multiline`; else an error message. */
function cleanText(v: unknown, max: number, multiline: boolean): string | { error: string } {
  if (typeof v !== 'string') return { error: 'must be a string' };
  const s = v.trim();
  if (!s) return { error: 'is empty' };
  if (CONTROL.test(s)) return { error: 'contains control characters' };
  if (!multiline && /[\r\n]/.test(s)) return { error: 'must be a single line' };
  if (s.length > max) return { error: `is longer than ${max} characters` };
  return s;
}

function parseProvenance(c: Record<string, unknown>, where: string, errors: string[]): ProfileProvenance | null {
  const before = errors.length;
  const source = c.source;
  if (!(CLAIM_SOURCES as readonly unknown[]).includes(source)) {
    errors.push(`${where}: source must be one of ${CLAIM_SOURCES.join(', ')}`);
  }
  if (!(OBSERVATIONS as readonly unknown[]).includes(c.observed)) {
    errors.push(`${where}: observed must be one of ${OBSERVATIONS.join(', ')}`);
  }
  if (!isIsoDate(c.date)) errors.push(`${where}: date must be a YYYY-MM-DD date`);
  let ref: string | undefined;
  if (c.ref !== undefined) {
    const r = cleanText(c.ref, MAX_LINE, false);
    if (typeof r !== 'string') errors.push(`${where}: ref ${r.error}`);
    else ref = r;
  }
  if (source === 'link' && (!ref || !isHttpUrl(ref))) errors.push(`${where}: a link claim needs ref set to its http(s) URL`);
  if (errors.length > before) return null;
  return {
    source: source as ClaimSource,
    ...(ref !== undefined ? { ref } : {}),
    date: c.date as string,
    observed: c.observed as Observation,
  };
}

function parseSummaryValue(field: PersonaManifestField, v: unknown, where: string, errors: string[]): string | string[] | null {
  if (field.type === 'list') {
    if (!Array.isArray(v)) { errors.push(`${where}: ${field.key} is a list field; value must be an array of strings`); return null; }
    if (v.length > MAX_LIST_ITEMS) { errors.push(`${where}: more than ${MAX_LIST_ITEMS} items`); return null; }
    const items: string[] = [];
    for (const [i, item] of v.entries()) {
      const s = cleanText(item, MAX_LINE, false);
      if (typeof s !== 'string') { errors.push(`${where}: item ${i + 1} ${s.error}`); return null; }
      if (MARKDOWN_STRUCTURE.test(s)) { errors.push(`${where}: item ${i + 1} contains a markdown heading or code fence`); return null; }
      items.push(s);
    }
    if (items.length === 0) { errors.push(`${where}: value is empty`); return null; }
    return items;
  }
  const s = cleanText(v, field.type === 'text' ? MAX_TEXT : MAX_LINE, field.type === 'text');
  if (typeof s !== 'string') { errors.push(`${where}: value ${s.error}`); return null; }
  if (MARKDOWN_STRUCTURE.test(s)) { errors.push(`${where}: value contains a markdown heading or code fence`); return null; }
  return s;
}

/**
 * Validate a draft against the installed persona manifest. All-or-nothing: any
 * error rejects the whole draft, so a half-valid draft never half-persists.
 */
export function parseDraft(
  raw: unknown,
  fields: PersonaManifestField[],
): { draft: ProfileDraft; errors: [] } | { draft: null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { draft: null, errors: ['the draft must be a JSON object'] };
  if (raw.draftVersion !== DRAFT_VERSION) {
    return { draft: null, errors: [`draftVersion must be ${DRAFT_VERSION} (got ${JSON.stringify(raw.draftVersion)})`] };
  }
  const summaryRaw = raw.summary ?? [];
  const factsRaw = raw.facts ?? [];
  if (!Array.isArray(summaryRaw)) errors.push('summary must be an array');
  if (!Array.isArray(factsRaw)) errors.push('facts must be an array');
  if (errors.length > 0) return { draft: null, errors };

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const summary: SummaryClaim[] = [];
  const seenSummary = new Set<string>();
  for (const [i, c] of (summaryRaw as unknown[]).entries()) {
    const where = `summary[${i}]`;
    if (!isRecord(c)) { errors.push(`${where}: must be an object`); continue; }
    const key = c.key;
    const field = typeof key === 'string' ? byKey.get(key) : undefined;
    if (typeof key !== 'string' || !key.startsWith('owner_') || !field) {
      errors.push(`${where}: key ${JSON.stringify(key)} is not an owner_* field of the installed persona`);
      continue;
    }
    if (seenSummary.has(key)) { errors.push(`${where}: duplicate key ${key}`); continue; }
    seenSummary.add(key);
    const prov = parseProvenance(c, where, errors);
    if (prov?.source === 'test') {
      errors.push(`${where}: a personality-test result is self-report; put it in facts, not in the persona summary`);
      continue;
    }
    const value = parseSummaryValue(field, c.value, where, errors);
    if (prov && value !== null) summary.push({ key, value, ...prov });
  }

  const facts: FactClaim[] = [];
  const seenFacts = new Set<string>();
  if ((factsRaw as unknown[]).length > MAX_FACTS) errors.push(`facts: more than ${MAX_FACTS} facts`);
  for (const [i, c] of (factsRaw as unknown[]).entries()) {
    const where = `facts[${i}]`;
    if (!isRecord(c)) { errors.push(`${where}: must be an object`); continue; }
    const key = c.key;
    if (typeof key !== 'string' || !FACT_KEY.test(key)) {
      errors.push(`${where}: key must match ${FACT_KEY.source}`);
      continue;
    }
    if (seenFacts.has(key)) { errors.push(`${where}: duplicate key ${key}`); continue; }
    seenFacts.add(key);
    const prov = parseProvenance(c, where, errors);
    const content = cleanText(c.content, MAX_FACT, false);
    if (typeof content !== 'string') { errors.push(`${where}: content ${content.error}`); continue; }
    if (prov) facts.push({ key, content, ...prov });
  }

  if (errors.length > 0) return { draft: null, errors };
  return { draft: { draftVersion: DRAFT_VERSION, summary, facts }, errors: [] };
}

/** A live deep-profile fact already in memory. */
export interface ExistingFact {
  id: number;
  key: string;
  content: string;
}

/**
 * The live `owner-profile` facts keyed by their profile key, from memory rows
 * (newest first, as memory's `query` returns them: the first row per key wins).
 * Rows without a profile key (written by something else) are ignored.
 */
export function existingFactsFromRows(rows: { id: number; content: string; meta: string | null }[]): ExistingFact[] {
  const seen = new Map<string, ExistingFact>();
  for (const r of rows) {
    let key: unknown;
    try { key = (JSON.parse(r.meta ?? '{}') as Record<string, unknown>).profileKey; } catch { key = undefined; }
    if (typeof key === 'string' && !seen.has(key)) seen.set(key, { id: r.id, key, content: r.content });
  }
  return [...seen.values()];
}

export type ProfileChange =
  | { kind: 'summary'; status: 'added' | 'changed'; claim: SummaryClaim; before?: string | string[] }
  | { kind: 'fact'; status: 'added' | 'changed'; claim: FactClaim; before?: string; supersedes?: number };

function sameValue(a: string | string[] | undefined, b: string | string[]): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && a.every((x, i) => x.trim() === b[i]);
  return typeof a === 'string' && a.trim() === b;
}

function isBlank(v: string | string[] | undefined): boolean {
  return v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
}

/**
 * What the draft would change. Additive: a key the draft leaves out is kept as
 * it is (removal is `fortytwo forget` for memory, or a later draft value for the
 * persona), and a claim equal to what is saved is not a change.
 */
export function diffProfile(
  draft: ProfileDraft,
  answers: Answers,
  existingFacts: ExistingFact[],
): { changes: ProfileChange[]; unchanged: number } {
  const changes: ProfileChange[] = [];
  let unchanged = 0;
  for (const claim of draft.summary) {
    const before = answers[claim.key];
    if (sameValue(before, claim.value)) { unchanged++; continue; }
    changes.push(isBlank(before)
      ? { kind: 'summary', status: 'added', claim }
      : { kind: 'summary', status: 'changed', claim, before });
  }
  const byKey = new Map(existingFacts.map((f) => [f.key, f]));
  for (const claim of draft.facts) {
    const prior = byKey.get(claim.key);
    if (prior && prior.content.trim() === claim.content) { unchanged++; continue; }
    changes.push(prior
      ? { kind: 'fact', status: 'changed', claim, before: prior.content, supersedes: prior.id }
      : { kind: 'fact', status: 'added', claim });
  }
  return { changes, unchanged };
}

function provenanceLabel(p: ProfileProvenance): string {
  return escapeForTerminal(`${p.source}${p.ref ? ` ${p.ref}` : ''}, ${p.date}, ${p.observed}`);
}

const VALUE_INDENT = '         ';

/** A value as it will be saved: list items joined, multi-line text kept multi-line and indented. */
function show(v: string | string[]): string {
  if (Array.isArray(v)) return v.map(escapeForTerminal).join('; ');
  return escapeForTerminal(v).split('\n').join(`\n${VALUE_INDENT}`);
}

/**
 * The lines that show one change to the owner: what, where it goes, old → new,
 * provenance. Every value is escaped, including `before`, which comes from
 * memory and was never validated by parseDraft.
 */
export function formatChange(c: ProfileChange): string[] {
  const where = c.kind === 'summary' ? 'persona' : 'memory';
  const lines = [`${c.status === 'added' ? '+' : '~'} [${where}] ${escapeForTerminal(c.claim.key)} (${provenanceLabel(c.claim)})`];
  if (c.before !== undefined) lines.push(`    was: ${show(c.before)}`);
  lines.push(`    ${c.before !== undefined ? 'now' : 'new'}: ${show(c.kind === 'summary' ? c.claim.value : c.claim.content)}`);
  return lines;
}

/** Merge confirmed summary claims into the answers + provenance maps (new objects; inputs untouched). */
export function applySummary(
  answers: Answers,
  provenance: Record<string, ProfileProvenance> | undefined,
  claims: SummaryClaim[],
): { answers: Answers; profileProvenance: Record<string, ProfileProvenance> } {
  const nextAnswers: Answers = { ...answers };
  const nextProv: Record<string, ProfileProvenance> = { ...(provenance ?? {}) };
  for (const { key, value, source, ref, date, observed } of claims) {
    nextAnswers[key] = value;
    nextProv[key] = { source, ...(ref !== undefined ? { ref } : {}), date, observed };
  }
  return { answers: nextAnswers, profileProvenance: nextProv };
}

/** The memory row for one confirmed fact (memory's MemoryInput shape). */
export function factToMemory(claim: FactClaim, supersedes?: number): {
  content: string; source: string; observed: string; date: string; tags: string[];
  meta: Record<string, unknown>; supersedes: number | null;
} {
  return {
    content: claim.content,
    source: `onboarding:${claim.source}`,
    observed: claim.observed,
    date: claim.date,
    tags: [PROFILE_TAG],
    meta: { profileKey: claim.key, ...(claim.ref !== undefined ? { ref: claim.ref } : {}) },
    supersedes: supersedes ?? null,
  };
}
