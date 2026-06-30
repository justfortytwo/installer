import { describe, it, expect } from 'vitest';
import { runDoctorChecks, HEARTBEAT_STALE_MS, type DoctorDeps } from '../src/commands/doctor.js';
import { satisfiesRange } from '../src/engine.js';

const FRESH_ISO = '2026-06-30T12:00:00.000Z';
// A "now" that is 10 seconds after FRESH_ISO — heartbeat is well within 90s.
const NOW_FRESH = '2026-06-30T12:00:10.000Z';
// A "now" that is 2× HEARTBEAT_STALE_MS after FRESH_ISO — heartbeat is stale.
const NOW_STALE = new Date(new Date(FRESH_ISO).getTime() + HEARTBEAT_STALE_MS * 2).toISOString();

// All-green deps; each test overrides one facet to drive a single check red.
const goodDeps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  loadGate: async () => ({ POLICY_SCHEMA_VERSION: 1 }),
  loadMemory: async () => ({ MEMORY_TOOL_CONTRACT_VERSION: 1 }),
  installedVersion: (spec) =>
    ({ '@justfortytwo/gate': '0.1.0', '@justfortytwo/memory': '0.1.3' } as Record<string, string>)[spec] ?? null,
  compatRanges: { '@justfortytwo/gate': '^0.1.0', '@justfortytwo/memory': '^0.1.0' },
  ollamaModels: async () => ['qwen3-embedding:0.6b', 'llama3'],
  embedModel: 'qwen3-embedding:0.6b',
  migrationState: async () => 'ok',
  schedulerHeartbeat: () => ({ pid: 42, ts: FRESH_ISO }),
  now: () => NOW_FRESH,
  ...over,
});

const byName = (rs: { name: string; ok: boolean; required: boolean; detail: string }[]) =>
  Object.fromEntries(rs.map((r) => [r.name, r]));

describe('satisfiesRange (caret/exact)', () => {
  it('matches caret ranges including 0.x semantics', () => {
    expect(satisfiesRange('0.1.3', '^0.1.0')).toBe(true);
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false); // 0.x caret locks the minor
    expect(satisfiesRange('1.4.0', '^1.2.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('0.1.0', '0.1.0')).toBe(true);   // exact
  });
});

describe('runDoctorChecks', () => {
  it('all healthy → ok, with a check per dimension', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps());
    expect(ok).toBe(true);
    const names = results.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['safety gate', 'memory-mcp contract', 'peerDeps / fortytwo.compat', 'embedder model', 'db migrations']),
    );
  });

  it('fails (required) when the gate is not installed', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ loadGate: async () => null }));
    expect(ok).toBe(false);
    expect(byName(results)['safety gate'].ok).toBe(false);
  });

  it('fails when the gate POLICY_SCHEMA_VERSION mismatches what the CLI expects', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ loadGate: async () => ({ POLICY_SCHEMA_VERSION: 2 }) }));
    expect(ok).toBe(false);
    expect(byName(results)['safety gate'].detail).toMatch(/schema|version|expect/i);
  });

  it('fails when the memory contract version mismatches', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ loadMemory: async () => ({ MEMORY_TOOL_CONTRACT_VERSION: 9 }) }));
    expect(ok).toBe(false);
    expect(byName(results)['memory-mcp contract'].ok).toBe(false);
  });

  it('fails compat when an installed sibling has drifted outside the declared range', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({
      installedVersion: (s) => (s === '@justfortytwo/memory' ? '0.3.0' : '0.1.0'), // outside ^0.1.0
    }));
    expect(ok).toBe(false);
    expect(byName(results)['peerDeps / fortytwo.compat'].ok).toBe(false);
  });

  it('WARNS (does not fail) when Ollama is unreachable — embedder is non-required', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ ollamaModels: async () => null }));
    const embedder = byName(results)['embedder model'];
    expect(embedder.ok).toBe(false);
    expect(embedder.required).toBe(false);
    expect(ok).toBe(true); // warn-only must not fail the run
  });

  it('fails (required) when the DB has no migrations applied', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ migrationState: async () => 'missing' }));
    expect(ok).toBe(false);
    expect(byName(results)['db migrations'].detail).toMatch(/init|migrat/i);
  });

  // ---------------------------------------------------------------------------
  // Scheduler heartbeat check (warn-only)
  // ---------------------------------------------------------------------------

  it('WARNS (does not fail) when no scheduler heartbeat file exists', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({ schedulerHeartbeat: () => null }));
    const check = byName(results)['scheduler daemon'];
    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.detail).toMatch(/not running|no heartbeat/i);
    expect(ok).toBe(true); // warn-only must not fail the aggregate
  });

  it('WARNS (does not fail) when the scheduler heartbeat is stale', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({
      schedulerHeartbeat: () => ({ pid: 42, ts: FRESH_ISO }),
      now: () => NOW_STALE,
    }));
    const check = byName(results)['scheduler daemon'];
    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.detail).toMatch(/stale|stopped/i);
    expect(ok).toBe(true); // warn-only must not fail the aggregate
  });

  it('reports ok when the scheduler heartbeat is fresh', async () => {
    const { results, ok } = await runDoctorChecks(goodDeps({
      schedulerHeartbeat: () => ({ pid: 42, ts: FRESH_ISO }),
      now: () => NOW_FRESH,
    }));
    const check = byName(results)['scheduler daemon'];
    expect(check.ok).toBe(true);
    expect(check.required).toBe(false);
    expect(check.detail).toMatch(/alive/i);
    expect(check.detail).toContain('42'); // pid present in detail
    expect(ok).toBe(true);
  });
});
