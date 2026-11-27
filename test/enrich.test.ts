// enrich.test.ts covers `fortytwo enrich`: which fields are empty (emptyFields), the
// status grouped by topic, the --answers file, merging, the command flow with
// injected deps, and runs against the real @justfortytwo/persona in a
// mkdtempSync sandbox (identity.json updated, a captured file kept or regenerated).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyFields, groupByTopic, statusReport, answersFromFile, fileAnswersReport, mergeAnswers, formatAnswerChange, parseEnrichArgs,
  performEnrich, enrichDeps, runEnrich, renderReport, CONTACT_TOPIC, NEXT_STEP,
  type EnrichDeps, type EnrichRender, type TemplateRef,
} from '../src/commands/enrich.js';
import { resolveAnswers } from '../src/commands/init.js';
import { loadPersonaManifest, renderPersona, templateKeys, type PersonaManifestField } from '../src/render.js';
import { readIdentity, writeIdentity, type Answers, type Identity } from '../src/state.js';
import { linkEngineInto } from './helpers/engine.js';

const FIELDS: PersonaManifestField[] = [
  { key: 'agent_name', prompt: 'Agent name', type: 'string', required: true },
  { key: 'owner_email', prompt: 'Email', type: 'string' },
  { key: 'owner_bio_short', prompt: 'Short bio', type: 'text' },
  { key: 'owner_interests', prompt: 'Interests, one per line', type: 'list' },
];

describe('emptyFields', () => {
  it('returns the empty or absent fields in manifest order', () => {
    const answers: Answers = { agent_name: 'Ada', owner_email: '  ', owner_interests: [] };
    expect(emptyFields(FIELDS, answers).map((f) => f.key)).toEqual(['owner_email', 'owner_bio_short', 'owner_interests']);
  });

  it('does not treat an inherited property as a value', () => {
    expect(emptyFields([{ key: 'toString', prompt: 'x', type: 'string' }], {}).map((f) => f.key)).toEqual(['toString']);
  });
});

describe('groupByTopic', () => {
  const refs: TemplateRef[] = [
    { output: 'CLAUDE.md', mode: 'managed', keys: ['agent_name'] },
    { output: 'context/PROFILE.md', mode: 'captured', keys: ['owner_interests', 'owner_bio_short'] },
    { output: 'context/memory/owner-profile.md', mode: 'captured', keys: ['owner_bio_short'] },
    { output: 'context/rules/APPROVED.md', mode: 'captured', keys: [] },
  ];

  it('puts each field under the first file that uses it, in manifest order, contact last', () => {
    const empty = emptyFields(FIELDS, { agent_name: 'Ada' });
    expect(groupByTopic(empty, refs)).toEqual([
      { topic: 'context/PROFILE.md', keys: ['owner_bio_short', 'owner_interests'] },
      { topic: CONTACT_TOPIC, keys: ['owner_email'] },
    ]);
  });

  it('returns nothing when no field is empty', () => {
    expect(groupByTopic([], refs)).toEqual([]);
  });
});

describe('statusReport', () => {
  it('shows the total, then a count and the keys per topic', () => {
    expect(statusReport([
      { topic: 'context/PROFILE.md', keys: ['owner_bio_short', 'owner_interests'] },
      { topic: CONTACT_TOPIC, keys: ['owner_email'] },
    ])).toEqual([
      'enrich: 3 persona field(s) still empty.',
      '',
      'context/PROFILE.md (2)',
      '  owner_bio_short, owner_interests',
      '',
      'contact (saved in identity.json only) (1)',
      '  owner_email',
    ]);
  });

  it('wraps a long key list', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `owner_field_number_${i}`);
    const lines = statusReport([{ topic: 't', keys }]).slice(3);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(78);
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe(keys.join(', '));
  });

  it('says so when nothing is empty', () => {
    expect(statusReport([])).toEqual(['enrich: every persona field has a value.']);
  });
});

describe('answersFromFile', () => {
  it('takes empty fields, coerces lists, and splits unknown keys from fields that have a value', () => {
    const r = answersFromFile(FIELDS, { agent_name: 'Ada' }, {
      owner_email: 'ada@example.org',
      owner_interests: 'chess, jazz',
      owner_bio_short: '',
      agent_name: 'Other',
      nope: 'x',
    });
    expect(r).toEqual({
      updates: { owner_email: 'ada@example.org', owner_interests: ['chess', 'jazz'] },
      unknown: ['nope'],
      alreadySet: ['agent_name'],
      unusable: [],
    });
  });

  it('cleans list values: string/number items only, trimmed, blanks dropped; nothing usable is unusable', () => {
    const lists: PersonaManifestField[] = [
      { key: 'a', prompt: 'a', type: 'list' },
      { key: 'b', prompt: 'b', type: 'list' },
      { key: 'c', prompt: 'c', type: 'list' },
      { key: 'd', prompt: 'd', type: 'list' },
      { key: 'e', prompt: 'e', type: 'list' },
    ];
    const r = answersFromFile(lists, {}, {
      a: ['  chess ', 42, '', '   ', null, { x: 1 }, ['nested'], true],
      b: [' ', null],
      c: 7,
      d: { x: 1 },
      e: '',
    });
    expect(r).toEqual({ updates: { a: ['chess', '42'] }, unknown: [], alreadySet: [], unusable: ['b', 'c', 'd', 'e'] });
  });

  it('rejects anything but an object', () => {
    expect(answersFromFile(FIELDS, {}, ['x'])).toEqual({ error: expect.stringMatching(/JSON object/) });
  });
});

describe('fileAnswersReport', () => {
  it('prints fields with a value apart from unknown keys, and nothing when all were taken', () => {
    expect(fileAnswersReport({ updates: {}, unknown: ['nope'], alreadySet: ['agent_name', 'owner_name'], unusable: ['x'] })).toEqual([
      '! skipped 2 field(s) that already have a value; to change one, ask your assistant ("help me fill in my profile") and run fortytwo onboard: agent_name, owner_name',
      '! ignored 1 key(s) that are not persona fields: nope',
      '! ignored 1 key(s) with no usable value: x',
    ]);
    expect(fileAnswersReport({ updates: { a: 'b' }, unknown: [], alreadySet: [], unusable: [] })).toEqual([]);
  });
});

describe('mergeAnswers', () => {
  it('fills only empty fields and leaves the input untouched', () => {
    const answers: Answers = { agent_name: 'Ada', owner_email: '', owner_bio_short: '', owner_interests: ['chess'] };
    const r = mergeAnswers(FIELDS, answers, { agent_name: 'Grace', owner_email: 'ada@example.org', owner_interests: ['go'], owner_bio_short: '' });
    expect(r.changes).toEqual([{ key: 'owner_email', after: 'ada@example.org' }]);
    expect(r.answers).toEqual({ agent_name: 'Ada', owner_email: 'ada@example.org', owner_bio_short: '', owner_interests: ['chess'] });
    expect(answers.owner_email).toBe('');
  });

  it('fills manifest fields missing from answers so render never sees a hole', () => {
    const r = mergeAnswers(FIELDS, { agent_name: 'Ada' }, {});
    expect(r.answers).toEqual({ agent_name: 'Ada', owner_email: '', owner_bio_short: '', owner_interests: [] });
    expect(r.changes).toEqual([]);
  });

  it('ignores keys that are not manifest fields', () => {
    const r = mergeAnswers(FIELDS, {}, { __proto__: 'x', other: 'y' } as unknown as Answers);
    expect(r.changes).toEqual([]);
    expect(Object.keys(r.answers)).not.toContain('other');
  });
});

describe('formatAnswerChange', () => {
  it('marks a filled value', () => {
    expect(formatAnswerChange({ key: 'owner_email', after: 'a@b.c' })).toBe('  + owner_email: a@b.c');
    expect(formatAnswerChange({ key: 'owner_interests', after: ['b', 'c'] })).toBe('  + owner_interests: b; c');
  });
});

describe('templateKeys', () => {
  it('lists each referenced key once, in order', () => {
    expect(templateKeys('# {{agent_name}}\n{{ owner_email }} and {{agent_name}}\nno {braces}')).toEqual(['agent_name', 'owner_email']);
  });
});

describe('renderReport', () => {
  const refs: TemplateRef[] = [
    { output: 'CLAUDE.md', mode: 'managed', keys: ['agent_name'] },
    { output: 'context/SOUL.md', mode: 'captured', keys: ['agent_name'] },
    { output: 'context/memory/owner-profile.md', mode: 'captured', keys: ['owner_email', 'owner_bio_short'] },
    { output: 'context/rules/APPROVED.md', mode: 'captured', keys: [] },
  ];
  const kept: EnrichRender = {
    written: ['CLAUDE.md'],
    skipped: ['context/SOUL.md', 'context/memory/owner-profile.md', 'context/rules/APPROVED.md'],
    changed: [],
  };

  it('names a changed key and the kept captured file that is its only home', () => {
    const lines = renderReport(kept, refs, ['owner_bio_short']);
    expect(lines).toEqual([
      '! owner_bio_short is only in context/memory/owner-profile.md (kept as you have it): move it aside and run `fortytwo enrich` to regenerate it',
    ]);
    expect(lines.join('\n')).not.toContain('APPROVED.md');
    expect(lines.join('\n')).not.toContain('SOUL.md');
  });

  it('says "also" when a managed file got the new value too, and lists changed files', () => {
    const lines = renderReport({ ...kept, changed: ['CLAUDE.md'] }, refs, ['agent_name']);
    expect(lines).toEqual([
      '✓ persona files updated: CLAUDE.md',
      '! agent_name is also in context/SOUL.md (kept as you have it): move it aside and run `fortytwo enrich` to regenerate it',
    ]);
  });

  it('flags a key no template uses, and says nothing for a regenerated file', () => {
    const regenerated: EnrichRender = { written: ['CLAUDE.md', 'context/memory/owner-profile.md'], skipped: [], changed: ['context/memory/owner-profile.md'] };
    expect(renderReport(regenerated, refs, ['owner_email', 'owner_x'])).toEqual([
      '✓ persona files updated: context/memory/owner-profile.md',
      '  owner_x: saved in .fortytwo/identity.json only (by design, no persona file shows it)',
    ]);
  });

  it('prints nothing when no file changed and no key changed', () => {
    expect(renderReport(kept, refs, [])).toEqual([]);
  });
});

describe('parseEnrichArgs', () => {
  it('parses --answers, rejects unknown options', () => {
    expect(parseEnrichArgs(['--answers', 'a.json'])).toEqual({ answersFile: 'a.json' });
    expect(parseEnrichArgs(['--answers'])).toEqual({ error: expect.stringMatching(/file path/) });
    expect(parseEnrichArgs(['--yes'])).toEqual({ error: 'unknown option --yes' });
  });

  it('rejects --all, which went away with the prompts', () => {
    expect(parseEnrichArgs(['--all'])).toEqual({ error: 'unknown option --all' });
  });
});

describe('runEnrich', () => {
  it('exits 2 on --all as an unknown flag', async () => {
    const write = process.stderr.write;
    let err = '';
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try {
      expect(await runEnrich(['--all'])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(err).toContain('enrich: unknown option --all');
  });
});

describe('performEnrich', () => {
  let out: string;
  let err: string;
  let saved: Identity | null;
  let renders: number;

  function identity(answers: Answers, extra: Partial<Identity> = {}): Identity {
    return { identityVersion: 1, answers, createdAt: 't', updatedAt: 't', ...extra };
  }

  function deps(over: Partial<EnrichDeps> = {}): EnrichDeps {
    return {
      readIdentity: () => identity({ agent_name: 'Ada', owner_email: '', owner_bio_short: '', owner_interests: [] }),
      writeIdentity: (i) => { saved = i; },
      fields: () => FIELDS,
      render: (): EnrichRender => {
        renders++;
        return { written: ['CLAUDE.md'], skipped: ['context/SOUL.md', 'context/rules/APPROVED.md'], changed: [] };
      },
      templateRefs: () => [
        { output: 'CLAUDE.md', mode: 'managed', keys: ['agent_name'] },
        { output: 'context/SOUL.md', mode: 'captured', keys: ['agent_name', 'owner_bio_short', 'owner_interests'] },
        { output: 'context/rules/APPROVED.md', mode: 'captured', keys: [] },
      ],
      readAnswersFile: () => ({}),
      out: (s) => { out += s; },
      err: (s) => { err += s; },
      ...over,
    };
  }

  beforeEach(() => { out = ''; err = ''; saved = null; renders = 0; });

  it('exits 2 without identity.json', async () => {
    expect(await performEnrich(deps({ readIdentity: () => null }), {})).toBe(2);
    expect(err).toMatch(/fortytwo init/);
  });

  it('exits 2 when persona is not installed', async () => {
    expect(await performEnrich(deps({ fields: () => { throw new Error('@justfortytwo/persona is not installed'); } }), {})).toBe(2);
    expect(err).toMatch(/persona is not installed/);
  });

  it('without options: lists the empty fields by topic, renders, points to the assistant, saves nothing', async () => {
    expect(await performEnrich(deps(), {})).toBe(0);
    expect(out).toBe([
      'enrich: 3 persona field(s) still empty.',
      '',
      'context/SOUL.md (2)',
      '  owner_bio_short, owner_interests',
      '',
      'contact (saved in identity.json only) (1)',
      '  owner_email',
      '',
      NEXT_STEP,
      '',
    ].join('\n'));
    expect(saved).toBeNull();
    expect(renders).toBe(1);
  });

  it('without options: fills holes from a newer persona for the render only', async () => {
    let rendered: Identity | null = null;
    const r = await performEnrich(deps({
      readIdentity: () => identity({ agent_name: 'Ada' }),
      render: (i) => { rendered = i; return { written: [], skipped: [], changed: [] }; },
    }), {});
    expect(r).toBe(0);
    expect(rendered!.answers).toEqual({ agent_name: 'Ada', owner_email: '', owner_bio_short: '', owner_interests: [] });
    expect(saved).toBeNull();
  });

  it('without options: says so when nothing is empty, still renders, no next step', async () => {
    const full = identity({ agent_name: 'Ada', owner_email: 'a@b.c', owner_bio_short: 'b', owner_interests: ['x'] });
    expect(await performEnrich(deps({ readIdentity: () => full }), {})).toBe(0);
    expect(out).toBe('enrich: every persona field has a value.\n');
    expect(renders).toBe(1);
  });

  it('--answers saves the values, prints the changes and re-renders', async () => {
    const r = await performEnrich(deps({ readAnswersFile: () => ({ owner_bio_short: 'Builder.', agent_name: 'X' }) }), { answersFile: 'a.json' });
    expect(r).toBe(0);
    expect(saved?.answers.owner_bio_short).toBe('Builder.');
    expect(saved?.answers.agent_name).toBe('Ada');
    expect(out).toMatch(/skipped 1 field\(s\) that already have a value; to change one, ask your assistant .*: agent_name/);
    expect(out).toContain('+ owner_bio_short: Builder.');
    expect(out).toContain('! owner_bio_short is only in context/SOUL.md (kept as you have it)');
    expect(out).not.toContain('APPROVED.md');
    expect(out).not.toContain(NEXT_STEP);
    expect(renders).toBe(1);
  });

  it('--answers says so, saves nothing, and still renders when nothing changed', async () => {
    expect(await performEnrich(deps(), { answersFile: 'a.json' })).toBe(0);
    expect(out).toMatch(/nothing changed in \.fortytwo\/identity\.json/);
    expect(saved).toBeNull();
    expect(renders).toBe(1);
  });

  it('--answers with nothing empty reports the set keys, says so and renders', async () => {
    const full = identity({ agent_name: 'Ada', owner_email: 'a@b.c', owner_bio_short: 'b', owner_interests: ['x'] });
    const r = await performEnrich(deps({ readIdentity: () => full, readAnswersFile: () => ({ owner_email: 'new@b.c', nope: 1 }) }), { answersFile: 'a.json' });
    expect(r).toBe(0);
    expect(out).toContain('already have a value; to change one, ask your assistant ("help me fill in my profile") and run fortytwo onboard: owner_email');
    expect(out).toContain('not persona fields: nope');
    expect(out).toMatch(/every persona field has a value/);
    expect(saved).toBeNull();
    expect(renders).toBe(1);
  });

  it('--answers with nothing empty still exits 2 on a missing or malformed file', async () => {
    const full = identity({ agent_name: 'Ada', owner_email: 'a@b.c', owner_bio_short: 'b', owner_interests: ['x'] });
    expect(await performEnrich(deps({ readIdentity: () => full, readAnswersFile: () => { throw new Error('no such file'); } }), { answersFile: 'a.json' })).toBe(2);
    expect(err).toMatch(/cannot read a\.json: no such file/);
    expect(await performEnrich(deps({ readIdentity: () => full, readAnswersFile: () => ['x'] }), { answersFile: 'a.json' })).toBe(2);
    expect(err).toMatch(/a\.json: the answers file must hold a JSON object/);
    expect(renders).toBe(0);
  });

  it('--answers never replaces a set value and keeps its onboard provenance', async () => {
    const prov = { source: 'interview', date: '2026-11-20', observed: 'observed' } as const;
    const withProv = identity(
      { agent_name: 'Ada', owner_email: '', owner_bio_short: 'b', owner_interests: ['x'] },
      { profileProvenance: { owner_bio_short: prov } },
    );
    const r = await performEnrich(deps({
      readIdentity: () => withProv,
      readAnswersFile: () => ({ owner_email: 'new@b.c', owner_bio_short: 'replaced' }),
    }), { answersFile: 'a.json' });
    expect(r).toBe(0);
    expect(saved?.answers.owner_email).toBe('new@b.c');
    expect(saved?.answers.owner_bio_short).toBe('b');
    expect(saved?.profileProvenance).toEqual({ owner_bio_short: prov });
  });

  it('exits 2 on an unreadable answers file', async () => {
    const r = await performEnrich(deps({ readAnswersFile: () => { throw new Error('no such file'); } }), { answersFile: 'a.json' });
    expect(r).toBe(2);
    expect(err).toMatch(/cannot read a\.json: no such file/);
  });
});

describe('enrich against the real persona (sandbox)', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'fortytwo-enrich-'));
    linkEngineInto(dir);
    process.chdir(dir);
    // What init leaves behind: every field resolved (required ones filled), persona rendered.
    const { fields } = loadPersonaManifest(undefined, dir);
    const required: Record<string, unknown> = {
      agent_name: 'Ada', owner_name: 'Grace Hopper', owner_role: 'Engineer', owner_positioning: 'Pragmatic builder',
      owner_identity_summary: 'Builds compilers.', owner_values: ['clarity'], owner_expertise: ['compilers'],
      owner_boundaries: ['no hype'], owner_voice_tone: 'dry',
    };
    const { answers, missingRequired } = resolveAnswers(fields, { answersFile: required });
    expect(missingRequired).toEqual([]);
    const identity: Identity = { identityVersion: 1, answers, createdAt: 't', updatedAt: 't' };
    writeIdentity(identity, dir);
    renderPersona(identity, { root: dir });
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function capture(): { deps: EnrichDeps; text: () => string } {
    let out = '';
    return { deps: { ...enrichDeps(dir), out: (s) => { out += s; }, err: (s) => { out += s; } }, text: () => out };
  }

  it('lists every empty field once, by topic, with email and address under contact', async () => {
    const manifest = loadPersonaManifest(undefined, dir);
    const empty = emptyFields(manifest.fields, readIdentity(dir)!.answers);
    expect(empty.every((f) => !f.required)).toBe(true);

    const { deps, text } = capture();
    expect(await performEnrich(deps, {})).toBe(0);
    const out = text();
    expect(out).toContain(`enrich: ${empty.length} persona field(s) still empty.`);
    expect(out).toContain(`${CONTACT_TOPIC} (2)\n  owner_email, owner_address\n`);
    expect(out).toContain('context/memory/owner-profile.md (');
    expect(out.trimEnd().endsWith(NEXT_STEP)).toBe(true);
    for (const f of empty) expect(out.match(new RegExp(`\\b${f.key}\\b`, 'g')), f.key).toHaveLength(1);
    expect(out).not.toMatch(/persona files updated/);
  });

  it('--answers saves values and never overwrites a captured file', async () => {
    const manifest = loadPersonaManifest(undefined, dir);
    const captured = manifest.files.find((f) => f.mode === 'captured')!;
    const capturedPath = join(dir, captured.output);
    mkdirSync(join(capturedPath, '..'), { recursive: true });
    writeFileSync(capturedPath, 'my own edits\n');

    writeFileSync(join(dir, 'more.json'), JSON.stringify({ owner_email: 'grace@example.org' }));
    const { deps, text } = capture();
    expect(await performEnrich(deps, { answersFile: 'more.json' })).toBe(0);
    const out = text();

    expect(readIdentity(dir)!.answers.owner_email).toBe('grace@example.org');
    expect(readFileSync(capturedPath, 'utf8')).toBe('my own edits\n');
    expect(out).toContain('+ owner_email: grace@example.org');
    // The persona manifest asks for owner_email but no template renders it.
    expect(out).toContain('owner_email: saved in .fortytwo/identity.json only (by design, no persona file shows it)');
    expect(out).not.toContain(captured.output);
    expect(out).not.toMatch(/written/);
    for (const f of manifest.files.filter((x) => x.mode === 'managed')) expect(existsSync(join(dir, f.output))).toBe(true);
  });

  it('a bare run regenerates a captured file the owner moved aside', async () => {
    const profile = join(dir, 'context/memory/owner-profile.md');
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ owner_bio_short: 'Wrote the first compiler.' }));
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0);
    expect(readFileSync(profile, 'utf8')).not.toContain('Wrote the first compiler.');

    renameSync(profile, `${profile}.bak`);
    const { deps, text } = capture();
    expect(await performEnrich(deps, {})).toBe(0);
    expect(text()).toContain('✓ persona files updated: context/memory/owner-profile.md');
    expect(readFileSync(profile, 'utf8')).toContain('Wrote the first compiler.');
    expect(readFileSync(`${profile}.bak`, 'utf8')).not.toContain('Wrote the first compiler.');
  });

  it('runEnrich --answers works without a terminal', async () => {
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ owner_bio_short: 'Wrote the first compiler.' }));
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0);
    expect(readIdentity(dir)!.answers.owner_bio_short).toBe('Wrote the first compiler.');
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0); // same value again: nothing to change
  });
});
