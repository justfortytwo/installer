// End-to-end integration: the install path actually composes.
//   1. `fortytwo init` scaffolds a project (persona + .env + .mcp.json) and
//      migrates the memory DB against the REAL engine siblings.
//   2. `fortytwo doctor` reports the required checks healthy.
//   3. The migrated DB round-trips a memory: store -> recall returns it.
//
// Deterministic + hermetic: recall uses memory's FakeEmbedder, so no Ollama is
// required. (init's provision attempts `ollama pull`, but that is warn-only and
// does not affect these assertions.) Real fs + real sqlite — this is the proof
// that the packages work together, not just in isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runDoctorChecks, defaultDoctorDeps } from '../src/commands/doctor.js';
import { linkEngineInto } from './helpers/engine.js';
import { startFakeOllama } from './helpers/ollama.js';

// Required manifest fields with no default — must be supplied or init refuses.
const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Aria',
  OWNER_NAME: 'Alex Doe',
  OWNER_ROLE: 'Engineer',
  OWNER_POSITIONING: 'a builder',
  OWNER_IDENTITY_SUMMARY: 'An engineer who ships.',
  OWNER_VALUES: 'rigor\ncandor',
  OWNER_EXPERTISE: 'systems',
  OWNER_BOUNDARIES: 'no spam',
  OWNER_VOICE_TONE: 'dry, precise',
};

let dir: string;
let cwd0: string;
const setEnv: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ft-e2e-'));
  linkEngineInto(dir); // the engine lives in the project, as after a real `init` install
  cwd0 = process.cwd();
  process.chdir(dir);
  for (const [k, v] of Object.entries(REQUIRED_ANSWERS)) {
    const key = `FORTYTWO_${k}`;
    process.env[key] = v;
    setEnv.push(key);
  }
});
afterEach(() => {
  process.chdir(cwd0);
  for (const k of setEnv.splice(0)) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

describe('e2e: init -> doctor -> store/recall', () => {
  it('init scaffolds the project and migrates the memory DB', async () => {
    const code = await runInit(['--yes', '--allowed-chat-ids', '555']);
    expect(code).toBe(0);
    for (const f of ['CLAUDE.md', '.env', '.mcp.json', '.fortytwo/identity.json', '.fortytwo/state.json', 'context/OWNER.md', 'db/fortytwo.db']) {
      expect(existsSync(join(dir, f)), `expected ${f} to exist`).toBe(true);
    }
  });

  it('writes the chosen Ollama URL to .env AND .mcp.json and checks the model there', async () => {
    const ollama = await startFakeOllama({ models: ['qwen3-embedding:0.6b'] });
    const prev = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = ollama.url; // non-interactive: env is the value used
    try {
      expect(await runInit(['--yes'])).toBe(0);
      const env = readFileSync(join(dir, '.env'), 'utf8');
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      expect(env).toContain(`OLLAMA_BASE_URL=${ollama.url}\n`);
      expect(mcp.mcpServers['fortytwo-memory'].env.OLLAMA_BASE_URL).toBe(ollama.url);
      // the availability check went to that server; model present -> no pull
      expect(ollama.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/tags']);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = prev;
      await ollama.close();
    }
  });

  it('re-running init keeps the custom Ollama URL saved in .env', async () => {
    const ollama = await startFakeOllama({ models: ['qwen3-embedding:0.6b'] });
    const prev = process.env.OLLAMA_BASE_URL;
    try {
      process.env.OLLAMA_BASE_URL = ollama.url;
      expect(await runInit(['--yes'])).toBe(0); // first init saves the custom URL
      delete process.env.OLLAMA_BASE_URL;        // a later shell without the env var
      expect(await runInit(['--yes'])).toBe(0);
      const env = readFileSync(join(dir, '.env'), 'utf8');
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      expect(env).toContain(`OLLAMA_BASE_URL=${ollama.url}\n`);
      expect(env).not.toContain('localhost:11434');
      expect(mcp.mcpServers['fortytwo-memory'].env.OLLAMA_BASE_URL).toBe(ollama.url);
      expect(ollama.requests.filter((r) => r.path === '/api/tags')).toHaveLength(2); // both runs checked it
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = prev;
      await ollama.close();
    }
  });

  it('doctor reports every required check healthy after init', async () => {
    await runInit(['--yes', '--allowed-chat-ids', '555']);
    const { results, ok } = await runDoctorChecks(defaultDoctorDeps());
    // Required checks must pass; the embedder check is warn-only (Ollama optional).
    const required = results.filter((r) => r.required);
    expect(required.every((r) => r.ok), `failed: ${required.filter((r) => !r.ok).map((r) => r.name + ': ' + r.detail).join('; ')}`).toBe(true);
    expect(ok).toBe(true);
  });

  it('the migrated DB round-trips a memory (store -> recall)', async () => {
    await runInit(['--yes', '--allowed-chat-ids', '555']);
    const mem = (await import('@justfortytwo/memory')) as unknown as {
      openDb: (p: string) => { raw: unknown; k: { destroy?: () => Promise<void> }; close?: () => void };
      store: (h: unknown, e: unknown, m: { content: string; source?: string; tags?: string[] }) => Promise<number>;
      recall: (h: unknown, e: unknown, text: string, k?: number) => Promise<{ content: string; distance: number }[]>;
      FakeEmbedder: new () => unknown;
    };
    const h = mem.openDb(resolve(dir, 'db/fortytwo.db'));
    try {
      const embedder = new mem.FakeEmbedder();
      const id = await mem.store(h, embedder, { content: 'the launch ships on Friday', source: 'telegram:owner', tags: ['telegram', 'inbound'] });
      expect(id).toBeGreaterThan(0);
      const hits = await mem.recall(h, embedder, 'when does the launch ship', 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((r) => r.content === 'the launch ships on Friday')).toBe(true);
    } finally {
      try { await h.k.destroy?.(); } catch { /* ignore */ }
      try { h.close?.(); } catch { /* ignore */ }
    }
  });
});
