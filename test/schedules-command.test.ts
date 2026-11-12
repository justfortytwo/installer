import { describe, it, expect } from 'vitest';
import { parseSchedulesArgs, performSchedules, type SchedulesDeps } from '../src/commands/schedules.js';
import type { ScheduleChoice, ScheduleOptions } from '../src/schedules.js';
import { resolveVerb } from '../src/index.js';

const CHOICES: ScheduleChoice[] = [
  { kind: 'daily_briefing', description: 'Daily briefing', enabled: true },
  { kind: 'sweep', description: 'Open-thread sweep', enabled: true },
  { kind: 'learn_review', description: 'Weekly learn-review', enabled: false },
];

function harness(over: { options?: Partial<ScheduleOptions> | null; answers?: string[]; running?: boolean } = {}) {
  const saved: ScheduleChoice[][] = [];
  let out = ''; let err = '';
  const options: ScheduleOptions | null = over.options === null
    ? null
    : { choices: CHOICES, save: (c) => { saved.push(c); }, ...over.options };
  const deps: SchedulesDeps = {
    load: async () => options,
    ask: over.answers ? async () => over.answers!.shift() ?? '' : undefined,
    running: () => over.running ?? false,
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  };
  const state = () => saved.map((cs) => Object.fromEntries(cs.map((c) => [c.kind, c.enabled])));
  return { deps, state, out: () => out, err: () => err };
}

describe('parseSchedulesArgs', () => {
  it('reads --list and --set', () => {
    expect(parseSchedulesArgs(['--list'])).toEqual({ list: true });
    expect(parseSchedulesArgs(['--set', 'sweep,learn_review'])).toEqual({ set: 'sweep,learn_review' });
    expect(parseSchedulesArgs([])).toEqual({});
  });
  it('treats --set without a value as empty, so it is rejected instead of ignored', () => {
    expect(parseSchedulesArgs(['--set'])).toEqual({ set: '' });
  });
});

describe('performSchedules', () => {
  it('lists the current choice and saves nothing when nobody can answer', async () => {
    const h = harness();
    expect(await performSchedules(h.deps, {})).toBe(0);
    expect(h.out()).toContain('[on ] daily_briefing');
    expect(h.out()).toContain('[off] learn_review');
    expect(h.state()).toEqual([]);
  });

  it('--list never asks or saves, even in a terminal', async () => {
    const h = harness({ answers: ['n', 'n', 'n'] });
    expect(await performSchedules(h.deps, { list: true })).toBe(0);
    expect(h.state()).toEqual([]);
  });

  it('asks about each job in a terminal and saves the answers', async () => {
    const h = harness({ answers: ['n', '', 'y'] });
    expect(await performSchedules(h.deps, {})).toBe(0);
    expect(h.state()).toEqual([{ daily_briefing: false, sweep: true, learn_review: true }]);
    expect(h.out()).toContain('[off] daily_briefing');
  });

  it('--set saves without asking', async () => {
    const h = harness({ answers: ['y', 'y', 'y'] });
    expect(await performSchedules(h.deps, { set: 'sweep' })).toBe(0);
    expect(h.state()).toEqual([{ daily_briefing: false, sweep: true, learn_review: false }]);
  });

  it('rejects an unknown job in --set and saves nothing', async () => {
    const h = harness();
    expect(await performSchedules(h.deps, { set: 'briefing' })).toBe(2);
    expect(h.err()).toMatch(/--set: unknown schedule\(s\) briefing/);
    expect(h.state()).toEqual([]);
  });

  it('rejects an empty --set instead of switching everything off', async () => {
    const h = harness();
    expect(await performSchedules(h.deps, { set: '' })).toBe(2);
    expect(h.state()).toEqual([]);
  });

  it('says a restart is needed while Fortytwo is running, and not otherwise', async () => {
    const running = harness({ running: true });
    await performSchedules(running.deps, { set: 'all' });
    expect(running.out()).toContain('restart it to apply');

    const stopped = harness({ running: false });
    await performSchedules(stopped.deps, { set: 'all' });
    expect(stopped.out()).toContain('Applies the next time Fortytwo starts.');
  });

  it('fails clearly when the project has no scheduler that supports the choice', async () => {
    const h = harness({ options: null });
    expect(await performSchedules(h.deps, { set: 'all' })).toBe(2);
    expect(h.err()).toContain('fortytwo update');
  });

  it('reports an unreadable saved file when listing, and lets --set replace it', async () => {
    const listing = harness({ options: { unreadable: '.fortytwo/schedules.json: not valid JSON' } });
    expect(await performSchedules(listing.deps, { list: true })).toBe(1);
    expect(listing.err()).toContain('not valid JSON');

    const fixing = harness({ options: { unreadable: '.fortytwo/schedules.json: not valid JSON' } });
    expect(await performSchedules(fixing.deps, { set: 'none' })).toBe(0);
    expect(fixing.state()).toEqual([{ daily_briefing: false, sweep: false, learn_review: false }]);
  });
});

describe('verb dispatch', () => {
  it('knows the schedules verb', () => {
    expect(resolveVerb(['schedules', '--list'], 'fortytwo')).toBe('schedules');
  });
});
