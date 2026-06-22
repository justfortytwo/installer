// rollback — restore the prior version set after a bad update.
//
// The counterpart to `update`'s manual-rollback safety model. update records the
// pre-upgrade set into state.json's `previous`; rollback re-installs exactly that
// set and rotates the ledger back. This is the ONLY safety net under the
// "latest-compatible, no bill-of-materials" policy: there's no canonical "known
// good" list except what we captured at the last successful install.

import { readState, recordVersionSet } from '../state.js';
import { runDoctorChecks } from './doctor.js';

export async function runRollback(_argv: string[]): Promise<number> {
  // TODO(impl):
  //   const state = readState()
  //   if (!state) -> error: nothing to roll back (init never ran). return 1
  //   if (!state.previous) -> error: no prior set recorded (only one install so
  //                            far, or already rolled back). return 1
  //   await installSet(state.previous)            // TODO(wire): reuse update's installer
  //   recordVersionSet(state.previous)            // restore previous as current
  //   const { ok } = await runDoctorChecks()      // verify the restore is healthy
  //   print restored set; return ok ? 0 : 1
  void readState; void recordVersionSet; void runDoctorChecks;
  throw new Error('TODO(impl): runRollback — restore state.json.previous and re-verify');
}
