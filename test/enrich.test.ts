// enrich.test.ts — `fortytwo enrich`: which fields are asked (pendingFields),
// prompting (askFields), the --answers file, merging, the command flow with
// injected deps, and one run against the real @justfortytwo/persona in a
// mkdtempSync sandbox (identity.json updated, a captured file kept).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pendingFields, askFields, answersFromFile, mergeAnswers, formatAnswerChange, parseEnrichArgs, performEnrich, enrichDeps,
  runEnrich, renderReport, PromptEnd, type EnrichDeps, type EnrichRender, type TemplateRef,
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

/** An `ask` that replays scripted answers and records the prompts. */
function scripted(answers: (string | PromptEnd)[]): { ask: (q: string) => Promise<string>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    ask: async (q) => {
      prompts.push(q);
      const a = answers.shift() ?? '';
      if (a instanceof PromptEnd) throw a;
      return a;
    },
  };
}

describe('pendingFields', () => {
  it('returns the empty or absent fields in manifest order', () => {
    const answers: Answers = { agent_name: 'Ada', owner_email: '  ', owner_interests: [] };
    expect(pendingFields(FIELDS, answers).map((f) => f.key)).toEqual(['owner_email', 'owner_bio_short', 'owner_interests']);
  });

  it('returns every field with all', () => {
    expect(pendingFields(FIELDS, { agent_name: 'Ada' }, { all: true })).toHaveLength(4);
  });

  it('does not treat an inherited property as a value', () => {
    expect(pendingFields([{ key: 'toString', prompt: 'x', type: 'string' }], {}).map((f) => f.key)).toEqual(['toString']);
  });
});

describe('askFields', () => {
  it('keeps typed answers, skips blank ones, and collects lists item by item', async () => {
    const { ask } = scripted(['ada@example.org', '', 'chess', 'jazz', '']);
    const { updates, stopped } = await askFields(FIELDS.slice(1), {}, ask);
    expect(updates).toEqual({ owner_email: 'ada@example.org', owner_interests: ['chess', 'jazz'] });
    expect(stopped).toBe(false);
  });

  it('shows the current value and keeps it on Enter', async () => {
    const { ask, prompts } = scripted(['', '']);
    const { updates } = await askFields(
      [FIELDS[0]!, FIELDS[3]!],
      { agent_name: 'Ada', owner_interests: ['chess'] },
      ask,
    );
    expect(updates).toEqual({});
    expect(prompts[0]).toContain('[Ada]');
    expect(prompts[1]).toContain('current: chess');
  });

  it('stops on "." and keeps what was answered before it', async () => {
    const { ask, prompts } = scripted(['ada@example.org', '.', 'never asked']);
    const { updates, stopped } = await askFields(FIELDS.slice(1), {}, ask);
    expect(updates).toEqual({ owner_email: 'ada@example.org' });
    expect(stopped).toBe(true);
    expect(prompts).toHaveLength(2);
  });
});

describe('askFields on Ctrl+D / Ctrl+C', () => {
  it('treats Ctrl+D like "." and keeps the answers so far, list items included', async () => {
    const { ask, prompts } = scripted(['ada@example.org', '', 'chess', new PromptEnd('eof'), 'never asked']);
    const { updates, stopped } = await askFields(FIELDS.slice(1), {}, ask);
    expect(updates).toEqual({ owner_email: 'ada@example.org', owner_interests: ['chess'] });
    expect(stopped).toBe(true);
    expect(prompts).toHaveLength(4);
  });

  it('lets Ctrl+C through as a cancel', async () => {
    const { ask } = scripted(['ada@example.org', new PromptEnd('cancel')]);
    await expect(askFields(FIELDS.slice(1), {}, ask)).rejects.toMatchObject({ kind: 'cancel' });
  });
});

describe('answersFromFile', () => {
  it('takes pending fields, coerces lists, and reports other keys', () => {
    const r = answersFromFile(FIELDS.slice(1), {
      owner_email: 'ada@example.org',
      owner_interests: 'chess, jazz',
      owner_bio_short: '',
      agent_name: 'Other',
      nope: 'x',
    });
    expect(r).toEqual({
      updates: { owner_email: 'ada@example.org', owner_interests: ['chess', 'jazz'] },
      ignored: ['agent_name', 'nope'],
    });
  });

  it('cleans list values: string/number items only, trimmed, blanks dropped; nothing usable is ignored', () => {
    const lists: PersonaManifestField[] = [
      { key: 'a', prompt: 'a', type: 'list' },
      { key: 'b', prompt: 'b', type: 'list' },
      { key: 'c', prompt: 'c', type: 'list' },
      { key: 'd', prompt: 'd', type: 'list' },
      { key: 'e', prompt: 'e', type: 'list' },
    ];
    const r = answersFromFile(lists, {
      a: ['  chess ', 42, '', '   ', null, { x: 1 }, ['nested'], true],
      b: [' ', null],
      c: 7,
      d: { x: 1 },
      e: '',
    });
    expect(r).toEqual({ updates: { a: ['chess', '42'] }, ignored: ['b', 'c', 'd', 'e'] });
  });

  it('rejects anything but an object', () => {
    expect(answersFromFile(FIELDS, ['x'])).toEqual({ error: expect.stringMatching(/JSON object/) });
  });
});

describe('mergeAnswers', () => {
  it('reports only real changes and leaves the input untouched', () => {
    const answers: Answers = { agent_name: 'Ada', owner_email: '', owner_bio_short: '', owner_interests: ['chess'] };
    const r = mergeAnswers(FIELDS, answers, { agent_name: 'Ada', owner_email: 'ada@example.org', owner_interests: ['go'] });
    expect(r.changes).toEqual([
      { key: 'owner_email', after: 'ada@example.org' },
      { key: 'owner_interests', before: ['chess'], after: ['go'] },
    ]);
    expect(r.answers.owner_email).toBe('ada@example.org');
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
  it('marks new and replaced values', () => {
    expect(formatAnswerChange({ key: 'owner_email', after: 'a@b.c' })).toBe('  + owner_email: a@b.c');
    expect(formatAnswerChange({ key: 'owner_interests', before: ['a'], after: ['b', 'c'] })).toBe('  ~ owner_interests: a -> b; c');
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
      '! owner_x is not used by any persona file',
    ]);
  });

  it('prints nothing when no file changed and no key changed', () => {
    expect(renderReport(kept, refs, [])).toEqual([]);
  });
});

describe('parseEnrichArgs', () => {
  it('parses --all and --answers, rejects unknown options', () => {
    expect(parseEnrichArgs(['--all', '--answers', 'a.json'])).toEqual({ all: true, answersFile: 'a.json' });
    expect(parseEnrichArgs(['--answers'])).toEqual({ error: expect.stringMatching(/file path/) });
    expect(parseEnrichArgs(['--yes'])).toEqual({ error: 'unknown option --yes' });
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
        { output: 'context/SOUL.md', mode: 'captured', keys: ['agent_name', 'owner_email'] },
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

  it('exits 2 without a terminal or an answers file', async () => {
    expect(await performEnrich(deps(), {})).toBe(2);
    expect(err).toMatch(/needs a terminal/);
    expect(saved).toBeNull();
  });

  it('saves the answers, prints the changes and re-renders', async () => {
    const { ask } = scripted(['ada@example.org', '', '']);
    expect(await performEnrich(deps({ ask }), {})).toBe(0);
    expect(saved?.answers.owner_email).toBe('ada@example.org');
    expect(out).toContain('+ owner_email: ada@example.org');
    expect(out).toContain('! owner_email is only in context/SOUL.md (kept as you have it)');
    expect(out).not.toContain('APPROVED.md');
    expect(out).not.toMatch(/written/);
    expect(renders).toBe(1);
  });

  it('says so, saves nothing, and still renders when nothing changed', async () => {
    const { ask } = scripted([]);
    expect(await performEnrich(deps({ ask }), {})).toBe(0);
    expect(out).toMatch(/nothing changed in \.fortytwo\/identity\.json/);
    expect(saved).toBeNull();
    expect(renders).toBe(1);
  });

  it('cancels on Ctrl+C: exit 130, nothing saved or rendered', async () => {
    const { ask } = scripted(['ada@example.org', new PromptEnd('cancel')]);
    expect(await performEnrich(deps({ ask }), {})).toBe(130);
    expect(err).toContain('enrich: cancelled, nothing saved');
    expect(saved).toBeNull();
    expect(renders).toBe(0);
  });

  it('saves the answers so far on Ctrl+D', async () => {
    const { ask } = scripted(['ada@example.org', new PromptEnd('eof')]);
    expect(await performEnrich(deps({ ask }), {})).toBe(0);
    expect(saved?.answers.owner_email).toBe('ada@example.org');
  });

  it('has nothing to ask when every field is set, unless --all', async () => {
    const full = identity({ agent_name: 'Ada', owner_email: 'a@b.c', owner_bio_short: 'b', owner_interests: ['x'] });
    expect(await performEnrich(deps({ readIdentity: () => full }), {})).toBe(0);
    expect(out).toMatch(/every persona field has a value/);
    expect(renders).toBe(1);

    const { ask } = scripted(['Grace', '', '', '']);
    expect(await performEnrich(deps({ readIdentity: () => full, ask }), { all: true })).toBe(0);
    expect(saved?.answers.agent_name).toBe('Grace');
    expect(out).toContain('~ agent_name: Ada -> Grace');
  });

  it('drops the onboard provenance of a value it replaces', async () => {
    const prov = { source: 'interview', date: '2026-11-20', observed: 'observed' } as const;
    const withProv = identity(
      { agent_name: 'Ada', owner_email: 'old@b.c', owner_bio_short: 'b', owner_interests: ['x'] },
      { profileProvenance: { owner_email: prov, owner_bio_short: prov } },
    );
    const { ask } = scripted(['', 'new@b.c', '', '']);
    expect(await performEnrich(deps({ readIdentity: () => withProv, ask }), { all: true })).toBe(0);
    expect(saved?.profileProvenance).toEqual({ owner_bio_short: prov });
  });

  it('reads an answers file without prompting', async () => {
    const r = await performEnrich(deps({ readAnswersFile: () => ({ owner_bio_short: 'Builder.', agent_name: 'X' }) }), { answersFile: 'a.json' });
    expect(r).toBe(0);
    expect(saved?.answers.owner_bio_short).toBe('Builder.');
    expect(saved?.answers.agent_name).toBe('Ada');
    expect(out).toMatch(/ignored 1 key\(s\).*agent_name/);
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

  it('saves injected answers and never overwrites a captured file', async () => {
    const manifest = loadPersonaManifest(undefined, dir);
    const captured = manifest.files.find((f) => f.mode === 'captured')!;
    const capturedPath = join(dir, captured.output);
    mkdirSync(join(capturedPath, '..'), { recursive: true });
    writeFileSync(capturedPath, 'my own edits\n');

    const pending = pendingFields(manifest.fields, readIdentity(dir)!.answers);
    expect(pending.map((f) => f.key)).toContain('owner_email');
    expect(pending.every((f) => !f.required)).toBe(true);

    // Answer the first pending field (owner_email), then stop.
    const { ask } = scripted(['grace@example.org', '.']);
    let out = '';
    const code = await performEnrich({ ...enrichDeps(dir), ask, out: (s) => { out += s; }, err: (s) => { out += s; } }, {});
    expect(code).toBe(0);

    expect(readIdentity(dir)!.answers.owner_email).toBe('grace@example.org');
    expect(readFileSync(capturedPath, 'utf8')).toBe('my own edits\n');
    expect(out).toContain('+ owner_email: grace@example.org');
    // The persona manifest asks for owner_email but no template renders it.
    expect(out).toContain('! owner_email is not used by any persona file');
    expect(out).not.toContain(captured.output);
    expect(out).not.toMatch(/written/);
    for (const f of manifest.files.filter((x) => x.mode === 'managed')) expect(existsSync(join(dir, f.output))).toBe(true);
  });

  it('regenerates a captured file the owner moved aside, even with nothing to ask', async () => {
    const profile = join(dir, 'context/memory/owner-profile.md');
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ owner_bio_short: 'Wrote the first compiler.' }));
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0);
    expect(readFileSync(profile, 'utf8')).not.toContain('Wrote the first compiler.');

    renameSync(profile, `${profile}.bak`);
    let out = '';
    const deps = { ...enrichDeps(dir), out: (s: string) => { out += s; } };
    // Empty answers file: nothing changes in identity.json, the render still runs.
    writeFileSync(join(dir, 'none.json'), '{}');
    expect(await performEnrich(deps, { answersFile: 'none.json' })).toBe(0);
    expect(out).toContain('nothing changed in .fortytwo/identity.json');
    expect(out).toContain('✓ persona files updated: context/memory/owner-profile.md');
    expect(readFileSync(profile, 'utf8')).toContain('Wrote the first compiler.');
  });

  it('runEnrich --answers works without a terminal', async () => {
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ owner_bio_short: 'Wrote the first compiler.' }));
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0);
    expect(readIdentity(dir)!.answers.owner_bio_short).toBe('Wrote the first compiler.');
    expect(await runEnrich(['--answers', 'more.json'])).toBe(0); // same value again: nothing to change
  });
});
