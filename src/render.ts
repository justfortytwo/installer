// render.ts — materialize the PERSONA SURFACE.
//
// Two-surface model:
//   1. The npm "engine" (guide MCP, safety gate, channel adapters, embedder) —
//      installed as @justfortytwo/* packages, wired as Claude Code plugins.
//   2. The PERSONA — CLAUDE.md + context/* . This is NOT a plugin. It is per-user,
//      gitignored, and personal. The CLI SCAFFOLDS it by rendering the
//      @justfortytwo/ford package's `templates/` against the user's captured
//      `.fortytwo/identity.json`, guided by that package's `manifest.json`.
//
// manifest.json (in the ford package) declares:
//   - which template files map to which output paths under the user's project
//     (e.g. templates/OWNER.md.tmpl -> context/OWNER.md, CLAUDE.md.tmpl -> CLAUDE.md)
//   - the required + optional template variables (sourced from identity.json)
//   - which outputs are CAPTURED (user-owned: edited freely after first render)
//     vs MANAGED (CLI re-renders on every run).
//
// IDEMPOTENCE CONTRACT: re-rendering must NOT clobber captured fields. A user
// who hand-edits context/SOUL.md after init keeps those edits on the next
// `update`/`enrich` re-render. Strategy: only (re)write MANAGED outputs; for
// CAPTURED outputs, write ONLY if absent (first render). Managed outputs that
// embed user prose use sentinel-delimited regions so the managed scaffold can
// be refreshed without touching the user's hand-written body.

import type { Identity } from './state.js';

/** Mirrors @justfortytwo/ford's manifest.json. TODO(wire): import its type. */
export interface PersonaManifest {
  manifestVersion: number;
  /** template path (relative to persona pkg) -> output path (relative to project root) */
  files: Array<{
    template: string;
    output: string;
    /** CAPTURED = write-once (user-owned after); MANAGED = re-render every run. */
    mode: 'captured' | 'managed';
  }>;
  /** Variable names the templates require to be present in identity.json. */
  requiredVars: string[];
  optionalVars?: string[];
}

export interface RenderOptions {
  /** Project root that receives CLAUDE.md + context/*. Defaults to cwd. */
  root?: string;
  /** Resolved location of the @justfortytwo/ford package. */
  personaPackageDir?: string;
  /** If true, report what WOULD be written without touching disk. */
  dryRun?: boolean;
}

export interface RenderResult {
  written: string[];
  skipped: string[]; // captured outputs left untouched because they already exist
}

/**
 * Locate the installed @justfortytwo/ford package and read its manifest.json.
 * TODO(wire): resolve via createRequire(import.meta.url).resolve(
 *   '@justfortytwo/ford/manifest.json') so we honor the user's installed
 *   version (latest-in-range), not a vendored copy.
 */
export function loadPersonaManifest(_personaPackageDir?: string): PersonaManifest {
  // TODO(impl): read + parse manifest.json; validate manifestVersion against
  // what this CLI understands.
  throw new Error('TODO(wire): loadPersonaManifest — read @justfortytwo/ford/manifest.json');
}

/**
 * Substitute identity values into a single template string.
 * TODO(impl): pick a minimal, dependency-free templating scheme (e.g. {{var}}
 * with dotted paths into identity, like {{owner.name}} / {{agentName}}). Fail
 * loudly on a required var that's missing from identity.json rather than
 * emitting an empty/placeholder persona.
 */
export function renderTemplate(_template: string, _identity: Identity): string {
  throw new Error('TODO(impl): renderTemplate — {{var}} substitution from identity.json');
}

/**
 * Render the whole persona surface. Idempotent and non-clobbering:
 *   - MANAGED outputs: always (re)written from templates.
 *   - CAPTURED outputs: written only if they don't already exist; if present,
 *     left exactly as the user edited them (recorded in `skipped`).
 *
 * Called by: init (first render), update (refresh managed scaffold), enrich
 * (after mutating identity.json's enrichment block).
 */
export function renderPersona(_identity: Identity, _opts: RenderOptions = {}): RenderResult {
  // TODO(impl):
  //   1. const manifest = loadPersonaManifest(opts.personaPackageDir)
  //   2. validate identity has all manifest.requiredVars
  //   3. for each file: read template, renderTemplate(...), then
  //        - managed:  write (overwrite) -> written
  //        - captured: write only if !existsSync(output) -> written | skipped
  //   4. honor opts.dryRun (compute written/skipped without writing)
  throw new Error('TODO(impl): renderPersona — render persona templates idempotently');
}
