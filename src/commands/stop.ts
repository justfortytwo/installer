// stop — stop a `fortytwo start` running for this project.
//
// Signals ONLY the supervisor recorded in .fortytwo/runtime.json, and only while
// its heartbeat is fresh and OS process identity matches (see runtime.ts).
// It never searches for or kills processes by name. The supervisor
// then stops its own services. Under Docker/systemd prefer their own stop.

import { sameRuntimeProcess, liveRuntime } from '../runtime.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runStop(_argv: string[], opts: { timeoutMs?: number } = {}): Promise<number> {
  const runtime = liveRuntime(process.cwd());
  if (!runtime) {
    process.stdout.write('fortytwo is not running.\n');
    return 0;
  }
  process.stdout.write(`Stopping fortytwo (pid ${runtime.pid})…\n`);
  // Revalidate the original generation immediately before signalling.
  if (!sameRuntimeProcess(runtime)) return 0;
  try {
    process.kill(runtime.pid, 'SIGTERM');
  } catch (err) {
    process.stderr.write(`stop: could not signal pid ${runtime.pid}: ${(err as Error).message}\n`);
    return 1;
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (!sameRuntimeProcess(runtime)) {
      process.stdout.write('fortytwo stopped.\n');
      return 0;
    }
    await sleep(200);
  }
  process.stderr.write(`stop: fortytwo (pid ${runtime.pid}) is still running after SIGTERM.\n`);
  return 1;
}
