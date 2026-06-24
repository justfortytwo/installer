// rollback — restore the prior version set after a bad update.
//
// The counterpart to `update`'s manual-rollback safety model: update records the
// pre-upgrade set into state.json's `previous`; rollback re-installs exactly that
// set and rotates the ledger back. This is the ONLY safety net under the
// "latest-compatible, no bill-of-materials" policy.
//
// The implementation (performRollback + its real deps) lives in update.ts
// alongside the shared resolve/install primitives; this module just re-exports
// the entry point so index.ts's dispatch table keeps its stable import path.

export { runRollback } from './update.js';
