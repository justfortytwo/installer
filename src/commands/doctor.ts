// doctor — the post-verify health check. Run standalone, and also automatically
// at the end of `update` to decide whether an upgrade is healthy or needs rollback.
//
// Each check is independent and reported individually so a partial failure is
// actionable. Exit code is non-zero if ANY required check fails.
//
// CROSS-PACKAGE CONTRACTS asserted here:
//   - @justfortytwo/guide exports GUIDE_TOOL_CONTRACT_VERSION and its tools are
//     namespaced mcp__fortytwo-guide__* (e.g. mcp__fortytwo-guide__store,
//     mcp__fortytwo-guide__recall, mcp__fortytwo-guide__query). doctor boots the
//     MCP and asserts the advertised tool schema matches the version this CLI was
//     built against.
//   - @justfortytwo/vogon exports POLICY_SCHEMA_VERSION. doctor fires a SYNTHETIC
//     PreToolUse event at the gate and asserts a well-formed allow/defer/deny
//     decision comes back (proving the gate hook is wired and the policy parses).

import { readState } from '../state.js';

// TODO(wire): import { GUIDE_TOOL_CONTRACT_VERSION } from '@justfortytwo/guide'
// TODO(wire): import { POLICY_SCHEMA_VERSION } from '@justfortytwo/vogon'
const EXPECTED_GUIDE_CONTRACT = 'TODO(wire): GUIDE_TOOL_CONTRACT_VERSION';
const EXPECTED_POLICY_SCHEMA = 'TODO(wire): POLICY_SCHEMA_VERSION';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed required check makes doctor exit non-zero; warn-only checks don't. */
  required: boolean;
}

/**
 * Boot the guide MCP server and assert its contract.
 * TODO(wire):
 *   - spawn @justfortytwo/guide's MCP entry over stdio, ListTools, and assert
 *     every expected mcp__fortytwo-guide__* tool is present with the right schema.
 *   - compare the package's GUIDE_TOOL_CONTRACT_VERSION to EXPECTED_GUIDE_CONTRACT.
 */
async function checkGuideContract(): Promise<CheckResult> {
  void EXPECTED_GUIDE_CONTRACT;
  return { name: 'guide-mcp contract', ok: false, required: true, detail: 'TODO(wire): boot MCP + assert GUIDE_TOOL_CONTRACT_VERSION + tool schema' };
}

/**
 * Fire a synthetic PreToolUse at the gate and assert a clean decision.
 * TODO(wire): import the gate's decide(), feed a benign read-tier event, and
 * assert permission ∈ {allow,defer,deny}; compare POLICY_SCHEMA_VERSION.
 */
async function checkGate(): Promise<CheckResult> {
  void EXPECTED_POLICY_SCHEMA;
  return { name: 'safety gate', ok: false, required: true, detail: 'TODO(wire): synthetic PreToolUse -> assert decision + POLICY_SCHEMA_VERSION' };
}

/**
 * Assert the guide DB is fully migrated.
 * TODO(wire): query @justfortytwo/guide's migration state (_migration_state) and
 * confirm no pending migrations against DB_PATH.
 */
async function checkMigrations(): Promise<CheckResult> {
  return { name: 'db migrations', ok: false, required: true, detail: 'TODO(wire): assert no pending migrations on DB_PATH' };
}

/**
 * GET {OLLAMA_BASE_URL}/api/tags and confirm EMBED_MODEL (qwen3-embedding:0.6b)
 * is present. Warn-only — like wakeup.sh, a missing embedder degrades semantic
 * recall but does not block the assistant (FakeEmbedder fallback).
 */
async function checkEmbedder(): Promise<CheckResult> {
  return { name: 'embedder model', ok: false, required: false, detail: 'TODO(impl): GET /api/tags, assert EMBED_MODEL present (warn-only)' };
}

/**
 * Cross-check the INSTALLED sibling versions against the declared ranges
 * (peerDeps + fortytwo.compat). Distribution is "semver ranges, latest-compatible":
 * doctor warns if an installed sibling has drifted outside the compat range this
 * CLI was authored against, so update/rollback decisions are informed.
 */
async function checkCompat(): Promise<CheckResult> {
  void readState;
  return { name: 'peerDeps / fortytwo.compat', ok: false, required: true, detail: 'TODO(wire): compare installed @justfortytwo/* versions to declared ranges' };
}

/**
 * Run all checks, print a per-check report, return aggregate. Reused by `update`
 * as the post-install verify step.
 */
export async function runDoctorChecks(): Promise<{ results: CheckResult[]; ok: boolean }> {
  const results = await Promise.all([
    checkGuideContract(),
    checkGate(),
    checkMigrations(),
    checkEmbedder(),
    checkCompat(),
  ]);
  const ok = results.every((r) => r.ok || !r.required);
  return { results, ok };
}

export async function runDoctor(_argv: string[]): Promise<number> {
  // TODO(impl): const { results, ok } = await runDoctorChecks(); pretty-print
  // each (ok/warn/fail), then return ok ? 0 : 1.
  const { ok } = await runDoctorChecks();
  return ok ? 0 : 1;
}
