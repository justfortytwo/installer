// Additive runtime reconciliation: never renders or writes owner context.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSiblingDir, loadSibling } from './engine.js';
interface Cursor { database: string; position: number }
interface Handle { k: { destroy(): Promise<void> }; raw: { close(): void } }
interface Memory {
  openDb(path: string): Handle;
  runMigrations(k: unknown): Promise<void>;
  memoryHead(h: Handle): Cursor;
}
interface Persona { initialize(root: string, head: Cursor): void }
interface Scheduler {
  seedOneiros(h: Handle, now: string, next: (cron: string, now: string) => string): void;
  recurrenceNext(cron: string, now: string): string;
}
export async function reconcileOneiros(root: string, dbPath: string): Promise<void> {
  // Respect intentionally partial installs. Installed-but-broken packages fail loud.
  const specs = ['@justfortytwo/persona', '@justfortytwo/memory', '@justfortytwo/scheduler'];
  if (specs.some(s => !findSiblingDir(s,root))) return;
  const persona = await loadSibling<Persona>(specs[0]!,root);
  const memory = await loadSibling<Memory>(specs[1]!,root);
  const scheduler = await loadSibling<Scheduler>(specs[2]!,root);
  if (!persona?.initialize || !memory?.memoryHead || !scheduler?.seedOneiros) throw new Error('Oneiros requires compatible persona, memory and scheduler packages');
  const path = resolve(root,dbPath); mkdirSync(dirname(path),{recursive:true});
  const h = memory.openDb(path);
  try {
    await memory.runMigrations(h.k);
    persona.initialize(root,memory.memoryHead(h));
    scheduler.seedOneiros(h,new Date().toISOString(),scheduler.recurrenceNext);
  } finally { await h.k.destroy(); h.raw.close(); }
}
