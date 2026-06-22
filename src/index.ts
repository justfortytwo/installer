#!/usr/bin/env node
// @justfortytwo/cli — the all-in-one installer + lifecycle CLI.
//
// Exposed as two bins (same entry):
//   create-fortytwo   — the install-time alias (`npm create fortytwo` / `npx
//                       create-fortytwo`); with no verb it implies `init`.
//   fortytwo          — the post-install lifecycle alias for everyday verbs.
//
// This is the operator's single surface over BOTH halves of the system:
//   - the npm ENGINE (@justfortytwo/memory, /gate, /telegram, embedder), and
//   - the scaffolded PERSONA (CLAUDE.md + context/*, rendered from
//     @justfortytwo/persona templates against .fortytwo/identity.json).
//
// All sibling-package calls are stubs marked `// TODO(wire):` until the sibling
// repos publish.

import { runInit } from './commands/init.js';
import { runPair } from './commands/pair.js';
import { runDoctor } from './commands/doctor.js';
import { runUpdate } from './commands/update.js';
import { runRollback } from './commands/rollback.js';
import { runEnrich } from './commands/enrich.js';
import { runForget } from './commands/forget.js';
import { runUnbind } from './commands/unbind.js';

export type Verb =
  | 'init'
  | 'pair'
  | 'doctor'
  | 'update'
  | 'rollback'
  | 'enrich'
  | 'forget'
  | 'unbind';

const USAGE = `fortytwo — install + lifecycle CLI for justfortytwo

Usage:
  create-fortytwo [init] [options]   first-run install + scaffold (init implied)
  fortytwo <verb> [options]

Verbs:
  init        Capture identity, write .env + .fortytwo/identity.json, render
              persona, provision (ollama pull + db migrate), issue a pairing code.
  pair        Issue a one-time /login pairing code for a channel (e.g. Telegram).
  doctor      Health-check the engine: memory MCP contract, gate, db migrations,
              embedder model, and declared peerDeps / fortytwo.compat.
  update      Resolve latest-in-range, install, run doctor, report. Points to
              rollback on failure.
  rollback    Restore the prior version set recorded in .fortytwo/state.json.
  enrich      Deepen the persona by capturing more answers; re-render (no clobber).
  forget      Redact/remove specific memories from the memory MCP store.
  unbind      Revoke a channel binding (un-pair a chat / drop the allowlist entry).

Run "fortytwo <verb> --help" for verb-specific options.
`;

/**
 * Decide the verb. `create-fortytwo` with no verb means `init`; `fortytwo` with
 * no verb prints usage. The invoked-as name comes from argv[1]'s basename.
 */
export function resolveVerb(argv: string[], invokedAs: string): Verb | 'help' | null {
  const first = argv[0];
  const verbs: Verb[] = ['init', 'pair', 'doctor', 'update', 'rollback', 'enrich', 'forget', 'unbind'];
  if (first && (verbs as string[]).includes(first)) return first as Verb;
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    // `create-fortytwo` with no verb implies init; otherwise show help.
    return invokedAs.startsWith('create-') && !first ? 'init' : 'help';
  }
  return null; // unknown verb
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const invokedAs = (process.argv[1] ?? '').split('/').pop() ?? 'fortytwo';
  const verb = resolveVerb(argv, invokedAs);
  const rest = argv.slice(verb && verb !== 'help' && argv[0] === verb ? 1 : 0);

  switch (verb) {
    case 'init':     return runInit(rest);
    case 'pair':     return runPair(rest);
    case 'doctor':   return runDoctor(rest);
    case 'update':   return runUpdate(rest);
    case 'rollback': return runRollback(rest);
    case 'enrich':   return runEnrich(rest);
    case 'forget':   return runForget(rest);
    case 'unbind':   return runUnbind(rest);
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${argv[0]}\n\n${USAGE}`);
      return 2;
  }
}

// Run when invoked as a bin (not when imported by tests).
// TODO(impl): tighten the entrypoint guard for NodeNext (compare import.meta.url
// to pathToFileURL(process.argv[1])).
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fortytwo: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
