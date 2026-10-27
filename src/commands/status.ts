// status — is fortytwo running, and which of its services?
//
// Reads what already exists instead of searching for processes: the runtime
// state `fortytwo start` keeps in .fortytwo/runtime.json (Telegram bridge), the
// scheduler's own heartbeat file (so a scheduler run by hand shows up too), and
// .mcp.json for memory, which Claude Code itself starts on demand.
// Exit code: 0 when `fortytwo start` is running, 3 when it is not (LSB "not
// running"), so `fortytwo status` works as a container health check.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveRuntime, serviceRunning, type RuntimeState } from '../runtime.js';
import { defaultDoctorDeps, extensionWiringProblems, readMcpExtensions, HEARTBEAT_STALE_MS } from './doctor.js';
import { readInstalledVersion } from '../engine.js';

export interface StatusInput {
  runtime: RuntimeState | null;
  schedulerHeartbeat: { pid: number; ts: string } | null;
  memoryConfigured: boolean;
  /** MCP extension wiring problems (see extensionWiringProblems); each becomes a Warning line. */
  extensionProblems?: string[];
  nowMs: number;
}

/** The status lines (pure, for tests). */
export function statusLines(i: StatusInput): string[] {
  const row = (label: string, value: string) => `${label.padEnd(11)}${value}`;
  const lines: string[] = [];
  lines.push(row('Fortytwo', i.runtime ? `running (pid ${i.runtime.pid}, since ${i.runtime.startedAt})` : 'not running (start it with `fortytwo start`)'));

  const skippedTg = i.runtime?.skipped.find((s) => s.name === 'telegram');
  lines.push(row('Telegram', serviceRunning(i.runtime, 'telegram') ? 'running'
    : skippedTg ? `not started (${skippedTg.reason})`
    : 'not running'));

  const hb = i.schedulerHeartbeat;
  const age = hb ? i.nowMs - new Date(hb.ts).getTime() : Infinity;
  lines.push(row('Scheduler', hb && age <= HEARTBEAT_STALE_MS ? `running (heartbeat ${Math.max(0, Math.round(age / 1000))}s ago)`
    : hb ? `not running (last heartbeat ${hb.ts})`
    : 'not running'));

  lines.push(row('Memory', i.memoryConfigured ? 'configured via MCP (Claude Code starts it on demand)' : 'not configured (run `fortytwo init`)'));
  for (const p of i.extensionProblems ?? []) lines.push(row('Warning', p));
  return lines;
}

function memoryConfigured(root: string): boolean {
  const path = join(root, '.mcp.json');
  if (!existsSync(path)) return false;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!cfg.mcpServers?.['fortytwo-memory'];
  } catch {
    return false;
  }
}

export async function runStatus(_argv: string[]): Promise<number> {
  const root = process.cwd();
  const runtime = liveRuntime(root);
  const lines = statusLines({
    runtime,
    schedulerHeartbeat: defaultDoctorDeps().schedulerHeartbeat(),
    memoryConfigured: memoryConfigured(root),
    extensionProblems: extensionWiringProblems(readMcpExtensions(root), (s) => readInstalledVersion(s, root)),
    nowMs: Date.now(),
  });
  process.stdout.write(lines.join('\n') + '\n');
  return runtime ? 0 : 3;
}
