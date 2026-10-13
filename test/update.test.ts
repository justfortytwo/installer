import { describe, it, expect } from 'vitest';
import {
  pickLatestInRange,
  resolveLatestInRange,
  performUpdate,
  performRollback,
  type UpdateDeps,
  type RollbackDeps,
} from '../src/commands/update.js';
import type { VersionPin, InstallState } from '../src/state.js';
import type { CheckResult } from '../src/commands/doctor.js';

const okCheck: CheckResult = { name: 'gate', ok: true, required: true, detail: 'fine' };
const failCheck: CheckResult = { name: 'gate', ok: false, required: true, detail: 'broken' };

function stateWith(current: VersionPin[], previous: VersionPin[] | null = null): InstallState {
  return { stateVersion: 1, current, previous, lastUpdatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('pickLatestInRange', () => {
  it('returns the highest version satisfying a caret range', () => {
    expect(pickLatestInRange(['0.1.0', '0.1.2', '0.1.3', '0.2.0'], '^0.1.1')).toBe('0.1.3');
  });
  it('ignores versions outside the range', () => {
    expect(pickLatestInRange(['0.1.0', '0.2.0', '1.0.0'], '^0.1.0')).toBe('0.1.0');
  });
  it('returns null when nothing satisfies', () => {
    expect(pickLatestInRange(['0.2.0', '0.3.0'], '^0.1.0')).toBeNull();
  });
  it('compares numerically, not lexically (0.1.10 > 0.1.9)', () => {
    expect(pickLatestInRange(['0.1.9', '0.1.10'], '^0.1.0')).toBe('0.1.10');
  });
  it('an exact pre-release pin resolves to exactly that version (no newer pre-release / stable)', () => {
    expect(pickLatestInRange(['0.1.5', '1.0.0-0', '1.0.0-1', '1.0.0'], '1.0.0-0')).toBe('1.0.0-0');
  });
  it('a caret range never resolves to a pre-release', () => {
    expect(pickLatestInRange(['0.1.5', '0.1.6-0'], '^0.1.0')).toBe('0.1.5');
  });
  it('orders pre-releases below their release', () => {
    expect(pickLatestInRange(['1.0.0', '1.0.0-1', '1.0.0-0'], '^1.0.0-0')).toBe('1.0.0');
  });
});

describe('resolveLatestInRange', () => {
  const published: Record<string, string[]> = {
    '@justfortytwo/memory': ['0.1.0', '0.1.2', '0.1.3'],
    '@justfortytwo/gate': ['0.1.0'],
  };
  const fetchVersions = async (pkg: string): Promise<string[]> => published[pkg] ?? [];

  it('resolves each declared range to its latest-in-range pin', async () => {
    const pins = await resolveLatestInRange(
      { '@justfortytwo/memory': '^0.1.1', '@justfortytwo/gate': '^0.1.0' },
      fetchVersions,
    );
    expect(pins).toEqual([
      { name: '@justfortytwo/memory', range: '^0.1.1', resolved: '0.1.3' },
      { name: '@justfortytwo/gate', range: '^0.1.0', resolved: '0.1.0' },
    ]);
  });

  it('throws when a package has no satisfying published version', async () => {
    await expect(
      resolveLatestInRange({ '@justfortytwo/memory': '^9.0.0' }, fetchVersions),
    ).rejects.toThrow(/no published version of @justfortytwo\/memory/);
  });
});

const COMPAT = { '@justfortytwo/memory': '^0.1.1' };

interface UpdateRec {
  installed: string[][];
  recorded: VersionPin[][];
  rendered: number;
  out: string;
  err: string;
}

function fakeUpdateDeps(over: {
  state?: InstallState | null;
  compatRanges?: Record<string, string>;
  installed?: Record<string, string>;
  published?: Record<string, string[]>;
  installOk?: boolean;
  doctorOk?: boolean;
} = {}): { deps: UpdateDeps; rec: UpdateRec } {
  const rec: UpdateRec = { installed: [], recorded: [], rendered: 0, out: '', err: '' };
  const installed = over.installed ?? {};
  const published = over.published ?? {};
  const deps: UpdateDeps = {
    readState: () => (over.state === undefined ? stateWith([]) : over.state),
    installedVersion: (s) => installed[s] ?? null,
    compatRanges: over.compatRanges ?? {},
    fetchVersions: async (pkg) => published[pkg] ?? [],
    install: (specs) => {
      rec.installed.push(specs);
      return { ok: over.installOk ?? true, detail: over.installOk === false ? 'boom' : 'ok' };
    },
    doctor: async () => ({
      results: [over.doctorOk === false ? failCheck : okCheck],
      ok: over.doctorOk ?? true,
    }),
    record: (pins) => { rec.recorded.push(pins); },
    reconcile: async () => { rec.rendered++; },
    out: (s) => { rec.out += s; },
    err: (s) => { rec.err += s; },
  };
  return { deps, rec };
}

describe('performUpdate', () => {
  it('returns 2 when no install state exists', async () => {
    const { deps, rec } = fakeUpdateDeps({ state: null });
    expect(await performUpdate(deps, {})).toBe(2);
    expect(rec.err).toMatch(/run `fortytwo init`/);
  });

  it('returns 2 when no engine packages are installed', async () => {
    const { deps, rec } = fakeUpdateDeps({ compatRanges: COMPAT, installed: {} });
    expect(await performUpdate(deps, {})).toBe(2);
    expect(rec.err).toMatch(/no engine packages/);
  });

  it('is a no-op when already at the latest in-range version', async () => {
    const { deps, rec } = fakeUpdateDeps({
      compatRanges: COMPAT,
      installed: { '@justfortytwo/memory': '0.1.3' },
      published: { '@justfortytwo/memory': ['0.1.0', '0.1.3'] },
    });
    expect(await performUpdate(deps, {})).toBe(0);
    expect(rec.installed).toEqual([]);
    expect(rec.recorded).toEqual([]);
    expect(rec.out).toMatch(/already at the latest/);
  });

  it('dry-run resolves + reports but does not install or record', async () => {
    const { deps, rec } = fakeUpdateDeps({
      compatRanges: COMPAT,
      installed: { '@justfortytwo/memory': '0.1.2' },
      published: { '@justfortytwo/memory': ['0.1.2', '0.1.3'] },
    });
    expect(await performUpdate(deps, { dryRun: true })).toBe(0);
    expect(rec.installed).toEqual([]);
    expect(rec.recorded).toEqual([]);
    expect(rec.out).toMatch(/0\.1\.2 → 0\.1\.3/);
  });

  it('happy path: installs target, rotates the ledger, doctor passes → 0 + runtime reconciliation', async () => {
    const { deps, rec } = fakeUpdateDeps({
      compatRanges: COMPAT,
      installed: { '@justfortytwo/memory': '0.1.2' },
      published: { '@justfortytwo/memory': ['0.1.2', '0.1.3'] },
      doctorOk: true,
    });
    expect(await performUpdate(deps, {})).toBe(0);
    expect(rec.installed).toEqual([['@justfortytwo/memory@0.1.3']]);
    expect(rec.recorded).toEqual([[{ name: '@justfortytwo/memory', range: '^0.1.1', resolved: '0.1.3' }]]);
    expect(rec.rendered).toBe(1);
  });

  it('install ok but doctor fails → records (rollback target) and returns 1 pointing at rollback', async () => {
    const { deps, rec } = fakeUpdateDeps({
      compatRanges: COMPAT,
      installed: { '@justfortytwo/memory': '0.1.2' },
      published: { '@justfortytwo/memory': ['0.1.2', '0.1.3'] },
      doctorOk: false,
    });
    expect(await performUpdate(deps, {})).toBe(1);
    expect(rec.recorded.length).toBe(1); // ledger rotated so rollback has the pre-update set
    expect(rec.rendered).toBe(0); // never reconcile an unhealthy engine
    expect(rec.err).toMatch(/rollback/);
  });

  it('install failure → does NOT record (previous set preserved) and returns 1', async () => {
    const { deps, rec } = fakeUpdateDeps({
      compatRanges: COMPAT,
      installed: { '@justfortytwo/memory': '0.1.2' },
      published: { '@justfortytwo/memory': ['0.1.2', '0.1.3'] },
      installOk: false,
    });
    expect(await performUpdate(deps, {})).toBe(1);
    expect(rec.recorded).toEqual([]);
    expect(rec.err).toMatch(/install failed/);
  });
});

describe('performRollback', () => {
  const prev: VersionPin[] = [{ name: '@justfortytwo/memory', range: '^0.1.0', resolved: '0.1.2' }];
  const cur: VersionPin[] = [{ name: '@justfortytwo/memory', range: '^0.1.0', resolved: '0.1.3' }];

  function fakeRollbackDeps(over: { state?: InstallState | null; installOk?: boolean; doctorOk?: boolean } = {}): {
    deps: RollbackDeps;
    rec: { installed: string[][]; recorded: VersionPin[][]; out: string; err: string };
  } {
    const rec = { installed: [] as string[][], recorded: [] as VersionPin[][], out: '', err: '' };
    const deps: RollbackDeps = {
      readState: () => (over.state === undefined ? stateWith(cur, prev) : over.state),
      install: (specs) => {
        rec.installed.push(specs);
        return { ok: over.installOk ?? true, detail: 'x' };
      },
      doctor: async () => ({ results: [okCheck], ok: over.doctorOk ?? true }),
      record: (pins) => { rec.recorded.push(pins); },
      out: (s) => { rec.out += s; },
      err: (s) => { rec.err += s; },
    };
    return { deps, rec };
  }

  it('returns 2 when there is no state', async () => {
    const { deps } = fakeRollbackDeps({ state: null });
    expect(await performRollback(deps)).toBe(2);
  });

  it('returns 2 when there is no previous set', async () => {
    const { deps, rec } = fakeRollbackDeps({ state: stateWith(cur, null) });
    expect(await performRollback(deps)).toBe(2);
    expect(rec.err).toMatch(/no prior version set/);
  });

  it('restores the previous set: installs it, records, doctor passes → 0', async () => {
    const { deps, rec } = fakeRollbackDeps({});
    expect(await performRollback(deps)).toBe(0);
    expect(rec.installed).toEqual([['@justfortytwo/memory@0.1.2']]);
    expect(rec.recorded).toEqual([prev]);
  });
});


describe('update lifecycle guard', () => {
  it.each(['0.1.2', '0.1.3'])('refuses running services before installing or reconciling version %s', async version => {
    const { deps, rec } = fakeUpdateDeps({ compatRanges: COMPAT, installed: { '@justfortytwo/memory': version }, published: { '@justfortytwo/memory': ['0.1.3'] } });
    deps.runtimeActive = () => true;
    expect(await performUpdate(deps, {})).toBe(1);
    expect(rec.installed).toEqual([]); expect(rec.rendered).toBe(0);
    expect(rec.err).toContain('fortytwo stop');
    expect(await performUpdate(deps, {dryRun:true})).toBe(0);
    expect(rec.rendered).toBe(0);
  });
});


describe('externally invoked installer bootstrap', () => {
  function bootstrap() {
    const installed = { '@justfortytwo/installer': '1.0.0-9', '@justfortytwo/persona': '1.0.0-0' };
    const { deps, rec } = fakeUpdateDeps({ installed, compatRanges: { '@justfortytwo/persona': '1.0.0-1' }, published: { '@justfortytwo/persona': ['1.0.0-0', '1.0.0-1'] } });
    const events: string[] = [];
    deps.runningInstallerVersion = () => '1.0.0-10';
    deps.persistInstaller = spec => { events.push(spec); installed['@justfortytwo/installer'] = '1.0.0-10'; return {ok:true,detail:''}; };
    const fetch = deps.fetchVersions;
    deps.fetchVersions = pkg => { events.push('resolve'); return fetch(pkg); };
    const install = deps.install;
    deps.install = specs => { installed['@justfortytwo/persona'] = '1.0.0-1'; return install(specs); };
    return {deps,rec,events,installed};
  }
  it('persists the running exact version before resolving its matrix and is repeatable', async () => {
    const {deps,rec,events,installed} = bootstrap();
    expect(await performUpdate(deps, {})).toBe(0);
    expect(events).toEqual(['@justfortytwo/installer@1.0.0-10','resolve']);
    expect(installed['@justfortytwo/installer']).toBe('1.0.0-10');
    expect(rec.installed).toEqual([['@justfortytwo/persona@1.0.0-1']]);
    expect(await performUpdate(deps, {})).toBe(0);
    expect(events.filter(e => e.startsWith('@'))).toHaveLength(1);
    expect(rec.installed).toHaveLength(1);
    expect(rec.rendered).toBe(2);
  });
  it('dry-run leaves installer and engine state untouched', async () => {
    const {deps,rec,events,installed} = bootstrap();
    expect(await performUpdate(deps, {dryRun:true})).toBe(0);
    expect(events).toEqual(['resolve']);
    expect(installed['@justfortytwo/installer']).toBe('1.0.0-9');
    expect(rec.installed).toEqual([]); expect(rec.rendered).toBe(0);
  });
  it('refuses a live runtime before persistence or registry access', async () => {
    const {deps,events} = bootstrap(); deps.runtimeActive = () => true;
    expect(await performUpdate(deps, {})).toBe(1); expect(events).toEqual([]);
  });
  it('stops when exact installer installation fails', async () => {
    const {deps,events,rec} = bootstrap();
    deps.persistInstaller = () => ({ok:false,detail:'disk full'});
    expect(await performUpdate(deps, {})).toBe(1);
    expect(events).toEqual([]); expect(rec.rendered).toBe(0);
    expect(rec.err).toContain('disk full');
  });
  it('never downgrades a newer project installer', async () => {
    const {deps,events} = bootstrap(); deps.runningInstallerVersion = () => '1.0.0-8';
    expect(await performUpdate(deps, {})).toBe(1); expect(events).toEqual([]);
  });
});
