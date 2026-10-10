// start — run fortytwo's long-running services in the foreground.
//
// Loads the project .env (the shell/container env wins over it), starts every
// service that is installed and configured (the Telegram bridge needs
// TELEGRAM_BOT_TOKEN; the scheduler needs nothing) and supervises them until
// Ctrl+C / SIGTERM or until one exits — see runtime.ts. Never daemonizes: use it
// directly as the container/service command (`fortytwo start`) and let
// Docker/Podman/systemd own restarts. The services' own bins
// (fortytwo-telegram-bridge, fortytwo-scheduler) stay available for debugging.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvContent } from './init.js';
import { buildServiceEnv, liveRuntime, planServices, supervise } from '../runtime.js';

export async function runStart(_argv: string[]): Promise<number> {
  const root = process.cwd();
  const running = liveRuntime(root);
  if (running) {
    process.stderr.write(`start: fortytwo is already running (pid ${running.pid}). Stop it with \`fortytwo stop\`.\n`);
    return 1;
  }
  const envPath = join(root, '.env');
  const fileEnv = existsSync(envPath) ? parseEnvContent(readFileSync(envPath, 'utf8')) : {};
  const env = buildServiceEnv(process.env, fileEnv, root);
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
