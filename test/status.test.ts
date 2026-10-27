import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusLines } from '../src/commands/status.js';
import { extensionWiringProblems, readMcpExtensions, runDoctorChecks, type DoctorDeps } from '../src/commands/doctor.js';

const TRANSCRIPT = '@justfortytwo/transcript';
const installed = (...names: string[]) => (spec: string) => (names.includes(spec) ? '1.0.0-0' : null);
const base = { runtime: null, schedulerHeartbeat: null, memoryConfigured: true, nowMs: Date.now() };

describe('extensionWiringProblems', () => {
  it('is clean when installed and named in the env var', () => {
    expect(extensionWiringProblems({ memoryEntry: true, extensions: [TRANSCRIPT] }, installed(TRANSCRIPT))).toEqual([]);
  });
  it('is clean when transcript is absent and no extensions are set', () => {
    expect(extensionWiringProblems({ memoryEntry: true, extensions: [] }, installed())).toEqual([]);
  });
  it('warns when transcript is installed but FORTYTWO_MCP_EXTENSIONS lacks it', () => {
    const p = extensionWiringProblems({ memoryEntry: true, extensions: [] }, installed(TRANSCRIPT));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/FORTYTWO_MCP_EXTENSIONS/);
    expect(p[0]).toMatch(/fortytwo init/);
  });
  it('warns when the env var names a package that cannot be resolved', () => {
    const p = extensionWiringProblems({ memoryEntry: true, extensions: ['@acme/ghost'] }, installed());
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/@acme\/ghost/);
  });
  it('says nothing when there is no memory entry at all', () => {
    expect(extensionWiringProblems({ memoryEntry: false, extensions: [] }, installed(TRANSCRIPT))).toEqual([]);
  });
});

describe('readMcpExtensions', () => {
  it('parses the comma-separated env var from .mcp.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'ft-mcp-'));
    try {
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fortytwo-memory': { env: { FORTYTWO_MCP_EXTENSIONS: ' a/b , c/d ,' } } } }));
      expect(readMcpExtensions(root)).toEqual({ memoryEntry: true, extensions: ['a/b', 'c/d'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('returns null when .mcp.json is missing or unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'ft-mcp-'));
    try {
      expect(readMcpExtensions(root)).toBeNull();
      writeFileSync(join(root, '.mcp.json'), '{nope');
      expect(readMcpExtensions(root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('statusLines extension warnings', () => {
  it('adds no lines when consistent', () => {
    expect(statusLines({ ...base, extensionProblems: [] })).toHaveLength(4);
  });
  it('appends a Warning line per problem', () => {
    const lines = statusLines({ ...base, extensionProblems: ['transcript is installed but not in FORTYTWO_MCP_EXTENSIONS'] });
    expect(lines).toHaveLength(5);
    expect(lines[4]).toMatch(/^Warning/);
    expect(lines[4]).toMatch(/FORTYTWO_MCP_EXTENSIONS/);
  });
});

describe('doctor MCP extension check', () => {
  const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
    loadGate: async () => ({ POLICY_SCHEMA_VERSION: 1 }),
    loadMemory: async () => ({ MEMORY_TOOL_CONTRACT_VERSION: 1 }),
    installedVersion: installed(TRANSCRIPT),
    compatRanges: {},
    ollamaModels: async () => ['m'],
    embedModel: 'm',
    migrationState: async () => 'ok',
    schedulerHeartbeat: () => ({ pid: 1, ts: '2026-06-30T12:00:00.000Z' }),
    now: () => '2026-06-30T12:00:10.000Z',
    ...over,
  });
  const find = async (d: DoctorDeps) => (await runDoctorChecks(d)).results.find((r) => r.name === 'mcp extensions');

  it('warns (never fails) when transcript is installed but unwired', async () => {
    const d = deps({ mcpExtensions: () => ({ memoryEntry: true, extensions: [] }) });
    const r = await find(d);
    expect(r).toMatchObject({ ok: false, required: false });
    expect((await runDoctorChecks(d)).ok).toBe(true);
  });
  it('is ok when wired', async () => {
    const r = await find(deps({ mcpExtensions: () => ({ memoryEntry: true, extensions: [TRANSCRIPT] }) }));
    expect(r).toMatchObject({ ok: true });
  });
});
