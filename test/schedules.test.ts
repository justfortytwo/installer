import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applySchedulesFlag, askSchedules, loadScheduleOptions, schedulesReport, type ScheduleChoice,
} from '../src/schedules.js';
import { findSiblingDir } from '../src/engine.js';
import { linkEngineInto } from './helpers/engine.js';

const CHOICES: ScheduleChoice[] = [
  { kind: 'daily_briefing', description: 'Daily briefing', enabled: true },
  { kind: 'sweep', description: 'Open-thread sweep', enabled: true },
  { kind: 'learn_review', description: 'Weekly learn-review', enabled: false },
];
const state = (cs: ScheduleChoice[]) => Object.fromEntries(cs.map((c) => [c.kind, c.enabled]));

describe('applySchedulesFlag', () => {
  it('all / none switch every built-in job', () => {
    expect(state(applySchedulesFlag(CHOICES, 'all'))).toEqual({ daily_briefing: true, sweep: true, learn_review: true });
    expect(state(applySchedulesFlag(CHOICES, ' None '))).toEqual({ daily_briefing: false, sweep: false, learn_review: false });
  });

  it('a list enables exactly those jobs and switches the rest off', () => {
    expect(state(applySchedulesFlag(CHOICES, 'sweep, learn_review'))).toEqual({ daily_briefing: false, sweep: true, learn_review: true });
  });

  it('rejects an unknown job, naming the valid ones', () => {
    expect(() => applySchedulesFlag(CHOICES, 'sweep,briefing')).toThrow(/unknown schedule\(s\) briefing.*daily_briefing, sweep, learn_review/);
  });

  it('rejects an empty value instead of switching everything off', () => {
    expect(() => applySchedulesFlag(CHOICES, ' , ')).toThrow(/no schedule given/);
  });
});

describe('askSchedules', () => {
  const asker = (answers: string[]) => {
    const prompts: string[] = [];
    return { prompts, ask: async (p: string) => { prompts.push(p); return answers.shift() ?? ''; } };
  };

  it('asks once per job, showing its description and current default', async () => {
    const { prompts, ask } = asker([]);
    await askSchedules(CHOICES, ask);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Daily briefing');
    expect(prompts[0]).toContain('[Y/n]');
    expect(prompts[2]).toContain('[y/N]');
  });

  it('Enter keeps the current choice', async () => {
    expect(state(await askSchedules(CHOICES, asker(['', '', '']).ask))).toEqual(state(CHOICES));
  });

  it('y / n change it; anything else keeps it', async () => {
    expect(state(await askSchedules(CHOICES, asker(['n', 'maybe', 'YES']).ask)))
      .toEqual({ daily_briefing: false, sweep: true, learn_review: true });
  });
});

describe('schedulesReport', () => {
  it('lists each job as on or off', () => {
    expect(schedulesReport(CHOICES)).toContain('daily_briefing on, sweep on, learn_review off');
  });
});

describe('loadScheduleOptions', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'installer-schedules-')); roots.push(d); return d; };

  it('is null when the project has no scheduler', async () => {
    expect(await loadScheduleOptions(tmp())).toBeNull();
  });

  // Contract with the real sibling scheduler (linked like the other engine tests).
  const hasScheduler = !!findSiblingDir('@justfortytwo/scheduler');

  it.runIf(hasScheduler)('offers the built-in jobs, all enabled when nothing was saved', async () => {
    const root = tmp(); linkEngineInto(root);
    const options = await loadScheduleOptions(root);
    expect(options!.choices.map((c) => c.kind)).toEqual(['daily_briefing', 'sweep', 'learn_review']);
    expect(options!.choices.every((c) => c.enabled && c.description.length > 10)).toBe(true);
  });

  it.runIf(hasScheduler)('saves a choice the scheduler reads back, and offers it as the default next time', async () => {
    const root = tmp(); linkEngineInto(root);
    const options = await loadScheduleOptions(root);
    options!.save(applySchedulesFlag(options!.choices, 'sweep'));
    expect(JSON.parse(readFileSync(join(root, '.fortytwo/schedules.json'), 'utf8'))).toEqual({
      version: 1,
      schedules: { daily_briefing: { enabled: false }, sweep: { enabled: true }, learn_review: { enabled: false } },
    });
    expect(state((await loadScheduleOptions(root))!.choices)).toEqual({ daily_briefing: false, sweep: true, learn_review: false });
  });

  it.runIf(hasScheduler)('reports an unreadable saved file and falls back to enabled defaults', async () => {
    const root = tmp(); linkEngineInto(root);
    mkdirSync(join(root, '.fortytwo'), { recursive: true });
    writeFileSync(join(root, '.fortytwo/schedules.json'), '{ nope');
    const options = await loadScheduleOptions(root);
    expect(options!.unreadable).toMatch(/not valid JSON/);
    expect(options!.choices.every((c) => c.enabled)).toBe(true);
  });
});
