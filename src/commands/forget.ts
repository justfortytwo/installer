// forget — remove specific memories from the memory store.
//
// The data-hygiene verb: the OWNER asks to forget something (a specific entry,
// a topic, a date range, a source). This is a privileged operation against the
// canonical store — deliberately a CLI command and NOT an MCP tool, so the
// assistant can never be tricked by injected content into deleting memories.
// Selectors resolve candidates, which are previewed and confirmed before a hard
// delete (row + vector + FTS) via @justfortytwo/memory's deleteByIds.

import { createInterface } from 'node:readline/promises';
import { loadMemory } from '../engine.js';
import { EMBED_MODEL, DEFAULT_DB_PATH } from './init.js';

export interface ForgetFlags {
  id?: number;
  query?: string;
  since?: string;
  until?: string;
  tag?: string;
  source?: string;
  yes?: boolean;
  limit: number;
  dbPath: string;
}

export function parseForgetArgs(argv: string[]): ForgetFlags {
  const f: ForgetFlags = { limit: 50, dbPath: process.env.DB_PATH ?? DEFAULT_DB_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--yes' || a === '-y') { f.yes = true; continue; }
    if (!a.startsWith('--')) continue;
    const v = argv[++i] ?? '';
    switch (a.slice(2)) {
      case 'id': f.id = Number(v); break;
      case 'query': f.query = v; break;
      case 'since': f.since = v; break;
      case 'until': f.until = v; break;
      case 'tag': f.tag = v; break;
      case 'source': f.source = v; break;
      case 'limit': f.limit = Number(v) || 50; break;
      case 'db-path': f.dbPath = v; break;
    }
  }
  return f;
}

/** True when at least one selector was given (refuse a blanket delete). */
export function hasForgetSelector(f: ForgetFlags): boolean {
  return f.id !== undefined || !!f.query || !!f.tag || !!f.source || !!f.since || !!f.until;
}

type MemModule = {
  openDb: (p: string) => { k: { destroy?: () => Promise<void> }; close?: () => void };
  query: (h: unknown, opts: Record<string, unknown>) => Promise<{ id: number; content: string }[]>;
  recall: (h: unknown, e: unknown, text: string, k?: number) => Promise<{ id: number; content: string }[]>;
  deleteByIds: (h: unknown, ids: number[]) => number;
  FakeEmbedder: new () => unknown;
  OllamaEmbedder: new (model: string, baseUrl?: string) => unknown;
};

export async function runForget(argv: string[]): Promise<number> {
  const f = parseForgetArgs(argv);
  if (!hasForgetSelector(f)) {
    process.stderr.write('forget: specify what to forget — --id <n>, --query <text>, --tag/--source <v>, or --since/--until <date>.\n');
    return 2;
  }
  const mem = (await loadMemory()) as unknown as MemModule | null;
  if (!mem || typeof mem.deleteByIds !== 'function') {
    process.stderr.write('forget: @justfortytwo/memory (>=0.1.1, with deleteByIds) is not installed.\n');
    return 2;
  }
  const h = mem.openDb(f.dbPath);
  try {
    let rows: { id: number; content: string }[];
    if (f.id !== undefined) {
      rows = (await mem.query(h, { liveOnly: false, limit: 100000 })).filter((r) => r.id === f.id);
    } else if (f.query) {
      const embedder = process.env.EMBED_MODEL
        ? new mem.OllamaEmbedder(process.env.EMBED_MODEL, process.env.OLLAMA_BASE_URL)
        : new mem.FakeEmbedder();
      rows = await mem.recall(h, embedder, f.query, f.limit);
    } else {
      rows = await mem.query(h, {
        source: f.source, tag: f.tag, since: f.since, until: f.until, liveOnly: false, limit: f.limit,
      });
    }

    if (rows.length === 0) {
      process.stdout.write('forget: no matching memories.\n');
      return 0;
    }
    process.stdout.write(`forget: ${rows.length} match(es):\n`);
    for (const r of rows.slice(0, 10)) {
      process.stdout.write(`  [${r.id}] ${r.content.replace(/\s+/g, ' ').slice(0, 80)}\n`);
    }
    if (rows.length > 10) process.stdout.write(`  … and ${rows.length - 10} more\n`);

    if (!f.yes) {
      if (!process.stdin.isTTY) {
        process.stderr.write('forget: refusing to delete without confirmation — re-run with --yes.\n');
        return 2;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`Permanently forget ${rows.length} memory(ies)? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (ans !== 'y' && ans !== 'yes') {
        process.stdout.write('forget: aborted; nothing deleted.\n');
        return 0;
      }
    }

    const n = mem.deleteByIds(h, rows.map((r) => r.id));
    process.stdout.write(`✓ forgot ${n} memory(ies).\n`);
    return 0;
  } finally {
    try { await h.k?.destroy?.(); } catch { /* best-effort */ }
    try { h.close?.(); } catch { /* best-effort */ }
  }
}
