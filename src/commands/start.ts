// start — run fortytwo's long-running services in the foreground.
//
// Loads the project .env (the shell/container env wins over it), starts every
// service that is installed and configured (the Telegram bridge needs
// TELEGRAM_BOT_TOKEN; the scheduler needs nothing) and supervises them until
// Ctrl+C / SIGTERM or until one exits — see runtime.ts. Never daemonizes: use it
// directly as the container/service command (`fortytwo start`) and let
// Docker/Podman/systemd own restarts. The services' own bins
// (fortytwo-telegram-bridge, fortytwo-scheduler) stay available for debugging.
//
// `fortytwo start -- <claude args>` hands everything after `--` to Claude Code for
// both chat and scheduled runs (e.g. `fortytwo start -- --chrome`). It travels as
// FORTYTWO_CLAUDE_ARGS, a JSON array each service validates at boot; the same
// variable can be set in .env instead, and the command line wins over it.
//
// `fortytwo start --telegram-approvals` sets TELEGRAM_APPROVALS=1 for the bridge:
// with the safety gate's hook active, a held action then shows up in the chat with
// Approve / Deny buttons. With the gate on (`fortytwo gate on`) that is the default,
// unless TELEGRAM_APPROVALS is set (e.g. to 0) in the shell env or .env; with the
// gate off it stays off unless asked for.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvContent } from './init.js';
import { gateOn } from '../gate.js';
import { buildServiceEnv, liveRuntime, planServices, supervise } from '../runtime.js';

/** Read by @justfortytwo/runner's `claudeArgsFromEnv` in the bridge and the scheduler. */
export const CLAUDE_ARGS_ENV = 'FORTYTWO_CLAUDE_ARGS';

const USAGE = `fortytwo start [--telegram-approvals] [-- <claude args>]

Run fortytwo in the foreground (Telegram bridge + scheduler), loading .env.

  --telegram-approvals
                     Let paired Telegram chats approve or deny actions the safety
                     gate holds (sets TELEGRAM_APPROVALS=1). Already the default
                     when the gate is on (\`fortytwo gate on\`); set
                     TELEGRAM_APPROVALS=0 to keep it off then.
  -- <claude args>   Everything after -- is passed to Claude Code on every chat and
                     scheduled run, e.g. \`fortytwo start -- --chrome\`. Overrides
                     ${CLAUDE_ARGS_ENV} (a JSON array, e.g. ["--chrome"]) from the
                     environment or .env. A bare -- passes none.
`;

export interface StartFlags {
  help: boolean;
  /** `--telegram-approvals` was given; false leaves the env value as it is. */
  telegramApprovals: boolean;
  /** Arguments after `--`; null when `--` was not given (the env value stands). */
  claudeArgs: string[] | null;
  error?: string;
}

export function parseStartArgs(argv: string[]): StartFlags {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const flags: StartFlags = { help: false, telegramApprovals: false, claudeArgs: split === -1 ? null : argv.slice(split + 1) };
  for (const arg of own) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--telegram-approvals') flags.telegramApprovals = true;
    else return { ...flags, error: `unknown option ${arg}. Claude Code arguments go after \`--\`: fortytwo start -- ${arg}` };
  }
  return flags;
}

/**
 * The service env with the command line's choices applied (input untouched).
 * `gateIsOn`: the project's gate hook is wired, so Telegram approvals default to
 * on; an explicit TELEGRAM_APPROVALS (any value) is left as the owner set it.
 */
export function applyStartFlags(env: NodeJS.ProcessEnv, flags: StartFlags, gateIsOn = false): NodeJS.ProcessEnv {
  const out = { ...env };
  if (gateIsOn && out['TELEGRAM_APPROVALS'] === undefined) out['TELEGRAM_APPROVALS'] = '1';
  if (flags.claudeArgs !== null) out[CLAUDE_ARGS_ENV] = JSON.stringify(flags.claudeArgs);
  if (flags.telegramApprovals) out['TELEGRAM_APPROVALS'] = '1';
  return out;
}

export async function runStart(argv: string[]): Promise<number> {
  const flags = parseStartArgs(argv);
  if (flags.error) { process.stderr.write(`start: ${flags.error}\n`); return 2; }
  if (flags.help) { process.stdout.write(USAGE); return 0; }
  const root = process.cwd();
  const running = liveRuntime(root);
  if (running) {
    process.stderr.write(`start: fortytwo is already running (pid ${running.pid}). Stop it with \`fortytwo stop\`.\n`);
    return 1;
  }
  const envPath = join(root, '.env');
  const fileEnv = existsSync(envPath) ? parseEnvContent(readFileSync(envPath, 'utf8')) : {};
  const env = applyStartFlags(buildServiceEnv(process.env, fileEnv, root), flags, gateOn(root));
  const { run, skipped } = planServices(root, env);
  for (const s of skipped) process.stdout.write(`[fortytwo] ${s.name}: not started (${s.reason})\n`);
  if (run.length === 0) {
    process.stderr.write(
      'start: no fortytwo service can run here. Run `fortytwo init` in this project first, ' +
      'and set TELEGRAM_BOT_TOKEN in .env for the Telegram channel.\n',
    );
    return 1;
  }
  process.stdout.write(`[fortytwo] starting ${run.map((s) => s.name).join(' + ')} (Ctrl+C to stop)\n`);
  return supervise(run, { root, env, skipped });
}
