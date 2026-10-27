// transcript-migration.test.ts — moving chat rows out of memory into the transcript.
//
// Real memory, transcript and persona packages on a temp project and a temp DB:
// the migration moves live user data, so nothing here is mocked except the one
// injected failing delete that simulates a crash between import and delete.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateChatToTranscript } from '../src/transcript-migration.js';
import { reconcileRuntime } from '../src/commands/update.js';
import { findSiblingDir, loadSibling } from '../src/engine.js';
import { linkEngineInto } from './helpers/engine.js';

const DB = 'db/t.db';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

interface Seed { content: string; source: string; tags?: string[]; meta?: Record<string, unknown>; observed?: string }
const SEEDS: Seed[] = [
  { content: 'owner likes green tea', source: 'owner', observed: 'stated' },
  { content: 'zebracorn hello there', source: 'telegram:owner', tags: ['telegram', 'inbound', 'message'],
    meta: { chat_id: 42, direction: 'inbound', kind: 'message', actor: 'owner', thread_id: 't-1' } },
  { content: 'zebracorn reply from assistant', source: 'telegram:assistant', tags: ['telegram', 'outbound', 'message'],
    meta: { direction: 'outbound', kind: 'message', actor: 'assistant' } },
  { content: 'shell output kept', source: 'tool:shell' },
  { content: '[scheduler:reminder] zebracorn buy milk', source: 'scheduler:wake', tags: ['scheduler', 'reminder'], observed: 'internal' },
  { content: 'web page kept', source: 'web' },
  { content: 'zebracorn legacy owner without meta', source: 'telegram:owner' },
  { content: 'zebracorn legacy assistant without meta', source: 'telegram:assistant' },
];
const CHAT = (s: { source: string }) => s.source.startsWith('telegram:') || s.source === 'scheduler:wake';

async function fixture(extraChat = 0) {
  const root = mkdtempSync(join(tmpdir(), 'transcript-migration-')); roots.push(root); linkEngineInto(root);
  mkdirSync(join(root, 'db')); mkdirSync(join(root, '.fortytwo'));
  writeFileSync(join(root, '.env'), `DB_PATH=${DB}\n`);
  const files: string[] = JSON.parse(readFileSync(join(findSiblingDir('@justfortytwo/persona', root)!, 'manifest.json'), 'utf8')).files.map((f: any) => f.output);
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '# ' + file + '\n\n## Voice\n\n## Interests\n\n## Expertise\n'); }
  const memory: any = await loadSibling('@justfortytwo/memory', root);
  const h = memory.openDb(join(root, DB)); await memory.runMigrations(h.k);
  const seeds = [...SEEDS];
  for (let i = 0; i < extraChat; i++) seeds.push({ content: `bulk message ${i}`, source: 'telegram:owner', meta: { direction: 'inbound', kind: 'message', actor: 'owner' } });
  const ids: number[] = [];
  for (const [i, s] of seeds.entries()) {
    const id = await memory.store(h, new memory.FakeEmbedder(), { content: s.content, source: s.source, observed: s.observed, tags: s.tags, meta: s.meta });
    h.raw.prepare('UPDATE memories SET ts = ? WHERE id = ?').run(`2026-01-${String(1 + (i % 28)).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}:00`, id);
    ids.push(id);
  }
  const before = h.raw.prepare('SELECT * FROM memories ORDER BY id').all() as any[];
  const vectors = new Map<number, Buffer>(before.map((r) => [r.id, h.raw.prepare('SELECT embedding FROM memory_vec WHERE rowid = ?').get(BigInt(r.id)).embedding]));
  await h.k.destroy(); h.raw.close();
  return { root, memory, ids, before, vectors };
}

async function open(root: string) {
  const memory: any = await loadSibling('@justfortytwo/memory', root);
  const h = memory.openDb(join(root, DB));
  return { memory, h, close: async () => { await h.k.destroy(); h.raw.close(); } };
}
const transcriptRows = (h: any) => h.raw.prepare('SELECT * FROM transcript ORDER BY id').all() as any[];

describe('migrateChatToTranscript', () => {
  it('moves chat rows with timestamps, meta and vectors and keeps everything else in memory', async () => {
    const { root, before, vectors } = await fixture();
    const chat = before.filter(CHAT);
    expect(await migrateChatToTranscript(root, DB)).toEqual({ moved: chat.length, skipped: false });
    const { memory, h, close } = await open(root);
    try {
      const left = h.raw.prepare('SELECT source FROM memories ORDER BY id').all().map((r: any) => r.source);
      expect(left).toEqual(['owner', 'tool:shell', 'web']);
      expect(memory.lexical(h, 'zebracorn')).toEqual([]);
      expect(h.raw.prepare('SELECT COUNT(*) AS n FROM memory_vec').get().n).toBe(3);

      const rows = transcriptRows(h);
      expect(rows.map((r) => r.legacy_memory_id)).toEqual(chat.map((r) => r.id));
      for (const [i, r] of rows.entries()) {
        const src = chat[i]!;
        expect(r.ts).toBe(src.ts);
        const meta = JSON.parse(r.meta);
        expect(meta).toEqual({ ...JSON.parse(src.meta), ...(JSON.parse(src.tags).length ? { tags: JSON.parse(src.tags) } : {}) });
        const vec = h.raw.prepare('SELECT embedding FROM transcript_vec WHERE rowid = ?').get(BigInt(r.id));
        expect(Buffer.compare(vec.embedding, vectors.get(src.id)!)).toBe(0);
      }
      const pick = (r: any) => ({ channel: r.channel, direction: r.direction, actor: r.actor, kind: r.kind, thread_id: r.thread_id, content: r.content });
      expect(rows.map(pick)).toEqual([
        { channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', thread_id: 't-1', content: 'zebracorn hello there' },
        { channel: 'telegram', direction: 'outbound', actor: 'assistant', kind: 'message', thread_id: null, content: 'zebracorn reply from assistant' },
        { channel: 'scheduler', direction: 'outbound', actor: 'assistant', kind: 'reminder', thread_id: null, content: 'zebracorn buy milk' },
        { channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', thread_id: null, content: 'zebracorn legacy owner without meta' },
        { channel: 'telegram', direction: 'outbound', actor: 'assistant', kind: 'message', thread_id: null, content: 'zebracorn legacy assistant without meta' },
      ]);
    } finally { await close(); }
  });

  it('a re-run after success moves nothing and duplicates nothing', async () => {
    const { root } = await fixture();
    await migrateChatToTranscript(root, DB);
    expect(await migrateChatToTranscript(root, DB)).toEqual({ moved: 0, skipped: false });
    const { h, close } = await open(root);
    try { expect(transcriptRows(h)).toHaveLength(5); } finally { await close(); }
  });

  it('a crash between import and delete leaves memory intact; the re-run completes without duplicates', async () => {
    const { root, before } = await fixture(230); // spans several batches of 100
    const chat = before.filter(CHAT);
    await expect(migrateChatToTranscript(root, DB, { deleteByIds: () => { throw new Error('simulated crash'); } })).rejects.toThrow('simulated crash');
    let db = await open(root);
    try {
      expect(db.h.raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(before.length);
      expect(transcriptRows(db.h)).toHaveLength(chat.length);
    } finally { await db.close(); }

    expect(await migrateChatToTranscript(root, DB)).toEqual({ moved: chat.length, skipped: false });
    db = await open(root);
    try {
      const rows = transcriptRows(db.h);
      expect(rows.map((r) => r.legacy_memory_id)).toEqual(chat.map((r) => r.id));
      expect(db.h.raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(before.length - chat.length);
    } finally { await db.close(); }
  });

  it('starts the transcript cursor after already-consumed history; refine sees only unconsumed rows', async () => {
    const { root, ids } = await fixture();
    const persona: any = await loadSibling('@justfortytwo/persona', root);
    const transcript: any = await loadSibling('@justfortytwo/transcript', root);
    const P = ids[2]!; // consumed up to the assistant reply
    let db = await open(root);
    const memoryDb = db.memory.memoryHead(db.h).database;
    persona.initialize(root, { database: memoryDb, position: P });
    await db.close();

    await migrateChatToTranscript(root, DB);
    db = await open(root);
    try {
      const { memory, h } = db;
      const rows = transcriptRows(h);
      const head = transcript.transcriptHead(h);
      expect(head.database).not.toBe(memoryDb);
      const expected = Math.max(...rows.filter((r) => r.legacy_memory_id <= P).map((r) => r.id));
      expect(persona.readCheckpoint(root, 'transcript')).toEqual({ database: head.database, position: expected });

      const seen: number[] = [];
      await persona.refine({
        root,
        memory: { head: () => memory.memoryHead(h), delta: (c: any) => memory.memoryDelta(h, c) },
        transcript: { head: () => transcript.transcriptHead(h), delta: (c: any) => transcript.transcriptDelta(h, c) },
        worker: async (input: any) => { for (const e of input.entries) if (e.source.startsWith('telegram:') || e.source.startsWith('scheduler:')) seen.push(e.id); return { additions: [] }; },
      });
      const legacyOf = new Map(rows.map((r) => [r.id, r.legacy_memory_id]));
      expect(seen.map((id) => legacyOf.get(id))).toEqual(ids.filter((id, i) => id > P && CHAT(SEEDS[i]!)));
    } finally { await db.close(); }
  });

  it('keeps live rows appended before the migration above the cursor, so refine still sees them', async () => {
    const { root, ids } = await fixture();
    const persona: any = await loadSibling('@justfortytwo/persona', root);
    const transcript: any = await loadSibling('@justfortytwo/transcript', root);
    const P = ids[2]!;
    let db = await open(root);
    const live: number[] = [];
    try {
      persona.initialize(root, { database: db.memory.memoryHead(db.h).database, position: P });
      await transcript.prepareTranscript(db.h);
      const log = transcript.createTranscript(db.h, new db.memory.FakeEmbedder());
      for (const content of ['live one', 'live two', 'live three']) {
        live.push(await log.append({ channel: 'telegram', direction: 'inbound', actor: 'owner', kind: 'message', content }));
      }
      await new Promise((r) => setTimeout(r, 20)); // let background embeddings settle before closing
    } finally { await db.close(); }

    await migrateChatToTranscript(root, DB);
    db = await open(root);
    try {
      const { memory, h } = db;
      const cursor = persona.readCheckpoint(root, 'transcript');
      expect(cursor.position).toBeLessThan(Math.min(...live));
      const seen: number[] = [];
      await persona.refine({
        root,
        memory: { head: () => memory.memoryHead(h), delta: (c: any) => memory.memoryDelta(h, c) },
        transcript: { head: () => transcript.transcriptHead(h), delta: (c: any) => transcript.transcriptDelta(h, c) },
        worker: async (input: any) => { for (const e of input.entries) if (e.source.startsWith('telegram:') || e.source.startsWith('scheduler:')) seen.push(e.id); return { additions: [] }; },
      });
      for (const id of live) expect(seen).toContain(id);
    } finally { await db.close(); }
  });

  it('leaves the transcript stream uninitialised without a memory checkpoint and never overwrites an existing one', async () => {
    const { root } = await fixture();
    const persona: any = await loadSibling('@justfortytwo/persona', root);
    await migrateChatToTranscript(root, DB);
    expect(persona.readCheckpoint(root, 'transcript')).toBeNull();

    const other = await fixture();
    const transcript: any = await loadSibling('@justfortytwo/transcript', other.root);
    const db = await open(other.root);
    let preset: any;
    try {
      await transcript.prepareTranscript(db.h);
      preset = transcript.transcriptHead(db.h);
      persona.initialize(other.root, { database: db.memory.memoryHead(db.h).database, position: 8 });
      persona.initialize(other.root, preset, 'transcript');
    } finally { await db.close(); }
    await migrateChatToTranscript(other.root, DB);
    expect(persona.readCheckpoint(other.root, 'transcript')).toEqual(preset);
  });

  it('skips and changes nothing when the transcript package is not installed', async () => {
    const { root, before } = await fixture();
    unlinkSync(join(root, 'node_modules/@justfortytwo/transcript'));
    expect(await migrateChatToTranscript(root, DB)).toEqual({ moved: 0, skipped: true });
    const { h, close } = await open(root);
    try {
      expect(h.raw.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before);
      expect(h.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'transcript'").get()).toBeUndefined();
    } finally { await close(); }
  });
});

describe('update reconciliation (reconcileRuntime)', () => {
  const OTHER = { command: 'node', args: ['other.js'] };
  function writeOldMcp(root: string) {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      'fortytwo-memory': { command: 'npx', args: ['-y', '@justfortytwo/memory'], env: { DB_PATH: DB, EMBED_MODEL: 'qwen3-embedding:0.6b', OLLAMA_BASE_URL: 'http://ollama.lan:11434' } },
      other: OTHER,
    } }));
  }
  const mcp = (root: string) => JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));

  it('re-wires fortytwo-memory with the transcript extension, keeps other servers, then migrates', async () => {
    const { root, before } = await fixture();
    writeOldMcp(root);
    expect(await reconcileRuntime(root)).toEqual({ moved: before.filter(CHAT).length, skipped: false });
    const cfg = mcp(root);
    expect(cfg.mcpServers.other).toEqual(OTHER);
    const mem = cfg.mcpServers['fortytwo-memory'];
    expect(mem.args).toEqual(['-y', '-p', '@justfortytwo/memory', '-p', '@justfortytwo/transcript', 'fortytwo-memory']);
    expect(mem.env).toMatchObject({ DB_PATH: DB, OLLAMA_BASE_URL: 'http://ollama.lan:11434', FORTYTWO_MCP_EXTENSIONS: '@justfortytwo/transcript' });
  });

  it('keeps a hand-edited remote embedder config (openai) through the re-wire', async () => {
    const { root } = await fixture();
    const env = { DB_PATH: DB, EMBED_PROVIDER: 'openai', EMBED_API_KEY: 'sk-test', EMBED_MODEL: 'text-embedding-3-large', EMBED_BASE_URL: 'https://api.example.com/v1' };
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fortytwo-memory': { command: 'npx', args: ['-y', '@justfortytwo/memory'], env } } }));
    await reconcileRuntime(root);
    const mem = mcp(root).mcpServers['fortytwo-memory'];
    expect(mem.env).toMatchObject(env);
    expect(mem.env.FORTYTWO_MCP_EXTENSIONS).toBe('@justfortytwo/transcript');
  });

  it('reports a failed chat migration (malformed row) instead of throwing; memory stays intact', async () => {
    const { root } = await fixture();
    writeOldMcp(root);
    let db = await open(root);
    try {
      db.h.raw.prepare("UPDATE memories SET meta = '{broken' WHERE source = 'telegram:owner'").run();
    } finally { await db.close(); }
    db = await open(root);
    const before = db.h.raw.prepare('SELECT * FROM memories ORDER BY id').all();
    await db.close();
    const result = await reconcileRuntime(root);
    expect(result).toMatchObject({ moved: 0, skipped: true });
    expect(result.error).toMatch(/meta is not valid JSON/);
    expect(mcp(root).mcpServers['fortytwo-memory'].env.FORTYTWO_MCP_EXTENSIONS).toBe('@justfortytwo/transcript');
    db = await open(root);
    try { expect(db.h.raw.prepare('SELECT * FROM memories ORDER BY id').all()).toEqual(before); } finally { await db.close(); }
  });

  it('refuses to overwrite a malformed .mcp.json and leaves it untouched', async () => {
    const { root } = await fixture();
    writeFileSync(join(root, '.mcp.json'), '{ "mcpServers": ');
    await expect(reconcileRuntime(root)).rejects.toThrow(/\.mcp\.json.*not valid JSON/);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe('{ "mcpServers": ');
  });

  it('without the transcript package: wires plain memory and skips the migration', async () => {
    const { root, before } = await fixture();
    writeOldMcp(root);
    unlinkSync(join(root, 'node_modules/@justfortytwo/transcript'));
    expect(await reconcileRuntime(root)).toEqual({ moved: 0, skipped: true });
    const mem = mcp(root).mcpServers['fortytwo-memory'];
    expect(mem.args).toEqual(['-y', '@justfortytwo/memory']);
    expect(mem.env.FORTYTWO_MCP_EXTENSIONS).toBeUndefined();
    const { h, close } = await open(root);
    try { expect(h.raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(before.length); } finally { await close(); }
  });
});
