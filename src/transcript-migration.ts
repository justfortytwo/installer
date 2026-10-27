// One-off, idempotent move of chat history out of memory into the transcript.
//
// Chat rows (`telegram:*`, `scheduler:wake`) used to live in memory's `memories`
// table; the transcript now owns them. The move is ordered so no history can be
// lost and a re-run never duplicates:
//   1. map every chat row (pure; malformed rows fail before any write),
//   2. import in batches of 100, one transaction each (importRow is idempotent
//      on legacy_memory_id, so a re-run after a crash re-imports nothing),
//   3. verify every source id has its transcript row with the same content,
//   4. only then delete from memory, all in ONE transaction (a failure leaves
//      memory intact),
//   5. start persona's transcript cursor below every unconsumed row (live, or
//      legacy past the memory checkpoint); never overwrite an existing one.
// Siblings load through loadSibling: a partial install skips, a broken one fails loud.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSiblingDir, loadSibling } from './engine.js';

interface Cursor { database: string; position: number }
interface Statement { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
interface Raw {
  prepare(sql: string): Statement;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
}
interface Handle { k: { destroy(): Promise<void> }; raw: Raw }
type Direction = 'inbound' | 'outbound' | 'internal';
interface ImportRow {
  channel: string; direction: Direction; actor: string; kind: string; content: string;
  threadId: string | null; meta: Record<string, unknown>; ts: string; legacyMemoryId: number; embedding?: Buffer;
}
interface Memory {
  openDb(path: string): Handle;
  runMigrations(k: unknown): Promise<void>;
  deleteByIds(h: Handle, ids: number[]): number;
}
interface Transcript {
  prepareTranscript(h: Handle): Promise<void>;
  createTranscript(h: Handle, embedder: { embed(text: string): Promise<Float32Array> }): { importRow(r: ImportRow): number };
  transcriptHead(h: Handle): Cursor;
}
interface Persona {
  readCheckpoint(root: string, stream?: 'memory' | 'transcript'): Cursor | null;
  initialize(root: string, head: Cursor, stream?: 'memory' | 'transcript'): void;
}
interface MemoryRow { id: number; ts: string; content: string; source: string; tags: string | null; meta: string | null }

export interface MigrationResult {
  moved: number;
  skipped: boolean;
  /** Why the migration did not run (set only by migrateChatSafely). */
  error?: string;
}
/** Test seam: replace memory's deleteByIds (e.g. to simulate a crash before delete). */
export interface MigrationDeps { deleteByIds?: (h: Handle, ids: number[]) => number }

const BATCH = 100;
const DIRECTIONS: readonly string[] = ['inbound', 'outbound', 'internal'];
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseJson(text: string | null, id: number, field: string): unknown {
  if (text === null || text === '') return undefined;
  try { return JSON.parse(text); } catch { throw new Error(`memory row ${id}: ${field} is not valid JSON`); }
}

/** Map one legacy memory row onto a transcript import row. Throws on malformed rows. */
export function mapChatRow(row: MemoryRow, embedding?: Buffer): ImportRow {
  const rawMeta = parseJson(row.meta, row.id, 'meta') ?? {};
  if (typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) throw new Error(`memory row ${row.id}: meta is not an object`);
  const meta: Record<string, unknown> = { ...(rawMeta as Record<string, unknown>) };
  const tags = parseJson(row.tags, row.id, 'tags') ?? [];
  if (!Array.isArray(tags)) throw new Error(`memory row ${row.id}: tags is not an array`);
  // Keep the original tags so nothing from the old row is lost.
  if (tags.length > 0 && !Object.hasOwn(meta, 'tags')) meta.tags = tags;
  const base = { meta, ts: row.ts, legacyMemoryId: row.id, ...(embedding ? { embedding } : {}) };

  if (row.source === 'scheduler:wake') {
    const kind = nonEmpty(tags[1]) ? tags[1] : (/^\[scheduler:([^\]]+)\] /.exec(row.content)?.[1] ?? 'wake');
    const prefix = `[scheduler:${kind}] `;
    const content = row.content.startsWith(prefix) ? row.content.slice(prefix.length) : row.content;
    return { ...base, channel: 'scheduler', direction: 'outbound', actor: 'assistant', kind, content, threadId: null };
  }
  if (!row.source.startsWith('telegram:')) throw new Error(`memory row ${row.id}: not a chat row (${row.source})`);
  const actor = nonEmpty(meta.actor) ? meta.actor : row.source.slice('telegram:'.length);
  if (!actor) throw new Error(`memory row ${row.id}: no actor`);
  const direction = (typeof meta.direction === 'string' && DIRECTIONS.includes(meta.direction))
    ? meta.direction as Direction
    : actor === 'owner' ? 'inbound' : 'outbound';
  const kind = nonEmpty(meta.kind) ? meta.kind : 'message';
  const thread = meta.thread_id;
  const threadId = nonEmpty(thread) ? thread : typeof thread === 'number' ? String(thread) : null;
  return { ...base, channel: 'telegram', direction, actor, kind, content: row.content, threadId };
}

function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

export async function migrateChatToTranscript(root: string, dbPath: string, deps: MigrationDeps = {}): Promise<MigrationResult> {
  const MEMORY = '@justfortytwo/memory', TRANSCRIPT = '@justfortytwo/transcript', PERSONA = '@justfortytwo/persona';
  if (!findSiblingDir(MEMORY, root) || !findSiblingDir(TRANSCRIPT, root)) return { moved: 0, skipped: true };
  const memory = await loadSibling<Memory>(MEMORY, root);
  const transcript = await loadSibling<Transcript>(TRANSCRIPT, root);
  if (!memory?.openDb || !memory.runMigrations || !memory.deleteByIds || !transcript?.prepareTranscript || !transcript.createTranscript || !transcript.transcriptHead) {
    throw new Error('Transcript migration requires compatible memory and transcript packages');
  }
  // Persona is optional (no oneiros without it); when installed it must be compatible.
  const persona = findSiblingDir(PERSONA, root) ? await loadSibling<Persona>(PERSONA, root) : null;
  if (persona && (!persona.readCheckpoint || !persona.initialize)) throw new Error('Transcript migration requires a compatible persona package');
  const deleteByIds = deps.deleteByIds ?? memory.deleteByIds;

  const path = resolve(root, dbPath); mkdirSync(dirname(path), { recursive: true });
  const h = memory.openDb(path);
  try {
    await memory.runMigrations(h.k);
    await transcript.prepareTranscript(h);
    // The transcript only reads/writes rows here; it never embeds during import.
    const log = transcript.createTranscript(h, { embed: async () => { throw new Error('no embedding during migration'); } });

    const rows = h.raw.prepare(
      `SELECT id, ts, content, source, tags, meta FROM memories
        WHERE substr(source, 1, 9) = 'telegram:' OR source = 'scheduler:wake' ORDER BY id`,
    ).all() as MemoryRow[];
    const vec = h.raw.prepare('SELECT embedding FROM memory_vec WHERE rowid = ?');
    const mapped = rows.map((r) => mapChatRow(r, (vec.get(BigInt(r.id)) as { embedding: Buffer } | undefined)?.embedding));

    const importBatch = h.raw.transaction((batch: ImportRow[]) => { for (const r of batch) log.importRow(r); });
    for (const batch of batches(mapped)) importBatch(batch);

    // Verify before anything leaves memory.
    const byLegacy = h.raw.prepare('SELECT content FROM transcript WHERE legacy_memory_id = ?');
    for (const r of mapped) {
      const t = byLegacy.get(r.legacyMemoryId) as { content: string } | undefined;
      if (!t || t.content !== r.content) throw new Error(`Transcript migration verification failed for memory row ${r.legacyMemoryId}; memory left intact`);
    }

    const ids = mapped.map((r) => r.legacyMemoryId);
    const moved = h.raw.transaction(() => batches(ids).reduce((n, b) => n + deleteByIds(h, b), 0))();

    // The transcript cursor resumes after what oneiros already consumed via memory.
    // Every row NOT consumed (a live row without legacy id, or a legacy row past
    // the memory checkpoint) must stay above the cursor, so the cursor sits just
    // below the lowest such row, else at the head. Live rows can precede migrated
    // ones (e.g. the new bridge ran after a failed update), and then some consumed
    // legacy rows land above the cursor and oneiros re-reads them: the safe
    // direction (re-reading is acceptable, skipping is not), bounded by persona's
    // eligibility and proposal rules.
    const consumed = persona?.readCheckpoint(root);
    if (persona && consumed && !persona.readCheckpoint(root, 'transcript')) {
      const head = transcript.transcriptHead(h);
      const first = h.raw.prepare(
        'SELECT MIN(id) AS id FROM transcript WHERE legacy_memory_id IS NULL OR legacy_memory_id > ?',
      ).get(consumed.position) as { id: number | null };
      persona.initialize(root, { database: head.database, position: first.id === null ? head.position : first.id - 1 }, 'transcript');
    }
    return { moved, skipped: false };
  } finally { await h.k.destroy(); h.raw.close(); }
}

/**
 * migrateChatToTranscript for init/update: a failure (malformed legacy row,
 * SQLITE_BUSY, incompatible sibling) is returned as `error` instead of thrown,
 * so the rest of init/update (state ledger, launcher) still completes. The move
 * only deletes from memory after a verified import, so memory stays intact.
 */
export async function migrateChatSafely(root: string, dbPath: string): Promise<MigrationResult> {
  try {
    return await migrateChatToTranscript(root, dbPath);
  } catch (err) {
    return { moved: 0, skipped: true, error: err instanceof Error ? err.message : String(err) };
  }
}
