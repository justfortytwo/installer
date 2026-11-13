// `fortytwo gate on|off`: the optional safety gate is a hook entry in the
// project's .claude/settings.json plus two owner-tunable policy files.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWLIST_FILE, MANIFEST_FILE, SETTINGS_FILE,
  disableGate, enableGate, findGateHook, gateAssetsDir, gateOn, gateState, hookCommand,
  withGateHook, withoutGateHook,
} from '../src/gate.js';
import { performGate, type GateDeps } from '../src/commands/gate.js';
import { applyStartFlags, parseStartArgs } from '../src/commands/start.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A project with (or without) the gate package installed. */
function project(withGate = true): string {
  const root = mkdtempSync(join(tmpdir(), 'fortytwo-gate-'));
  dirs.push(root);
  if (withGate) {
    const pkg = join(root, 'node_modules', '@justfortytwo', 'gate');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"@justfortytwo/gate","version":"0.1.2"}');
    writeFileSync(join(pkg, 'dist', 'gate-hook.js'), '');
  }
  return root;
}
const settings = (root: string) => JSON.parse(readFileSync(join(root, SETTINGS_FILE), 'utf8'));
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/node_modules/@justfortytwo/gate/dist/gate-hook.js"';

describe('hook wiring (pure)', () => {
  it('addresses the hook through CLAUDE_PROJECT_DIR when the gate is inside the project', () => {
    expect(hookCommand('/p', '/p/node_modules/@justfortytwo/gate')).toBe(COMMAND);
  });

  it('uses an absolute path when the gate is installed above the project', () => {
    expect(hookCommand('/ws/p', '/ws/node_modules/@justfortytwo/gate'))
      .toBe('node "/ws/node_modules/@justfortytwo/gate/dist/gate-hook.js"');
  });

  it('adds the hook beside existing settings and hooks, once', () => {
    const before = {
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }], Stop: [{ hooks: [] }] },
    };
    const after = withGateHook(before, COMMAND) as typeof before;
    expect(after.permissions).toEqual(before.permissions);
    expect(after.hooks.Stop).toEqual(before.hooks.Stop);
    expect(after.hooks.PreToolUse).toEqual([
      before.hooks.PreToolUse[0],
      { matcher: '*', hooks: [{ type: 'command', command: COMMAND }] },
    ]);
    expect(findGateHook(after)).toBe(COMMAND);
    expect(withGateHook(after, COMMAND)).toBe(after);
    expect(before.hooks.PreToolUse).toHaveLength(1); // input untouched
  });

  it('removes only the gate hook, and empty containers with it', () => {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] };
    const on = withGateHook({ model: 'x', hooks: { PreToolUse: [mine] } }, COMMAND);
    expect(withoutGateHook(on)).toEqual({ model: 'x', hooks: { PreToolUse: [mine] } });
    expect(withoutGateHook(withGateHook({ model: 'x' }, COMMAND))).toEqual({ model: 'x' });
    // A gate handler sharing a group with another hook leaves the other one.
    const shared = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: COMMAND }, { type: 'command', command: 'mine.sh' }] }] } };
    expect(withoutGateHook(shared)).toEqual({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
  });

  it('refuses settings whose hooks are not the expected shape', () => {
    expect(() => withGateHook({ hooks: [] }, COMMAND)).toThrow(/hooks/);
    expect(() => withGateHook({ hooks: { PreToolUse: {} } }, COMMAND)).toThrow(/PreToolUse/);
  });
});

describe('enableGate / disableGate', () => {
  it('is off on a fresh project', () => {
    const root = project();
    expect(gateOn(root)).toBe(false);
    expect(gateState(root)).toEqual({ hook: null, installed: true, manifest: false, allowlist: false });
  });

  it('on writes the policy files and the hook; off removes only the hook', () => {
    const root = project();
    expect(enableGate(root)).toEqual({ changed: true, created: [MANIFEST_FILE, ALLOWLIST_FILE] });
    expect(settings(root)).toEqual({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: COMMAND }] }] } });
    expect(readFileSync(join(root, MANIFEST_FILE), 'utf8')).toBe(readFileSync(join(gateAssetsDir(), 'capabilities.toml'), 'utf8'));
    expect(gateState(root)).toEqual({ hook: COMMAND, installed: true, manifest: true, allowlist: true });

    expect(enableGate(root)).toEqual({ changed: false, created: [] });
    expect(disableGate(root)).toEqual({ changed: true, created: [] });
    expect(settings(root)).toEqual({});
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(root, ALLOWLIST_FILE))).toBe(true);
    expect(disableGate(root)).toEqual({ changed: false, created: [] });
  });

  it('never overwrites policy files the owner already has, and keeps other settings', () => {
    const root = project();
    mkdirSync(join(root, '.claude', 'policy'), { recursive: true });
    writeFileSync(join(root, MANIFEST_FILE), 'default_tier = "read"\n');
    writeFileSync(join(root, SETTINGS_FILE), '{"permissions":{"defaultMode":"acceptEdits"}}');
    expect(enableGate(root).created).toEqual([ALLOWLIST_FILE]);
    expect(readFileSync(join(root, MANIFEST_FILE), 'utf8')).toBe('default_tier = "read"\n');
    expect(settings(root).permissions).toEqual({ defaultMode: 'acceptEdits' });
  });

  it('repairs a missing manifest when the hook is already wired', () => {
    const root = project();
    enableGate(root);
    rmSync(join(root, MANIFEST_FILE));
    expect(enableGate(root)).toEqual({ changed: false, created: [MANIFEST_FILE] });
  });

  it('changes nothing when the gate package is missing or settings.json is broken', () => {
    const bare = project(false);
    expect(() => enableGate(bare)).toThrow(/not installed/);
    expect(existsSync(join(bare, '.claude'))).toBe(false);

    const root = project();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, SETTINGS_FILE), '{ not json');
    expect(() => enableGate(root)).toThrow(/not valid JSON/);
    expect(() => disableGate(root)).toThrow(/not valid JSON/);
    expect(readFileSync(join(root, SETTINGS_FILE), 'utf8')).toBe('{ not json');
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(false);
    expect(gateOn(root)).toBe(false);
    expect(gateState(root).error).toMatch(/not valid JSON/);
  });
});

describe('shipped policy', () => {
  const manifest = readFileSync(join(gateAssetsDir(), 'capabilities.toml'), 'utf8');

  it('holds unknown tools, frees memory and skills, and guards the gate itself', () => {
    expect(manifest).toMatch(/^default_tier = "external"$/m);
    expect(manifest).toMatch(/^"Bash" = "external"$/m);
    expect(manifest).toMatch(/^"mcp__fortytwo-memory__\*" = "internal"$/m);
    expect(manifest).toMatch(/^"Skill" = "internal"$/m);
    for (const f of [SETTINGS_FILE, '.claude/policy/', ALLOWLIST_FILE, '.gate/', '.mcp.json', '.env', 'state/', 'node_modules/', '.git', '.git/']) {
      expect(manifest).toContain(`"${f}",`);
    }
    expect(manifest).toMatch(/^outside_project = true$/m);
  });

  it('allowlists only commands that cannot run another program', () => {
    const lines = readFileSync(join(gateAssetsDir(), 'bash-allowlist.jsonl'), 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => JSON.parse(l).command_glob as string);
    expect(lines.length).toBeGreaterThan(0);
    for (const glob of lines) expect(glob).toMatch(/^(pwd|date|ls|cat|head|tail|wc|grep)( \*)?$/);
  });
});

describe('fortytwo gate (command)', () => {
  function run(argv: string[], over: Partial<GateDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[] = [];
    const code = performGate({
      state: () => ({ hook: null, installed: true, manifest: false, allowlist: false }),
      enable: () => { calls.push('on'); return { changed: true, created: [MANIFEST_FILE] }; },
      disable: () => { calls.push('off'); return { changed: true, created: [] }; },
      running: () => false,
      out: (s) => out.push(s), err: (s) => err.push(s),
      ...over,
    }, argv);
    return { code, out: out.join(''), err: err.join(''), calls };
  }

  it('shows the state and changes nothing without an argument', () => {
    const off = run([]);
    expect(off).toMatchObject({ code: 0, calls: [] });
    expect(off.out).toMatch(/Safety gate: off/);
    const on = run(['status'], { state: () => ({ hook: 'node x/gate-hook.js', installed: true, manifest: true, allowlist: true }) });
    expect(on.out).toMatch(/Safety gate: on/);
    expect(on.out).not.toMatch(/refused/);
  });

  it('says so when the gate is on but cannot work', () => {
    const r = run([], { state: () => ({ hook: 'node x/gate-hook.js', installed: true, manifest: false, allowlist: false }) });
    expect(r.out).toMatch(/Every tool call is being refused: .*capabilities\.toml is missing/);
  });

  it('turns it on and off, and asks for a restart when fortytwo is running', () => {
    const on = run(['on'], { running: () => true });
    expect(on).toMatchObject({ code: 0, calls: ['on'] });
    expect(on.out).toMatch(/safety gate on/);
    expect(on.out).toMatch(/restart it to apply/);
    const off = run(['off']);
    expect(off).toMatchObject({ code: 0, calls: ['off'] });
    expect(off.out).toMatch(/safety gate off/);
    expect(off.out).toMatch(/Restart Fortytwo to apply/);
  });

  it('reports an unchanged state without a restart note', () => {
    const r = run(['off'], { disable: () => ({ changed: false, created: [] }) });
    expect(r.out).toBe('Safety gate is already off.\n');
  });

  it('reports a failure as "nothing was changed"', () => {
    const r = run(['on'], { enable: () => { throw new Error('boom'); } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('gate: boom. Nothing was changed.\n');
  });

  it('rejects anything else', () => {
    expect(run(['enable']).code).toBe(2);
    expect(run(['on', 'now']).code).toBe(2);
    expect(run(['--help'])).toMatchObject({ code: 0, calls: [] });
  });
});

describe('fortytwo start with the gate on', () => {
  const none = parseStartArgs([]);
  it('turns Telegram approvals on by default', () => {
    expect(applyStartFlags({}, none, true)['TELEGRAM_APPROVALS']).toBe('1');
  });
  it('leaves an explicit choice alone', () => {
    expect(applyStartFlags({ TELEGRAM_APPROVALS: '0' }, none, true)['TELEGRAM_APPROVALS']).toBe('0');
  });
  it('does nothing with the gate off', () => {
    expect('TELEGRAM_APPROVALS' in applyStartFlags({}, none, false)).toBe(false);
    expect('TELEGRAM_APPROVALS' in applyStartFlags({}, none)).toBe(false);
  });
});
