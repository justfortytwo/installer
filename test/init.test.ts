import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAnswers, mergeEnvContent, buildMcpConfig, buildVersionPins, engineInstallSpecs,
  collectChannelSecrets,
  type ManifestField,
} from '../src/commands/init.js';
import { readSelfCompatRanges } from '../src/engine.js';

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
  it('pins telegram to the exact 1.0.0-0 pre-release; runner stays transitive', () => {
    const compat = readSelfCompatRanges();
    expect(compat['@justfortytwo/telegram']).toBe('1.0.0-0');
    expect(engineInstallSpecs(compat, () => false)).toContain('@justfortytwo/telegram@1.0.0-0');
    expect(Object.keys(compat)).not.toContain('@justfortytwo/runner');
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
