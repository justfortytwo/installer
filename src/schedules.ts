// schedules.ts — let the owner choose which of the scheduler's BUILT-IN
// recurring jobs run (daily briefing, open-thread sweep, weekly learn-review).
//
// The scheduler owns both the list of jobs and the file format
// (`.fortytwo/schedules.json`); this module only asks and hands the answer to
// the installed scheduler. A project without the scheduler, or with one that
// predates the choice, is skipped: every built-in job stays on, as before.

import { loadSibling } from './engine.js';

const SCHEDULER_PACKAGE = '@justfortytwo/scheduler';

interface SchedulerApi {
  RECURRING_DEFS?: Array<{ kind: string; description?: string }>;
  readSchedules?: (root: string) => Record<string, boolean>;
  writeSchedules?: (root: string, config: Record<string, boolean>) => void;
  // Since scheduler 1.0.6: the time zone the built-in times are read in.
  readScheduleTimezone?: (root: string) => string | undefined;
  writeScheduleTimezone?: (root: string, timezone: string | undefined) => void;
  isValidTimezone?: (tz: unknown) => boolean;
}

/** One built-in job, with the owner's current choice. */
export interface ScheduleChoice {
  kind: string;
  description: string;
  enabled: boolean;
}

export interface ScheduleOptions {
  /** Built-in jobs with the choice saved by a previous init (enabled when none was saved). */
  choices: ScheduleChoice[];
  /** A saved file that could not be read; the choices above then default to enabled. */
  unreadable?: string;
  /** Persist the given choices for the scheduler. */
  save: (choices: ScheduleChoice[]) => void;
  /** The saved time zone for the built-in times; undefined = UTC. */
  timezone?: string;
  /** Persist the time zone. Absent when the installed scheduler predates time zones. */
  saveTimezone?: (timezone: string) => void;
  /** Whether a name is a time zone the scheduler can use. */
  validTimezone?: (timezone: string) => boolean;
}

/**
 * The built-in jobs of the scheduler installed in `root`, or null when there
 * is no scheduler or it does not support choosing.
 */
export async function loadScheduleOptions(root: string): Promise<ScheduleOptions | null> {
  const scheduler = await loadSibling<SchedulerApi>(SCHEDULER_PACKAGE, root);
  const defs = scheduler?.RECURRING_DEFS;
  const { readSchedules, writeSchedules } = scheduler ?? {};
  if (!defs || !readSchedules || !writeSchedules) return null;

  let saved: Record<string, boolean> = {};
  let unreadable: string | undefined;
  let timezone: string | undefined;
  try {
    saved = readSchedules(root);
    timezone = scheduler?.readScheduleTimezone?.(root);
  } catch (e) {
    unreadable = (e as Error).message;
  }
  const { writeScheduleTimezone, isValidTimezone } = scheduler ?? {};
  return {
    timezone,
    ...(writeScheduleTimezone && isValidTimezone ? {
      saveTimezone: (tz: string) => writeScheduleTimezone(root, tz),
      validTimezone: (tz: string) => isValidTimezone(tz),
    } : {}),
    choices: defs.map((d) => ({
      kind: d.kind,
      description: d.description ?? d.kind,
      enabled: saved[d.kind] !== false,
    })),
    unreadable,
    save: (choices) => writeSchedules(root, Object.fromEntries(choices.map((c) => [c.kind, c.enabled]))),
  };
}

/**
 * Apply `--schedules <value>`: `all`, `none`, or a comma-separated list of the
 * kinds to ENABLE (every other built-in job is switched off). Throws on a kind
 * the scheduler does not have, naming the valid ones.
 */
export function applySchedulesFlag(choices: ScheduleChoice[], value: string): ScheduleChoice[] {
  const v = value.trim().toLowerCase();
  if (v === 'all') return choices.map((c) => ({ ...c, enabled: true }));
  if (v === 'none') return choices.map((c) => ({ ...c, enabled: false }));
  const wanted = v.split(',').map((s) => s.trim()).filter(Boolean);
  const known = choices.map((c) => c.kind);
  const unknown = wanted.filter((k) => !known.includes(k));
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Error(
      `--schedules: ${unknown.length > 0 ? `unknown schedule(s) ${unknown.join(', ')}` : 'no schedule given'}. ` +
      `Use all, none, or a comma-separated list of: ${known.join(', ')}`,
    );
  }
  return choices.map((c) => ({ ...c, enabled: wanted.includes(c.kind) }));
}

/**
 * Ask about each built-in job; Enter keeps its current choice. An answer that
 * is neither yes nor no also keeps it. Pure: `ask` is injected.
 */
export async function askSchedules(
  choices: ScheduleChoice[],
  ask: (prompt: string) => Promise<string>,
): Promise<ScheduleChoice[]> {
  const result: ScheduleChoice[] = [];
  for (const c of choices) {
    const answer = (await ask(`Run this schedule? ${c.description} ${c.enabled ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
    const enabled = /^(y|yes)$/.test(answer) ? true : /^(n|no)$/.test(answer) ? false : c.enabled;
    result.push({ ...c, enabled });
  }
  return result;
}

/** `utc` in any letter case is UTC; anything else is taken as typed (IANA names are case-sensitive on some systems). */
export function normalizeTimezone(value: string): string {
  const v = value.trim();
  return /^utc$/i.test(v) ? 'UTC' : v;
}

/**
 * The zone `init` should save for the built-in times: the owner's, when it is
 * usable and not UTC, the scheduler supports zones and none is saved yet.
 * Otherwise undefined.
 */
export function initialScheduleTimezone(options: ScheduleOptions | null, ownerTimezone: unknown): string | undefined {
  if (!options?.saveTimezone || !options.validTimezone || options.timezone || options.unreadable) return undefined;
  if (typeof ownerTimezone !== 'string') return undefined;
  const zone = normalizeTimezone(ownerTimezone);
  // UTC is what the scheduler does without a saved zone: nothing to write.
  return zone !== 'UTC' && options.validTimezone(zone) ? zone : undefined;
}

/** One line saying which clock the built-in times are on. */
export function timezoneLine(options: Pick<ScheduleOptions, 'timezone' | 'saveTimezone'>): string {
  if (options.timezone) return `Times are in ${options.timezone}.\n`;
  return options.saveTimezone
    ? 'Times are in UTC. Use your own clock with `fortytwo schedules --timezone <IANA name>` (e.g. Europe/Rome).\n'
    : 'Times are in UTC.\n';
}

/** The init report line for the saved choice. */
export function schedulesReport(choices: ScheduleChoice[]): string {
  const state = choices.map((c) => `${c.kind} ${c.enabled ? 'on' : 'off'}`).join(', ');
  return `✓ built-in schedules: ${state} (change with \`fortytwo schedules\`; restart Fortytwo to apply)`;
}
