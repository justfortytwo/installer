// update — upgrade the engine within the declared semver ranges.
//
// Distribution policy: "semver ranges, latest-compatible". There is NO curated
// bill-of-materials. update therefore:
//   1. RECORD the current resolved version set as the rollback baseline
//      (state.json: current -> previous) BEFORE changing anything.
//   2. RESOLVE latest-in-range for every @justfortytwo/* sibling (the ranges in
//      this package's peerDeps / fortytwo.compat).
//   3. INSTALL that set.
//   4. POST-VERIFY with doctor (the health check).
//   5. On success: record the new set as `current`. On failure: leave the failed
//      set in place but LOUDLY point the user at `fortytwo rollback`. Rollback is
//      MANUAL by design — we never auto-revert, so the user can inspect first.
//
// Re-render the persona's MANAGED scaffold afterward (render.ts is idempotent and
// does not clobber captured fields), in case a new persona template version ships.

import { recordVersionSet, readState } from '../state.js';
import { renderPersona, type RenderResult } from '../render.js';
import { runDoctorChecks } from './doctor.js';

interface UpdateFlags {
  /** Resolve + report the would-be set without installing. */
  dryRun?: boolean;
}

/**
 * Resolve latest-in-range for each sibling from the declared ranges.
 * TODO(wire): read this package's peerDeps + fortytwo.compat for ranges, then
 * query the registry (npm view <pkg> versions) and pick the highest satisfying
 * version per range. Returns the VersionPin[] for state.json.
 */
async function resolveLatestInRange(): Promise<import('../state.js').VersionPin[]> {
  throw new Error('TODO(wire): resolveLatestInRange — npm registry resolve against declared ranges');
}

/**
 * Install the resolved set.
 * TODO(wire): shell out to the user's package manager (npm/pnpm/yarn detected
 * from the lockfile) to install the resolved versions, or update peerDep pins.
 */
async function installSet(_set: import('../state.js').VersionPin[]): Promise<void> {
  throw new Error('TODO(wire): installSet — install resolved sibling versions');
}

export async function runUpdate(_argv: string[]): Promise<number> {
  // TODO(impl) orchestration:
  //   const prior = readState()                  // baseline must exist (init ran)
  //   const next = await resolveLatestInRange()
  //   if dryRun: print prior vs next diff; return 0
  //   await installSet(next)
  //   recordVersionSet(next)                      // rotates prior.current -> previous
  //   const { results, ok } = await runDoctorChecks()  // post-verify
  //   renderPersona(readIdentity())               // refresh managed scaffold (no clobber)
  //   if (!ok) { print failed checks + "run `fortytwo rollback` to restore the
  //              previous set"; return 1 }
  //   print upgraded set; return 0
  void recordVersionSet; void readState; void resolveLatestInRange; void installSet;
  void runDoctorChecks; void renderPersona;
  void (null as unknown as RenderResult);
  void (null as unknown as UpdateFlags);
  throw new Error('TODO(impl): runUpdate — resolve latest-in-range, install, doctor, point to rollback on failure');
}
