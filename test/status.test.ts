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

describe('declared-but-absent transcript (chat not recorded)', () => {
  const MEM = '@justfortytwo/memory';
  const compat = { [MEM]: '1.0.0-3', [TRANSCRIPT]: '^1.0.0-0' };

  it('warns when compat declares transcript, memory is installed and transcript is not', () => {
    const p = extensionWiringProblems({ memoryEntry: true, extensions: [] }, installed(MEM), compat);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/chat is not being recorded/);
    expect(p[0]).toMatch(/fortytwo update/);
  });
  it('warns even without a .mcp.json memory entry', () => {
    expect(extensionWiringProblems(null, installed(MEM), compat)).toHaveLength(1);
  });
  it('is silent when transcript is installed, memory is absent, or compat does not declare it', () => {
    expect(extensionWiringProblems({ memoryEntry: true, extensions: [TRANSCRIPT], args: ['-y', '-p', MEM, '-p', TRANSCRIPT, 'fortytwo-memory'] }, installed(MEM, TRANSCRIPT), compat)).toEqual([]);
    expect(extensionWiringProblems(null, installed(), compat)).toEqual([]);
    expect(extensionWiringProblems(null, installed(MEM), { [MEM]: '1.0.0-3' })).toEqual([]);
  });
  it('doctor warns but keeps the aggregate ok', async () => {
    const d: DoctorDeps = {
      loadGate: async () => ({ POLICY_SCHEMA_VERSION: 1 }),
      loadMemory: async () => ({ MEMORY_TOOL_CONTRACT_VERSION: 1 }),
      installedVersion: (s) => (s === MEM ? '1.0.0-3' : null),
      compatRanges: compat,
      ollamaModels: async () => ['m'],
      embedModel: 'm',
      migrationState: async () => 'ok',
      schedulerHeartbeat: () => ({ pid: 1, ts: '2026-06-30T12:00:00.000Z' }),
      now: () => '2026-06-30T12:00:10.000Z',
    };
    const { results, ok } = await runDoctorChecks(d);
    const r = results.find((x) => x.name === 'mcp extensions');
    expect(r).toMatchObject({ ok: false, required: false });
    expect(r!.detail).toMatch(/chat is not being recorded/);
    expect(ok).toBe(true);
  });
});

describe('extension launch args (-p <ext>)', () => {
  it('warns when an env-listed extension is missing from the npx -p args', () => {
    const p = extensionWiringProblems(
      { memoryEntry: true, extensions: [TRANSCRIPT], args: ['-y', '@justfortytwo/memory'] },
      installed(TRANSCRIPT),
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/-p @justfortytwo\/transcript/);
  });
  it('is clean when every extension has its -p', () => {
    expect(extensionWiringProblems(
      { memoryEntry: true, extensions: [TRANSCRIPT], args: ['-y', '-p', '@justfortytwo/memory', '-p', TRANSCRIPT, 'fortytwo-memory'] },
      installed(TRANSCRIPT),
    )).toEqual([]);
  });
  it('readMcpExtensions returns the entry args', () => {
    const root = mkdtempSync(join(tmpdir(), 'ft-mcp-'));
    try {
      const args = ['-y', '-p', '@justfortytwo/memory', '-p', TRANSCRIPT, 'fortytwo-memory'];
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fortytwo-memory': { args, env: { FORTYTWO_MCP_EXTENSIONS: TRANSCRIPT } } } }));
      expect(readMcpExtensions(root)).toEqual({ memoryEntry: true, extensions: [TRANSCRIPT], args });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
