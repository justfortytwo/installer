// The user-level `fortytwo` launcher (src/shim.ts) and the project-local CLI pin
// (cliInstallSpec): where init puts the launcher, that it never clobbers a file
// it did not write, and — by actually running the POSIX script — that it
// dispatches to the CLI of the project you are in, and only that one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SHIM_SCRIPT, chooseShimDir, findOnPath, installShim, userPathDirs, type ShimEnv } from '../src/shim.js';
import { CLI_PACKAGE, cliInstallSpec, shimReport } from '../src/commands/init.js';
import { readSelfCompatRanges } from '../src/engine.js';

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ft-shim-')));
  home = join(tmp, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const env = (over: Partial<ShimEnv> = {}): ShimEnv => ({
  home,
  pathEnv: [join(home, '.local', 'bin'), '/usr/bin', '/bin'].join(delimiter),
  platform: 'linux',
  npmGlobalBin: () => null,
  ...over,
});

describe('installShim', () => {
  it('installs an executable, project-agnostic launcher into ~/.local/bin when it is on PATH', () => {
    const r = installShim(env());
    const target = join(home, '.local', 'bin', 'fortytwo');
    expect(r).toEqual({ status: 'installed', path: target });
    expect(readFileSync(target, 'utf8')).toBe(SHIM_SCRIPT);
    expect(SHIM_SCRIPT).not.toMatch(/\/(home|Users|tmp|private)\//); // no hardcoded project path
    expect(SHIM_SCRIPT).not.toMatch(/\d+\.\d+\.\d+/); // no hardcoded version
    expect(spawnSync('test', ['-x', target]).status).toBe(0);
  });

  it('is idempotent: a re-run leaves exactly one identical launcher', () => {
    installShim(env());
    const again = installShim(env({ pathEnv: [join(home, '.local', 'bin'), '/usr/bin'].join(delimiter) }));
    expect(again.status).toBe('unchanged');
    expect(readdirSync(join(home, '.local', 'bin'))).toEqual(['fortytwo']);
    expect(readFileSync(join(home, '.local', 'bin', 'fortytwo'), 'utf8')).toBe(SHIM_SCRIPT);
  });

  it('refreshes an older launcher of ours in place', () => {
    const target = join(home, '.local', 'bin', 'fortytwo');
    writeFileSync(target, '#!/bin/sh\n# fortytwo-shim v0\n', { mode: 0o755 });
    expect(installShim(env())).toEqual({ status: 'updated', path: target });
    expect(readFileSync(target, 'utf8')).toBe(SHIM_SCRIPT);
  });

  it('never overwrites a fortytwo it did not write', () => {
    const target = join(home, '.local', 'bin', 'fortytwo');
    writeFileSync(target, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    expect(installShim(env())).toEqual({ status: 'foreign', path: target });
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    // also with an explicit FORTYTWO_BIN_DIR
    expect(installShim(env({ override: join(home, '.local', 'bin') })).status).toBe('foreign');
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('leaves a foreign fortytwo earlier on PATH alone instead of adding a second one', () => {
    const other = join(tmp, 'global-bin');
    mkdirSync(other);
    writeFileSync(join(other, 'fortytwo'), '#!/bin/sh\n', { mode: 0o755 });
    const r = installShim(env({ pathEnv: [other, join(home, '.local', 'bin')].join(delimiter) }));
    expect(r).toEqual({ status: 'foreign', path: join(other, 'fortytwo') });
    expect(readdirSync(join(home, '.local', 'bin'))).toEqual([]);
    expect(shimReport(r).cmd).toBe('npx fortytwo');
  });

  it("ignores npm's transient node_modules/.bin PATH entries (e.g. the npx cache's own fortytwo)", () => {
    const npxBin = join(tmp, '_npx', 'abc', 'node_modules', '.bin');
    const projBin = join(tmp, 'proj', 'node_modules', '.bin');
    for (const d of [npxBin, projBin]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'fortytwo'), '#!/bin/sh\n', { mode: 0o755 });
    }
    const pathEnv = [projBin, npxBin, join(home, '.local', 'bin')].join(delimiter);
    expect(userPathDirs(pathEnv)).toEqual([join(home, '.local', 'bin')]);
    expect(findOnPath('fortytwo', pathEnv)).toBeNull();
    expect(installShim(env({ pathEnv })).status).toBe('installed');
  });

  it('never picks a directory that is not already on PATH', () => {
    // ~/.local/bin exists but is not on PATH (macOS default): fall through to npm's global bin
    const npmBin = join(tmp, 'npm-prefix', 'bin');
    mkdirSync(npmBin, { recursive: true });
    const e = env({ pathEnv: [npmBin, '/usr/bin'].join(delimiter), npmGlobalBin: () => npmBin });
    expect(chooseShimDir(e)).toBe(npmBin);
    // nothing suitable on PATH at all: no-dir, and init falls back to `npx fortytwo`
    const none = env({ pathEnv: '/usr/bin' });
    const r = installShim(none);
    expect(r.status).toBe('no-dir');
    expect(readdirSync(join(home, '.local', 'bin'))).toEqual([]);
    expect(shimReport(r).cmd).toBe('npx fortytwo');
  });

  it('honours FORTYTWO_BIN_DIR, and does nothing on Windows', () => {
    const dir = join(tmp, 'custom-bin');
    expect(installShim(env({ override: dir, pathEnv: '' }))).toEqual({ status: 'installed', path: join(dir, 'fortytwo') });
    expect(installShim(env({ platform: 'win32' })).status).toBe('unsupported');
  });
});

// --- the launcher itself, run with /bin/sh ---

/** A project whose local CLI prints its version and the cwd it ran in. */
function project(name: string, version: string | null): string {
  const root = join(tmp, name);
  mkdirSync(join(root, '.fortytwo'), { recursive: true });
  if (version) {
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'fortytwo'), `#!/bin/sh\necho "cli ${version} cwd=$(pwd -P) args=$*"\n`, { mode: 0o755 });
  }
  return root;
}

function runShim(cwd: string, ...args: string[]) {
  const shim = join(tmp, 'fortytwo-shim.sh');
  writeFileSync(shim, SHIM_SCRIPT);
  chmodSync(shim, 0o755);
  const r = spawnSync('/bin/sh', [shim, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe.skipIf(process.platform === 'win32')('the launcher script', () => {
  it("runs the current project's own CLI version, from the project root", () => {
    const a = project('a', '1.0.0-6');
    const b = project('b', '1.0.0-7');
    mkdirSync(join(a, 'context', 'deep'), { recursive: true });

    expect(runShim(a, 'status')).toEqual({ code: 0, out: `cli 1.0.0-6 cwd=${a} args=status`, err: '' });
    expect(runShim(join(a, 'context', 'deep'), 'pair', '--force').out).toBe(`cli 1.0.0-6 cwd=${a} args=pair --force`);
    expect(runShim(b, '--version').out).toBe(`cli 1.0.0-7 cwd=${b} args=--version`);
  });

  it('uses the NEAREST project when projects are nested', () => {
    const outer = project('outer', '1.0.0-5');
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, '.fortytwo'), { recursive: true });
    mkdirSync(join(inner, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(inner, 'node_modules', '.bin', 'fortytwo'), '#!/bin/sh\necho inner\n', { mode: 0o755 });
    expect(runShim(inner).out).toBe('inner');
  });

  it('fails clearly outside a Fortytwo project, without running an ancestor package', () => {
    // an ancestor with a fortytwo bin but NO .fortytwo/ must never be executed
    const ancestor = join(tmp, 'not-a-project');
    mkdirSync(join(ancestor, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(ancestor, 'node_modules', '.bin', 'fortytwo'), '#!/bin/sh\necho WRONG\n', { mode: 0o755 });
    const cwd = join(ancestor, 'sub');
    mkdirSync(cwd);

    const r = runShim(cwd, 'start');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('not inside a Fortytwo project');
    expect(r.err).toContain('npx @justfortytwo/installer init');
  });

  it('explains a project whose CLI is not installed', () => {
    const p = project('bare', null);
    const r = runShim(p, 'start');
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${p} is a Fortytwo project, but its CLI is not installed`);
    expect(r.err).toContain('npm install @justfortytwo/installer');
  });
});

describe('project-local CLI pin', () => {
  it('pins this exact version into the project unless it is already there', () => {
    expect(cliInstallSpec('1.0.0-7', null)).toBe(`${CLI_PACKAGE}@1.0.0-7`);
    expect(cliInstallSpec('1.0.0-7', '1.0.0-6')).toBe(`${CLI_PACKAGE}@1.0.0-7`); // re-init with a newer installer moves it
    expect(cliInstallSpec('1.0.0-7', '1.0.0-7')).toBeNull(); // idempotent
    expect(cliInstallSpec(null, null)).toBeNull();
    expect(cliInstallSpec('1.0.0-7', null, '/tmp/installer.tgz')).toBe('/tmp/installer.tgz'); // FORTYTWO_INSTALLER_SPEC
  });

  it('is never moved by `fortytwo update`: the installer is not in fortytwo.compat', () => {
    // update/rollback only touch compat packages, so the project CLI changes
    // only when init is re-run with another installer version.
    expect(Object.keys(readSelfCompatRanges())).not.toContain(CLI_PACKAGE);
  });
});
