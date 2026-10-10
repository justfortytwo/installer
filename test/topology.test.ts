// Regression: engine siblings resolve from the TARGET PROJECT, not the installer.
//
// Under `npx create-fortytwo init` the installer runs from npm's exec cache
// (~/.npm/_npx/<hash>/node_modules) while `init` installs the engine into the
// project's node_modules — two separate trees. Resolving from import.meta.url
// (bare `import(spec)`, `createRequire(import.meta.url)`, or walking up from the
// installer's file) missed the project's engine: init died on
// "Cannot find module '@justfortytwo/persona/manifest.json'" and doctor reported
// gate/memory "not installed".
//
// Here the installer is this repo (its own node_modules tree) and the target is a
// tmp project with FIXTURE siblings carrying distinctive versions/markers, so a
// lookup that strays into the installer's tree is detected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSiblingDir, loadSibling, loadGate, readInstalledVersion, resolveEsmEntry,
} from '../src/engine.js';
import { loadPersonaManifest } from '../src/render.js';

function writePkg(projectDir: string, name: string, pkg: Record<string, unknown>, files: Record<string, string>): void {
  const dir = join(projectDir, 'node_modules', ...name.split('/'));
  for (const [rel, body] of Object.entries({ 'package.json': JSON.stringify({ name, type: 'module', ...pkg }), ...files })) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

let target: string;
let cwd0: string;
beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'ft-topology-'));
  cwd0 = process.cwd();
});
afterEach(() => {
  process.chdir(cwd0);
  rmSync(target, { recursive: true, force: true });
});

describe('sibling resolution: installer and target project in separate node_modules trees', () => {
  beforeEach(() => {
    // gate: import-only exports map (defeats require.resolve, as the real gate does)
    writePkg(target, '@justfortytwo/gate', {
      version: '9.9.9-fixture',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }, { 'dist/index.js': "export const POLICY_SCHEMA_VERSION = 'from-target-project';\n" });
    // persona: no exports map, manifest at the package root (as the real persona)
    writePkg(target, '@justfortytwo/persona', { version: '9.9.9-fixture' }, {
      'manifest.json': JSON.stringify({
        manifestVersion: 1,
        files: [{ template: 'CLAUDE.md', output: 'CLAUDE.md', mode: 'managed' }],
        fields: [{ key: 'agent_name', prompt: 'p', type: 'string', required: true, default: null }],
      }),
      'templates/CLAUDE.md': '# {{agent_name}}\n',
    });
  });

  it('imports and versions siblings from the project root (cwd), not the installer', async () => {
    process.chdir(target);
    expect(readInstalledVersion('@justfortytwo/gate')).toBe('9.9.9-fixture');
    expect((await loadGate())?.POLICY_SCHEMA_VERSION).toBe('from-target-project');
  });

  it('loads the persona manifest from the project root', () => {
    process.chdir(target);
    const m = loadPersonaManifest();
    expect(m.requiredVars).toEqual(['agent_name']);
    expect(m.templatesDir.startsWith(findSiblingDir('@justfortytwo/persona')!)).toBe(true);
    expect(findSiblingDir('@justfortytwo/persona')).toContain('ft-topology-');
  });

  it('walks up from a subdirectory of the project, like Node', async () => {
    const sub = join(target, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(readInstalledVersion('@justfortytwo/gate', sub)).toBe('9.9.9-fixture');
    expect((await loadSibling<{ POLICY_SCHEMA_VERSION?: string }>('@justfortytwo/gate', sub))?.POLICY_SCHEMA_VERSION)
      .toBe('from-target-project');
  });

  it('never falls back to siblings living next to the installer', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ft-topology-empty-'));
    try {
      process.chdir(empty);
      // The installer's own tree may well contain these (linked/CI-installed) —
      // they must NOT be picked up for a project that lacks them.
      expect(readInstalledVersion('@justfortytwo/gate')).toBeNull();
      expect(await loadGate()).toBeNull();
      expect(() => loadPersonaManifest()).toThrow(/@justfortytwo\/persona is not installed in/);
    } finally {
      process.chdir(cwd0);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('resolveEsmEntry', () => {
  it('handles the export shapes the siblings use', () => {
    expect(resolveEsmEntry({ exports: { '.': { types: './d.ts', import: './dist/index.js' }, './x': './x.js' } })).toBe('./dist/index.js'); // gate/telegram
    expect(resolveEsmEntry({ exports: { '.': './dist/index.js', './contract': './c.js' } })).toBe('./dist/index.js'); // memory
    expect(resolveEsmEntry({ exports: './dist/index.js' })).toBe('./dist/index.js');
    expect(resolveEsmEntry({ exports: { import: './esm.js', require: './cjs.cjs' } })).toBe('./esm.js');
    expect(resolveEsmEntry({ exports: { '.': { node: { import: './n.js' } } } })).toBe('./n.js');
    expect(resolveEsmEntry({ main: 'lib/main.js' })).toBe('lib/main.js');
    expect(resolveEsmEntry({})).toBe('index.js');
  });
  it('returns null when the root is not importable', () => {
    expect(resolveEsmEntry({ exports: { '.': { require: './cjs.cjs' } } })).toBeNull();
    expect(resolveEsmEntry({ exports: { './only-sub': './s.js' } })).toBeNull();
  });
});
