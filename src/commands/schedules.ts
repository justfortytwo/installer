// schedules — show or change which of the scheduler's built-in recurring jobs
// run (daily briefing, open-thread sweep, weekly learn-review).
//
// This is the way to change the choice on an EXISTING install. `init` asks the
// same questions on a first install, but re-running it there would prompt for
// the whole identity again; this verb touches only `.fortytwo/schedules.json`.
//
//   fortytwo schedules                 ask about each job (a terminal), else list
//   fortytwo schedules --list          print the current choice, change nothing
//   fortytwo schedules --set <value>   all | none | comma-separated jobs to enable
//
// The scheduler reads the file once at boot, so a change applies on restart.

import { createInterface } from 'node:readline/promises';
import { liveRuntime } from '../runtime.js';
import {
  applySchedulesFlag, askSchedules, loadScheduleOptions,
  type ScheduleChoice, type ScheduleOptions,
} from '../schedules.js';

export interface SchedulesFlags {
  list?: boolean;
  /** Value of `--set`: `all`, `none`, or the jobs to enable. */
  set?: string;
}

export interface SchedulesDeps {
  /** The installed scheduler's built-in jobs, or null when it cannot offer the choice. */
  load: () => Promise<ScheduleOptions | null>;
  /** Present only when a person can answer; asks one question. */
  ask?: (prompt: string) => Promise<string>;
  /** Whether `fortytwo start` is running for this project right now. */
  running: () => boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function parseSchedulesArgs(argv: string[]): SchedulesFlags {
  const flags: SchedulesFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') flags.list = true;
    else if (a === '--set') flags.set = argv[++i] ?? '';
  }
  return flags;
}

function listing(choices: ScheduleChoice[]): string {
  return choices.map((c) => `  [${c.enabled ? 'on ' : 'off'}] ${c.kind} — ${c.description}\n`).join('');
}

export async function performSchedules(deps: SchedulesDeps, flags: SchedulesFlags): Promise<number> {
  const options = await deps.load();
  if (!options) {
    deps.err('schedules: @justfortytwo/scheduler is not installed in this project, or it predates this choice (run `fortytwo update`).\n');
    return 2;
  }

  let next: ScheduleChoice[] | undefined;
  if (flags.set !== undefined) {
    try {
      next = applySchedulesFlag(options.choices, flags.set);
    } catch (e) {
      deps.err(`schedules: ${(e as Error).message.replace(/^--schedules: /, '--set: ')}\n`);
      return 2;
    }
  } else if (!flags.list && deps.ask) {
    if (options.unreadable) deps.out(`! ${options.unreadable} — your answers below will replace it.\n`);
    next = await askSchedules(options.choices, deps.ask);
  }

  if (!next) {
    // Read-only: --list, or nobody to ask.
    if (options.unreadable) {
      deps.err(`schedules: ${options.unreadable}. The scheduler will not start until it is fixed; set a new choice with \`fortytwo schedules --set <all|none|job,job>\`.\n`);
      return 1;
    }
    deps.out(`Built-in schedules:\n${listing(options.choices)}`);
    deps.out('Change with `fortytwo schedules` in a terminal, or `fortytwo schedules --set <all|none|job,job>`.\n');
    return 0;
  }

  options.save(next);
  deps.out(`✓ built-in schedules saved:\n${listing(next)}`);
  deps.out(deps.running()
    ? 'Fortytwo is running: restart it to apply (`fortytwo stop` then `fortytwo start`, or restart its container/service).\n'
    : 'Applies the next time Fortytwo starts.\n');
  return 0;
}

export async function runSchedules(argv: string[]): Promise<number> {
  const root = process.cwd();
  const flags = parseSchedulesArgs(argv);
  const base = {
    load: () => loadScheduleOptions(root),
    running: () => liveRuntime(root) !== null,
    out: (s: string) => { process.stdout.write(s); },
    err: (s: string) => { process.stderr.write(s); },
  };
  const interactive = process.stdin.isTTY === true && flags.set === undefined && !flags.list;
  if (!interactive) return performSchedules(base, flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await performSchedules({ ...base, ask: (q) => rl.question(q) }, flags);
  } finally {
    rl.close();
  }
}
