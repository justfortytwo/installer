import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAnswers, mergeEnvContent, buildMcpConfig, buildVersionPins, engineInstallSpecs,
  collectChannelSecrets, resolveOllamaBaseUrl, ensureEmbedModel, EMBED_MODEL,
  askList, askMissingAnswers, listPromptLabel, readEnvValue,
  type ManifestField, type EmbedModelDeps,
} from '../src/commands/init.js';
import { readSelfCompatRanges, fetchOllamaModels, pullOllamaModel } from '../src/engine.js';
import { startFakeOllama } from './helpers/ollama.js';
import { loadPersonaManifest, renderTemplate } from '../src/render.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ft-init-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const fields: ManifestField[] = [
  { key: 'agent_name', prompt: 'p', type: 'string', required: true, default: null },
  { key: 'owner_timezone', prompt: 'p', type: 'string', required: true, default: 'UTC' },
  { key: 'owner_values', prompt: 'p', type: 'list', required: true, default: [] },
  { key: 'owner_bio_short', prompt: 'p', type: 'text', required: false, default: null },
];

describe('resolveAnswers', () => {
  it('resolves from answers-file > env > flags > manifest default', () => {
    const { answers } = resolveAnswers(fields, {
      answersFile: { agent_name: 'Aria' },
      env: { FORTYTWO_OWNER_TIMEZONE: 'Europe/Lisbon' },
      flags: {},
    });
    expect(answers.agent_name).toBe('Aria');               // from answers-file
    expect(answers.owner_timezone).toBe('Europe/Lisbon');  // from env (overrides default)
  });

  it('coerces a string source for a list field into an array (one per line)', () => {
    const { answers } = resolveAnswers(fields, { env: {}, flags: { owner_values: 'curiosity\nrigor' } });
    expect(answers.owner_values).toEqual(['curiosity', 'rigor']);
  });

  it('never yields null — optional null defaults become empty string/array so render never throws', () => {
    const { answers } = resolveAnswers(fields, { env: {}, flags: { agent_name: 'Aria', owner_values: 'x' } });
    expect(answers.owner_bio_short).toBe('');   // optional text, no value -> ''
    expect(answers.owner_timezone).toBe('UTC'); // default applied
  });

  it('reports required fields that were left empty', () => {
    const { missingRequired } = resolveAnswers(fields, { env: {}, flags: {} });
    expect(missingRequired).toEqual(expect.arrayContaining(['agent_name', 'owner_values']));
    expect(missingRequired).not.toContain('owner_timezone'); // has a default
  });
});

describe('mergeEnvContent', () => {
  it('updates existing keys, appends new ones, preserves unrelated lines', () => {
    const existing = '# comment\nFOO=keep\nTELEGRAM_BOT_TOKEN=old\n';
    const merged = mergeEnvContent(existing, { TELEGRAM_BOT_TOKEN: 'new', ALLOWED_CHAT_IDS: '123,456' });
    expect(merged).toMatch(/^# comment$/m);
    expect(merged).toMatch(/^FOO=keep$/m);
    expect(merged).toMatch(/^TELEGRAM_BOT_TOKEN=new$/m);
    expect(merged).toMatch(/^ALLOWED_CHAT_IDS=123,456$/m);
    expect(merged).not.toMatch(/TELEGRAM_BOT_TOKEN=old/);
  });

  it('produces a valid file from empty existing', () => {
    const merged = mergeEnvContent('', { EMBED_MODEL: 'qwen3-embedding:0.6b' });
    expect(merged).toBe('EMBED_MODEL=qwen3-embedding:0.6b\n');
  });
});

describe('buildMcpConfig', () => {
  it('adds the fortytwo-memory server, preserving existing servers', () => {
    const cfg = buildMcpConfig({ mcpServers: { other: { command: 'x' } } }, { dbPath: 'db/fortytwo.db' });
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers['fortytwo-memory']).toBeDefined();
    expect(JSON.stringify(cfg.mcpServers['fortytwo-memory'])).toMatch(/fortytwo-memory|@justfortytwo\/memory/);
  });

  it('threads the provided ollamaBaseUrl + embedModel into the memory server env', () => {
    const cfg = buildMcpConfig(null, {
      dbPath: 'db/fortytwo.db',
      ollamaBaseUrl: 'https://ollama.lab.example.com',
      embedModel: 'custom-embed:1b',
    });
    const mem = cfg.mcpServers['fortytwo-memory'] as { env: Record<string, string> };
    expect(mem.env.OLLAMA_BASE_URL).toBe('https://ollama.lab.example.com');
    expect(mem.env.EMBED_MODEL).toBe('custom-embed:1b');
    expect(mem.env.DB_PATH).toBe('db/fortytwo.db');
  });

  it('defaults the ollama base url to localhost when not provided', () => {
    const cfg = buildMcpConfig(null, { dbPath: 'db/fortytwo.db' });
    const mem = cfg.mcpServers['fortytwo-memory'] as { env: Record<string, string> };
    expect(mem.env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
  });
});

// Scripted readline: answers are consumed in order; records every prompt shown.
const scripted = (...answers: string[]) => {
  const prompts: string[] = [];
  const ask = async (q: string) => {
    prompts.push(q);
    if (answers.length === 0) throw new Error(`unexpected extra prompt: ${q}`);
    return answers.shift()!;
  };
  return { ask, prompts, remaining: answers };
};

describe('askList (one item per prompt, blank ends)', () => {
  it('one item + blank terminator', async () => {
    const s = scripted('Evidence over assumptions', '');
    expect(await askList('Operating values', s.ask)).toEqual(['Evidence over assumptions']);
    expect(s.prompts[0]).toBe('Operating values — enter one at a time.\nPress Enter on an empty line when done.\n> ');
    expect(s.prompts[1]).toBe('> ');
  });
  it('multiple items + blank terminator, in order, commas kept inside an item', async () => {
    const s = scripted('Min diff, less moving parts', '  Evidence over assumptions ', 'Prefer boring infrastructure', '');
    expect(await askList('Operating values', s.ask)).toEqual([
      'Min diff, less moving parts', 'Evidence over assumptions', 'Prefer boring infrastructure',
    ]);
  });
  it('immediately blank = [] for an optional list', async () => {
    expect(await askList('Interests', scripted('').ask)).toEqual([]);
  });
  it('a required list re-asks on an immediate blank instead of returning []', async () => {
    const s = scripted('', 'rigor', '');
    expect(await askList('Operating values', s.ask, { required: true })).toEqual(['rigor']);
    expect(s.prompts[1]).toContain('at least one is required');
  });
});

describe('askMissingAnswers', () => {
  const f = (key: string, type: ManifestField['type'], prompt: string): ManifestField =>
    ({ key, prompt, type, required: true, default: null });
  const fields = [
    f('owner_values', 'list', 'Your operating values and what you care about, one per line'),
    f('owner_expertise', 'list', 'Domains where you have real depth, one per line'),
    f('owner_voice_tone', 'string', 'Your tone in one short phrase'),
  ];

  it('does not consume the following question: each list stops at its own blank', async () => {
    const s = scripted('rigor', 'candor', '', 'systems', '', 'dry, precise');
    const answers: Record<string, unknown> = {};
    await askMissingAnswers(fields, ['owner_values', 'owner_expertise', 'owner_voice_tone'], answers as never, s.ask);
    expect(answers).toEqual({ owner_values: ['rigor', 'candor'], owner_expertise: ['systems'], owner_voice_tone: 'dry, precise' });
    expect(s.remaining).toEqual([]);
    expect(s.prompts.filter((p) => p.includes('enter one at a time'))).toHaveLength(2);
    expect(s.prompts.at(-1)).toBe('Your tone in one short phrase\n> ');
    expect(s.prompts.join('')).not.toMatch(/per line/i);
  });

  it('collected lists survive answer re-resolution and render in entry order', async () => {
    const answers: Record<string, unknown> = {};
    await askMissingAnswers(fields.slice(0, 1), ['owner_values'], answers as never, scripted('b, with comma', 'a', '').ask);
    // runInit re-resolves the prompted answers before persisting/rendering
    const { answers: resolved } = resolveAnswers(fields.slice(0, 1), { answersFile: answers, env: {}, flags: {} });
    expect(resolved.owner_values).toEqual(['b, with comma', 'a']);
    expect(renderTemplate('- {{owner_values}}', resolved)).toBe('- b, with comma\n- a');
  });
});

describe('listPromptLabel', () => {
  it('drops the "one per line" hint the single-line prompt cannot honor', () => {
    expect(listPromptLabel('Domains where you have real depth, one per line')).toBe('Domains where you have real depth');
    expect(listPromptLabel('The typical shape your pieces take, one step per line')).toBe('The typical shape your pieces take');
    expect(listPromptLabel('Already clean')).toBe('Already clean');
  });
  it('leaves no "per line" wording on any list prompt of the real persona manifest', () => {
    const lists = loadPersonaManifest().fields.filter((x) => x.type === 'list');
    expect(lists.length).toBeGreaterThan(0);
    for (const x of lists) expect(listPromptLabel(x.prompt), x.key).not.toMatch(/per line/i);
  });
});

describe('resolveOllamaBaseUrl', () => {
  const asker = (...answers: string[]) => {
    const prompts: string[] = [];
    const ask = async (q: string) => { prompts.push(q); return answers.shift() ?? ''; };
    return { ask, prompts };
  };

  it('Enter (empty input) -> http://localhost:11434', async () => {
    const { ask, prompts } = asker('');
    expect(await resolveOllamaBaseUrl({ ask })).toBe('http://localhost:11434');
    expect(prompts[0]).toMatch(/Ollama base URL.*Enter for http:\/\/localhost:11434/);
  });
  it('a custom URL is used exactly as entered', async () => {
    const { ask } = asker('  http://ollama:11434  ');
    expect(await resolveOllamaBaseUrl({ ask })).toBe('http://ollama:11434');
  });
  it('an inherited OLLAMA_BASE_URL env becomes the prompt default', async () => {
    const { ask, prompts } = asker('');
    expect(await resolveOllamaBaseUrl({ env: 'http://ollama:11434', ask })).toBe('http://ollama:11434');
    expect(prompts[0]).toContain('Enter for http://ollama:11434');
  });
  it('the user can still override the env default', async () => {
    const { ask } = asker('https://gpu-box.lan:11434');
    expect(await resolveOllamaBaseUrl({ env: 'http://ollama:11434', ask })).toBe('https://gpu-box.lan:11434');
  });
  it('an explicit --ollama-base-url wins and is not re-asked', async () => {
    const { ask, prompts } = asker('http://ignored:1');
    expect(await resolveOllamaBaseUrl({ flag: 'http://flag:11434', env: 'http://env:11434', ask })).toBe('http://flag:11434');
    expect(prompts).toEqual([]);
  });
  it('re-run: the URL saved in .env is the Enter default (custom endpoint survives)', async () => {
    const { ask, prompts } = asker('');
    expect(await resolveOllamaBaseUrl({ saved: 'http://ollama:11434', ask })).toBe('http://ollama:11434');
    expect(prompts[0]).toContain('Enter for http://ollama:11434');
  });
  it('an explicit OLLAMA_BASE_URL env beats the saved .env value; the flag beats both', async () => {
    expect(await resolveOllamaBaseUrl({ env: 'http://env:1', saved: 'http://saved:1' })).toBe('http://env:1');
    expect(await resolveOllamaBaseUrl({ flag: 'http://flag:1', env: 'http://env:1', saved: 'http://saved:1' })).toBe('http://flag:1');
    expect(await resolveOllamaBaseUrl({ saved: 'http://saved:1' })).toBe('http://saved:1'); // --yes re-run
  });
  it('non-interactive (no ask): env, else localhost', async () => {
    expect(await resolveOllamaBaseUrl({ env: 'http://ollama:11434' })).toBe('http://ollama:11434');
    expect(await resolveOllamaBaseUrl({})).toBe('http://localhost:11434');
  });
  it('re-asks on a non-http(s) answer, then gives up after 3 tries', async () => {
    const retry = asker('ollama:11434', 'http://ollama:11434');
    expect(await resolveOllamaBaseUrl({ ask: retry.ask })).toBe('http://ollama:11434');
    expect(retry.prompts[1]).toContain('not an http(s) URL');
    await expect(resolveOllamaBaseUrl({ ask: asker('x', 'y', 'z').ask })).rejects.toThrow(/no valid Ollama base URL/);
  });
});

describe('readEnvValue', () => {
  it('reads a key from .env content (last wins, quotes stripped, absent/blank -> undefined)', () => {
    expect(readEnvValue('A=1\nOLLAMA_BASE_URL=http://ollama:11434\nB=2\n', 'OLLAMA_BASE_URL')).toBe('http://ollama:11434');
    expect(readEnvValue('OLLAMA_BASE_URL=http://a:1\r\nOLLAMA_BASE_URL="http://b:1"\r\n', 'OLLAMA_BASE_URL')).toBe('http://b:1');
    expect(readEnvValue('# OLLAMA_BASE_URL=http://x:1\nXOLLAMA_BASE_URL=http://y:1\n', 'OLLAMA_BASE_URL')).toBeUndefined();
    expect(readEnvValue('OLLAMA_BASE_URL=\n', 'OLLAMA_BASE_URL')).toBeUndefined();
  });
});

describe('ensureEmbedModel (uses the selected endpoint)', () => {
  const fakes = (models: string[] | null, pullErr: string | null = null) => {
    const calls = { list: [] as string[], pull: [] as [string, string][] };
    const deps: EmbedModelDeps = {
      listModels: async (u) => { calls.list.push(u); return models; },
      pullModel: async (u, m) => { calls.pull.push([u, m]); return pullErr; },
      log: () => {},
    };
    return { deps, calls };
  };

  it('model already on the server: checks that URL, does not pull', async () => {
    const { deps, calls } = fakes([EMBED_MODEL]);
    expect(await ensureEmbedModel('http://ollama:11434', EMBED_MODEL, deps)).toBe(`✓ embedder ${EMBED_MODEL} available at http://ollama:11434`);
    expect(calls).toEqual({ list: ['http://ollama:11434'], pull: [] });
  });
  it('model missing: pulls it on that same URL', async () => {
    const { deps, calls } = fakes([]);
    expect(await ensureEmbedModel('http://ollama:11434', EMBED_MODEL, deps)).toMatch(/^✓ pulled/);
    expect(calls.pull).toEqual([['http://ollama:11434', EMBED_MODEL]]);
  });
  it('unreachable: warns naming the URL, never pulls', async () => {
    const { deps, calls } = fakes(null);
    expect(await ensureEmbedModel('http://ollama:11434', EMBED_MODEL, deps)).toMatch(/^! Ollama unreachable at http:\/\/ollama:11434/);
    expect(calls.pull).toEqual([]);
  });
  it('pull failure is warn-only and reports the error', async () => {
    const { deps } = fakes([], 'disk full');
    expect(await ensureEmbedModel('http://ollama:11434', EMBED_MODEL, deps)).toMatch(/^! could not pull .* via http:\/\/ollama:11434: disk full/);
  });
});

describe('Ollama HTTP calls hit the given base URL', () => {
  it('lists, pulls (streamed NDJSON) and surfaces errors against that server', async () => {
    const ok = await startFakeOllama({ models: [] });
    const bad = await startFakeOllama({ pullError: 'manifest unknown' });
    try {
      expect(await ensureEmbedModel(`${ok.url}/`, EMBED_MODEL, { listModels: fetchOllamaModels, pullModel: pullOllamaModel, log: () => {} }))
        .toBe(`✓ pulled ${EMBED_MODEL} on ${ok.url}/`);
      expect(ok.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/tags', 'POST /api/pull']);
      expect(JSON.parse(ok.requests[1]!.body)).toMatchObject({ model: EMBED_MODEL });
      expect(await fetchOllamaModels(ok.url)).toEqual([EMBED_MODEL]);
      expect(await pullOllamaModel(bad.url, EMBED_MODEL)).toBe('manifest unknown');
      expect(await fetchOllamaModels('http://127.0.0.1:1')).toBeNull();
    } finally {
      await ok.close();
      await bad.close();
    }
  });
});

describe('collectChannelSecrets', () => {
  it('captures both channel secrets when answered', async () => {
    const answers = ['123:ABC', '555,666'];
    const asked: string[] = [];
    const ask = async (q: string): Promise<string> => { asked.push(q); return answers.shift() ?? ''; };
    expect(await collectChannelSecrets({}, ask)).toEqual({
      TELEGRAM_BOT_TOKEN: '123:ABC',
      ALLOWED_CHAT_IDS: '555,666',
    });
    expect(asked).toHaveLength(2);
  });

  it('skips a secret when the answer is blank', async () => {
    const ask = async (): Promise<string> => '   ';
    expect(await collectChannelSecrets({}, ask)).toEqual({});
  });

  it('does not prompt for a secret already provided via flags/env', async () => {
    const asked: string[] = [];
    const ask = async (q: string): Promise<string> => { asked.push(q); return '555'; };
    expect(await collectChannelSecrets({ TELEGRAM_BOT_TOKEN: 'preset' }, ask)).toEqual({
      ALLOWED_CHAT_IDS: '555',
    });
    expect(asked).toHaveLength(1); // only the chat-ids prompt
  });
});

describe('engineInstallSpecs', () => {
  const ranges = {
    '@justfortytwo/gate': '^0.1.0',
    '@justfortytwo/memory': '^0.1.0',
    '@justfortytwo/persona': '^0.1.0',
    '@justfortytwo/telegram': '^0.1.0',
  };

  it('returns name@range for engine packages not yet resolvable', () => {
    const present = new Set(['@justfortytwo/gate']);
    expect(engineInstallSpecs(ranges, (s) => present.has(s))).toEqual([
      '@justfortytwo/memory@^0.1.0',
      '@justfortytwo/persona@^0.1.0',
      '@justfortytwo/telegram@^0.1.0',
    ]);
  });

  it('returns [] when every engine package is already present (no redundant install)', () => {
    expect(engineInstallSpecs(ranges, () => true)).toEqual([]);
  });
});

describe('declared engine compat', () => {
  it('includes @justfortytwo/scheduler so `init` auto-installs the scheduler daemon', () => {
    const compat = readSelfCompatRanges();
    expect(Object.keys(compat)).toContain('@justfortytwo/scheduler');
    // engineInstallSpecs over the real compat (nothing present) must offer scheduler.
    expect(engineInstallSpecs(compat, () => false)).toContain(`@justfortytwo/scheduler@${compat['@justfortytwo/scheduler']}`);
  });
  it('pins telegram to the exact 1.0.0-1 pre-release; runner stays transitive', () => {
    const compat = readSelfCompatRanges();
    expect(compat['@justfortytwo/telegram']).toBe('1.0.0-1');
    expect(engineInstallSpecs(compat, () => false)).toContain('@justfortytwo/telegram@1.0.0-1');
    expect(Object.keys(compat)).not.toContain('@justfortytwo/runner');
  });
  it('pins scheduler 1.0.0-1: 1.0.0-0 declares a telegram peer that rejects telegram 1.0.0-1 (ERESOLVE)', () => {
    expect(readSelfCompatRanges()['@justfortytwo/scheduler']).toBe('1.0.0-1');
  });
  it('pins persona to the exact 1.0.0-0 pre-release (a caret would never select it)', () => {
    expect(readSelfCompatRanges()['@justfortytwo/persona']).toBe('1.0.0-0');
  });
  it('keeps fortytwo.compat the only engine version list (no deps/peerDeps on @justfortytwo/*)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(pkg[field] ?? {}).filter((n) => n.startsWith('@justfortytwo/'))).toEqual([]);
    }
  });
});

describe('buildVersionPins', () => {
  it('pins installed siblings against their declared ranges; skips the absent', () => {
    const pins = buildVersionPins(
      { '@justfortytwo/gate': '^0.1.0', '@justfortytwo/memory': '^0.1.0', '@justfortytwo/telegram': '^0.1.0' },
      (spec) => ({ '@justfortytwo/gate': '0.1.0', '@justfortytwo/memory': '0.1.2' } as Record<string, string>)[spec] ?? null,
    );
    expect(pins).toEqual([
      { name: '@justfortytwo/gate', range: '^0.1.0', resolved: '0.1.0' },
      { name: '@justfortytwo/memory', range: '^0.1.0', resolved: '0.1.2' },
    ]);
  });
});

// Smoke: a fully-resolved answer set + the real persona templates renders a project.
describe('init scaffolding (integration-lite)', () => {
  it('writeEnv + buildMcpConfig produce gitignorable files under the project root', () => {
    writeFileSync(join(dir, '.env'), 'FOO=1\n');
    const merged = mergeEnvContent(readFileSync(join(dir, '.env'), 'utf8'), { ALLOWED_CHAT_IDS: '42' });
    writeFileSync(join(dir, '.env'), merged);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/ALLOWED_CHAT_IDS=42/);
    expect(existsSync(join(dir, '.env'))).toBe(true);
  });
});
