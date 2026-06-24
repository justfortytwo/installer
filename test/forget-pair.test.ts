import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseForgetArgs, hasForgetSelector, runForget } from '../src/commands/forget.js';
import { parsePairArgs, resolveBindingsDbPath, runPair } from '../src/commands/pair.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ft-fp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('parseForgetArgs', () => {
  it('parses selectors + flags; defaults limit/dbPath', () => {
    const f = parseForgetArgs(['--id', '7', '--yes', '--db-path', 'x.db']);
    expect(f.id).toBe(7);
    expect(f.yes).toBe(true);
    expect(f.dbPath).toBe('x.db');
    expect(f.limit).toBe(50);
  });
  it('requires a selector (no blanket delete)', () => {
    expect(hasForgetSelector(parseForgetArgs([]))).toBe(false);
    expect(hasForgetSelector(parseForgetArgs(['--query', 'secrets']))).toBe(true);
    expect(hasForgetSelector(parseForgetArgs(['--tag', 'x']))).toBe(true);
  });
});

describe('parsePairArgs / resolveBindingsDbPath', () => {
  it('defaults to telegram; reads --ttl', () => {
    expect(parsePairArgs([]).channel).toBe('telegram');
    expect(parsePairArgs(['--ttl', '120']).ttlSeconds).toBe(120);
  });
  it('resolves the bridge bindings db under <root>/state', () => {
    expect(resolveBindingsDbPath('/proj')).toBe('/proj/state/telegram-bindings.db');
  });
});

describe('forget (integration: real deletion via @justfortytwo/memory)', () => {
  it('forget --id removes exactly that memory', async () => {
    const mem = (await import('@justfortytwo/memory')) as any;
    const dbPath = join(dir, 'm.db');
    let h = mem.openDb(dbPath);
    await mem.runMigrations(h.k);
    const e = new mem.FakeEmbedder();
    const gone = await mem.store(h, e, { content: 'forget me — the secret code' });
    await mem.store(h, e, { content: 'keep me — public note' });
    await h.k.destroy(); // release before the CLI opens its own connection

    expect(await runForget(['--id', String(gone), '--yes', '--db-path', dbPath])).toBe(0);

    h = mem.openDb(dbPath);
    const left = (await mem.query(h, {})).map((r: any) => r.content);
    await h.k.destroy();
    expect(left).toEqual(['keep me — public note']);
  });

  it('refuses a blanket delete with no selector', async () => {
    expect(await runForget(['--db-path', join(dir, 'm.db')])).toBe(2);
  });
});

describe('pair (integration: CLI-issued code redeemed cross-process)', () => {
  it('issues a code persisted to the bridge bindings db that a separate adapter redeems', async () => {
    const cwd0 = process.cwd();
    process.chdir(dir);
    try {
      // capture the printed code
      const orig = process.stdout.write.bind(process.stdout);
      let out = '';
      (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
      try {
        expect(await runPair([])).toBe(0);
      } finally {
        (process.stdout as unknown as { write: typeof orig }).write = orig;
      }
      const code = out.match(/Pairing code:\s*(\d+)/)?.[1];
      expect(code, 'a pairing code was printed').toBeTruthy();

      // a SEPARATE adapter (the "bridge") on the same bindings db redeems it
      const tg = (await import('@justfortytwo/telegram')) as any;
      const store = new tg.SqliteBindingStore(join(dir, 'state', 'telegram-bindings.db'));
      const bridge = new tg.TelegramAdapter(store);
      const binding = bridge.verify('42', code!);
      expect(binding?.owner).toBe('owner');
      // single-use: a second redemption fails
      expect(bridge.verify('42', code!)).toBeNull();
    } finally {
      process.chdir(cwd0);
    }
  });
});
