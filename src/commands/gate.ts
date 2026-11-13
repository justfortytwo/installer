// gate — show or change whether the optional safety gate is on for this project.
//
//   fortytwo gate        show the state, change nothing
//   fortytwo gate on     hold outward and destructive actions for approval
//   fortytwo gate off    remove the hook; Claude Code's own permissions apply again
//
// See ../gate.ts for what "on" means. Claude Code reads hooks when a session
// starts, so a change reaches the running assistant only after a restart.

import {
  ALLOWLIST_FILE, MANIFEST_FILE, SETTINGS_FILE,
  disableGate, enableGate, gateState, type GateChange, type GateState,
} from '../gate.js';
import { liveRuntime } from '../runtime.js';

const USAGE = `fortytwo gate [on|off]

Show or change the optional safety gate. It is off unless you turn it on.

  (no argument)  Show whether the gate is on.
  on             Hold outward and destructive actions until you approve them.
                 Adds the gate's hook to ${SETTINGS_FILE} and, when missing,
                 ${MANIFEST_FILE} (which tools are held) and
                 ${ALLOWLIST_FILE} (Bash commands that run without asking).
  off            Remove the hook. The two policy files are kept.

With the gate on, \`fortytwo start\` lets paired Telegram chats approve or deny a
held action (set TELEGRAM_APPROVALS=0 to keep that off). Restart fortytwo after
changing the gate.
`;

export interface GateDeps {
  state: () => GateState;
  enable: () => GateChange;
  disable: () => GateChange;
  /** Whether `fortytwo start` is running for this project right now. */
  running: () => boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

function describe(state: GateState): string {
  if (state.error) return `Safety gate: unknown (${state.error}).\n`;
  if (state.hook === null) {
    return 'Safety gate: off. Claude Code\'s own permissions decide what runs.\nTurn it on with `fortytwo gate on`.\n';
  }
  const problems: string[] = [];
  if (!state.installed) problems.push('@justfortytwo/gate is not installed (run `fortytwo update`)');
  if (!state.manifest) problems.push(`${MANIFEST_FILE} is missing`);
  const lines = [
    'Safety gate: on. Outward and destructive actions wait for your approval.',
    `  hook       ${state.hook}`,
    `  held tools ${MANIFEST_FILE}${state.manifest ? '' : ' (missing)'}`,
    `  free Bash  ${ALLOWLIST_FILE}${state.allowlist ? '' : ' (missing: every Bash command is held)'}`,
  ];
  if (problems.length > 0) {
    lines.push(`! Every tool call is being refused: ${problems.join('; ')}. Run \`fortytwo gate on\` to repair, or \`fortytwo gate off\`.`);
  }
  return `${lines.join('\n')}\n`;
}

function restartNote(deps: GateDeps): string {
  return deps.running()
    ? 'Fortytwo is running: restart it to apply (`fortytwo stop` then `fortytwo start`, or restart its container/service).\n'
    : 'Restart Fortytwo to apply (Claude Code reads hooks when a session starts).\n';
}

export function performGate(deps: GateDeps, argv: string[]): number {
  const [action, ...extra] = argv;
  if (action === '--help' || action === '-h') { deps.out(USAGE); return 0; }
  if (extra.length > 0 || (action !== undefined && action !== 'on' && action !== 'off' && action !== 'status')) {
    deps.err(`gate: expected \`on\` or \`off\`, got \`${argv.join(' ')}\`.\n\n${USAGE}`);
    return 2;
  }

  if (action === undefined || action === 'status') {
    const state = deps.state();
    deps.out(describe(state));
    return state.error ? 1 : 0;
  }

  let change: GateChange;
  try {
    change = action === 'on' ? deps.enable() : deps.disable();
  } catch (e) {
    deps.err(`gate: ${(e as Error).message}. Nothing was changed.\n`);
    return 1;
  }

  if (action === 'on') {
    for (const file of change.created) deps.out(`✓ wrote ${file}\n`);
    if (!change.changed) {
      deps.out('Safety gate is already on.\n');
      return 0;
    }
    deps.out(`✓ safety gate on (hook added to ${SETTINGS_FILE})\n`);
    deps.out(`Held: everything not listed as safe in ${MANIFEST_FILE}, and any Bash command not in ${ALLOWLIST_FILE}.\n`);
    deps.out('Approve or deny from Telegram (buttons on the held action), or with `npx fortytwo-gate list` and `npx fortytwo-gate approve <id>`.\n');
    deps.out('It applies to every Claude Code session in this folder, including ones you open by hand.\n');
  } else {
    if (!change.changed) {
      deps.out('Safety gate is already off.\n');
      return 0;
    }
    deps.out(`✓ safety gate off (hook removed from ${SETTINGS_FILE}; policy files kept)\n`);
  }
  deps.out(restartNote(deps));
  return 0;
}

export async function runGate(argv: string[]): Promise<number> {
  const root = process.cwd();
  return performGate({
    state: () => gateState(root),
    enable: () => enableGate(root),
    disable: () => disableGate(root),
    running: () => liveRuntime(root) !== null,
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
  }, argv);
}
