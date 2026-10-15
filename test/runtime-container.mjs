// Manual Linux integration: run seed/check in separate containers sharing /workspace.
// Imports only the built installer; no Telegram, Claude or sibling packages needed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessIdentity } from '../dist/process-identity.js';
import { liveRuntime, readRuntimeState, runtimeStatePath, isPidAlive, RUNTIME_STALE_MS } from '../dist/runtime.js';
import { runStart } from '../dist/commands/start.js';
import { runStatus } from '../dist/commands/status.js';
import { runStop } from '../dist/commands/stop.js';

assert.equal(process.platform, 'linux');
assert.equal(process.pid, 1, 'Run node directly as the container command (no --init)');
const root = process.cwd();
const record = (pid, processIdentity) => ({ pid, processIdentity, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), services: [], skipped: [] });
const write = state => writeFileSync(runtimeStatePath(root), JSON.stringify(state));
mkdirSync('.fortytwo', { recursive: true });
if (process.argv[2] === 'seed') {
  const identity = readProcessIdentity(process.pid);
  assert(identity);
  write(record(process.pid, identity));
  console.log('Seeded a fresh PID 1 runtime in the first container:', identity);
} else {
  assert.equal(process.argv[2], 'check');
  const previous = readRuntimeState(root);
  assert.equal(previous.pid, process.pid);
  assert(Date.now() - Date.parse(previous.heartbeatAt) < RUNTIME_STALE_MS, 'Run check immediately after seed');
  assert(isPidAlive(previous.pid));
  assert.notEqual(readProcessIdentity(process.pid), previous.processIdentity);
  assert.equal(liveRuntime(root), null);
  assert.equal(await runStatus([]), 3);
  assert.equal(await runStop([]), 0); // must not SIGTERM this unrelated PID 1

  const dir = 'node_modules/@justfortytwo/scheduler';
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: '@justfortytwo/scheduler', bin: { 'fortytwo-scheduler': 'service.cjs' } }));
  writeFileSync(`${dir}/service.cjs`, "require('node:fs').writeFileSync('service.ready','ready'); process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);");
  const running = runStart([]);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync('service.ready')) {
      assert(Date.now() < deadline, 'Service did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(liveRuntime(root)?.pid, process.pid);
    assert.equal(await runStart([]), 1, 'Actual double-start must still be refused');
    assert.equal(await runStatus([]), 0);
  } finally {
    process.emit('SIGTERM');
    assert.equal(await running, 0);
  }

  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)"]);
  try {
    await once(child.stdout, 'data');
    write(record(child.pid, previous.processIdentity));
    assert.equal(await runStop([]), 0);
    assert(isPidAlive(child.pid), 'Unrelated child must not be signalled');
    const identity = readProcessIdentity(child.pid);
    assert(identity);
    write(record(child.pid, identity));
    assert.equal(liveRuntime(root)?.pid, child.pid);
    assert.equal(await runStop([], { timeoutMs: 3000 }), 0);
    assert.equal(isPidAlive(child.pid), false);
    assert.equal(liveRuntime(root), null);
  } finally { child.kill('SIGKILL'); }
  console.log('PASS: real container PID reuse, immediate restart, double-start, status and safe stop');
}
