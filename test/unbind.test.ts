import { describe, it, expect } from 'vitest';
import { pruneChannels } from '../src/commands/unbind.js';
import type { ChannelBinding } from '../src/state.js';

const ch = (over: Partial<ChannelBinding> = {}): ChannelBinding => ({ channel: 'telegram', allowedChatIds: ['42'], ...over });

describe('pruneChannels', () => {
  it('removes the binding that holds a given chatId', () => {
    const channels = [ch({ allowedChatIds: ['42'] }), ch({ allowedChatIds: ['99'] })];
    const { kept, removed } = pruneChannels(channels, { chatId: '42' });
    expect(removed).toHaveLength(1);
    expect(kept).toEqual([ch({ allowedChatIds: ['99'] })]);
  });

  it('removes every binding for a channel with all=true', () => {
    const channels = [ch({ allowedChatIds: ['42'] }), ch({ allowedChatIds: ['99'] })];
    const { kept, removed } = pruneChannels(channels, { all: true, channel: 'telegram' });
    expect(removed).toHaveLength(2);
    expect(kept).toEqual([]);
  });

  it('leaves bindings for other channels untouched', () => {
    const channels = [ch({ channel: 'telegram', allowedChatIds: ['42'] }), ch({ channel: 'slack', allowedChatIds: ['42'] })];
    const { kept, removed } = pruneChannels(channels, { channel: 'telegram', chatId: '42' });
    expect(removed).toHaveLength(1);
    expect(kept).toEqual([ch({ channel: 'slack', allowedChatIds: ['42'] })]);
  });

  it('returns no removals when nothing matches', () => {
    const channels = [ch({ allowedChatIds: ['42'] })];
    const { kept, removed } = pruneChannels(channels, { chatId: 'nope' });
    expect(removed).toHaveLength(0);
    expect(kept).toEqual(channels);
  });
});

// --- paired chats in the bridge's bindings db (issue #6) ---------------------
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revokePairedChats, runUnbind } from '../src/commands/unbind.js';
import { resolveBindingsDbPath } from '../src/commands/pair.js';
import { writeIdentity } from '../src/state.js';
import { loadTelegram } from '../src/engine.js';
import { linkEngineInto } from './helpers/engine.js';
import { afterEach, beforeEach } from 'vitest';

function fakeStore(ids: string[]) {
  const rows = new Set(ids);
  return {
    rows,
    list: (_t?: string) => [...rows].map((channelUserId) => ({ channelUserId })),
    remove: (_t: string, id: string) => { rows.delete(id); },
  };
}

describe('revokePairedChats', () => {
  it('removes only the matching chat', () => {
    const s = fakeStore(['42', '99']);
    expect(revokePairedChats(s, { chatId: '42' })).toEqual(['42']);
    expect([...s.rows]).toEqual(['99']);
  });
  it('removes every paired chat with all', () => {
    const s = fakeStore(['42', '99']);
    expect(revokePairedChats(s, { all: true }).sort()).toEqual(['42', '99']);
    expect(s.rows.size).toBe(0);
  });
  it('removes nothing when no chat matches', () => {
    const s = fakeStore(['42']);
    expect(revokePairedChats(s, { chatId: '7' })).toEqual([]);
    expect([...s.rows]).toEqual(['42']);
  });
});

async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = ''; let err = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  try { return { result: await fn(), out, err }; }
  finally {
    (process.stdout as unknown as { write: typeof o }).write = o;
    (process.stderr as unknown as { write: typeof e }).write = e;
  }
}

describe('runUnbind (integration: revokes a chat paired through the bindings db)', () => {
  let dir: string;
  const cwd0 = process.cwd();
  const allowed0 = process.env['ALLOWED_CHAT_IDS'];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ft-unbind-'));
    linkEngineInto(dir);
    delete process.env['ALLOWED_CHAT_IDS'];
    const ts = new Date().toISOString();
    writeIdentity({ identityVersion: 1, answers: {}, channels: [], createdAt: ts, updatedAt: ts }, dir);
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd0);
    if (allowed0 === undefined) delete process.env['ALLOWED_CHAT_IDS']; else process.env['ALLOWED_CHAT_IDS'] = allowed0;
    rmSync(dir, { recursive: true, force: true });
  });

  async function pairedStore() {
    const tg = (await loadTelegram()) as unknown as { SqliteBindingStore: new (p: string) => { put(b: unknown): void; list(t?: string): Array<{ channelUserId: string }> } };
    const path = resolveBindingsDbPath(dir);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const store = new tg.SqliteBindingStore(path);
    for (const id of ['42', '99']) store.put({ channelType: 'telegram', channelUserId: id, owner: 'owner', boundAt: new Date().toISOString() });
    return store;
  }

  it('removes the paired chat even when identity.json has no binding for it', async () => {
    const store = await pairedStore();
    const { result, out } = await captured(() => runUnbind(['--chat-id', '42']));
    expect(result).toBe(0);
    expect(out).toMatch(/revoked paired chat\(s\) 42/);
    expect(store.list('telegram').map((b) => b.channelUserId)).toEqual(['99']);
  });

  it('names an id that ALLOWED_CHAT_IDS still authorizes', async () => {
    await pairedStore();
    writeFileSync(join(dir, '.env'), 'ALLOWED_CHAT_IDS=42,7\n');
    const { out } = await captured(() => runUnbind(['--chat-id', '42']));
    expect(out).toMatch(/42 is still in ALLOWED_CHAT_IDS/);
    expect(out).not.toMatch(/\b7\b.*ALLOWED/);
  });

  it('never creates the bindings db when nothing was paired', async () => {
    const { result, out } = await captured(() => runUnbind(['--all']));
    expect(result).toBe(0);
    expect(out).toMatch(/nothing changed/);
    expect(existsSync(resolveBindingsDbPath(dir))).toBe(false);
  });

  it('names an id authorized only by ALLOWED_CHAT_IDS instead of saying nothing changed', async () => {
    writeFileSync(join(dir, '.env'), 'ALLOWED_CHAT_IDS=42\n');
    const { result, out } = await captured(() => runUnbind(['--chat-id', '42']));
    expect(result).toBe(0);
    expect(out).not.toMatch(/nothing changed/);
    expect(out).toMatch(/42 is still in ALLOWED_CHAT_IDS and keeps access/);
  });

  it('does not claim the bridge refuses a chat that ALLOWED_CHAT_IDS still authorizes', async () => {
    await pairedStore();
    writeFileSync(join(dir, '.env'), 'ALLOWED_CHAT_IDS=42\n');
    const { out } = await captured(() => runUnbind(['--chat-id', '42']));
    expect(out).not.toMatch(/refuses/);
    expect(out).toMatch(/removed the pairing for 42/);
  });

  it('--all names every ALLOWED id and voids pending pairing codes', async () => {
    await pairedStore();
    const tg = (await loadTelegram()) as unknown as { SqliteBindingStore: new (p: string) => { putChallenge(c: unknown): void; takeChallenge(code: string, now: number): unknown } };
    const store = new tg.SqliteBindingStore(resolveBindingsDbPath(dir));
    store.putChallenge({ code: '123456', owner: 'owner', expiresAt: Date.now() + 300_000 });
    writeFileSync(join(dir, '.env'), 'ALLOWED_CHAT_IDS=42,7\n');
    const { out } = await captured(() => runUnbind(['--all']));
    expect(out).toMatch(/42, 7 are still in ALLOWED_CHAT_IDS/);
    expect(store.takeChallenge('123456', Date.now())).toBeNull();
  });

  it('exits 1 when the bindings db exists but telegram is not installed', async () => {
    await pairedStore();
    rmSync(join(dir, 'node_modules', '@justfortytwo', 'telegram'), { recursive: true, force: true });
    const { result, err } = await captured(() => runUnbind(['--chat-id', '42']));
    expect(result).toBe(1);
    expect(err).toMatch(/not installed, so paired chats were not revoked/);
  });

  it('leaves the bindings db alone for another channel', async () => {
    const store = await pairedStore();
    await captured(() => runUnbind(['--all', '--channel', 'slack']));
    expect(store.list('telegram')).toHaveLength(2);
  });
});
