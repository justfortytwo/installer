// render.ts — materialize the PERSONA SURFACE.
//
// Two-surface model:
//   1. The npm "engine" (memory MCP, safety gate, channel adapters, embedder) —
//      installed as @justfortytwo/* packages, wired as Claude Code plugins.
//   2. The PERSONA — CLAUDE.md + context/* . This is NOT a plugin. It is per-user,
//      gitignored, and personal. The CLI SCAFFOLDS it by rendering the
//      @justfortytwo/persona package's `templates/` against the user's captured
//      `.fortytwo/identity.json`, guided by that package's manifest.
//
// IDEMPOTENCE CONTRACT: re-rendering must NOT clobber captured fields. A user who
// hand-edits context/SOUL.md after init keeps those edits on the next
// `update`/`enrich` re-render. Strategy: MANAGED outputs are (re)written every
// run; CAPTURED outputs are written only on first render (when absent).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Identity, Answers } from './state.js';
import { findSiblingDir } from './engine.js';

/** Maps each persona template to an output path + render mode. */
export interface PersonaFile {
  /** Template path, relative to the persona package's templates dir. */
  template: string;
  /** Output path, relative to the project root. */
  output: string;
  /** CAPTURED = write-once (user-owned after); MANAGED = re-render every run. */
  mode: 'captured' | 'managed';
}

/** One persona manifest field (drives `fortytwo init` prompts + answer resolution). */
export interface PersonaManifestField {
  key: string;
  prompt: string;
  type: string;
  required?: boolean;
  default?: unknown;
}

/** The persona package's manifest, resolved for rendering. */
export interface PersonaManifest {
  manifestVersion: number;
  files: PersonaFile[];
  /** The raw field descriptors (for init's prompt + answer resolution). */
  fields: PersonaManifestField[];
  /** Field keys the renderer must have a value for (manifest fields, required=true). */
  requiredVars: string[];
  /** Field keys that are optional (required=false). */
  optionalVars: string[];
  /** Absolute path to the package's `templates/` dir. */
  templatesDir: string;
}

export interface RenderOptions {
  /** Project root that receives CLAUDE.md + context/*. Defaults to cwd. */
  root?: string;
  /** Resolved location of the @justfortytwo/persona package (for loadPersonaManifest). */
  personaPackageDir?: string;
  /** If true, report what WOULD be written without touching disk. */
  dryRun?: boolean;
  /** Injected file map (hermetic/testable; bypasses loadPersonaManifest). */
  files?: PersonaFile[];
  /** Directory the `template` paths are resolved against (hermetic/testable). */
  templatesDir?: string;
}

export interface RenderResult {
  written: string[];
  skipped: string[]; // captured outputs left untouched because they already exist
}

/**
 * Substitute `{{key}}` references with captured answers (flat, keyed by the
 * persona manifest field keys — snake_case, exactly what templates use).
 *   - string value: inlined as-is.
 *   - list value (array): joined with "\n- " so it slots after a leading "- "
 *     in the template (the markdown bullet convention the templates rely on).
 * Fails LOUDLY on a referenced variable that's missing/null — a half-filled
 * persona (blank owner name, blank agent name) is worse than a clear error at
 * scaffold time. Own-property only: `{{toString}}`/`{{__proto__}}` fail loud,
 * they never resolve a prototype member into the rendered persona.
 */
export function renderTemplate(template: string, answers: Answers): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const has = Object.prototype.hasOwnProperty.call(answers, key);
    const v = has ? (answers as Record<string, unknown>)[key] : undefined;
    if (v === undefined || v === null) {
      throw new Error(`renderTemplate: missing required variable {{${key}}} in identity`);
    }
    return Array.isArray(v) ? v.join('\n- ') : String(v);
  });
}

/**
 * Locate the persona package and read its manifest. With `personaPackageDir`
 * (tests, or an explicitly-resolved path) we read `<dir>/manifest.json`;
 * otherwise we locate `@justfortytwo/persona` in the TARGET PROJECT's
 * node_modules (from `projectRoot`, not from this module: under npx the installer
 * runs from npm's exec cache, a separate tree) so we honor the installed version. The manifest's `files`
 * map drives rendering; `fields` (required flag) gives the required/optional
 * var split; templates live under `<packageDir>/templates`.
 */
export function loadPersonaManifest(personaPackageDir?: string, projectRoot: string = process.cwd()): PersonaManifest {
  let pkgDir: string;
  if (personaPackageDir) {
    pkgDir = resolve(personaPackageDir);
  } else {
    const found = findSiblingDir('@justfortytwo/persona', projectRoot);
    if (!found) {
      throw new Error(
        `@justfortytwo/persona is not installed in ${resolve(projectRoot)} (looked in node_modules up from there). ` +
        'Run `fortytwo init` (it installs the engine) or `npm install @justfortytwo/persona`.',
      );
    }
    pkgDir = found;
  }
  const manifestPath = join(pkgDir, 'manifest.json');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    manifestVersion?: number;
    files?: PersonaFile[];
    fields?: PersonaManifestField[];
  };
  const fields = raw.fields ?? [];
  return {
    manifestVersion: raw.manifestVersion ?? 1,
    files: raw.files ?? [],
    fields,
    requiredVars: fields.filter((f) => f.required).map((f) => f.key),
    optionalVars: fields.filter((f) => !f.required).map((f) => f.key),
    templatesDir: join(pkgDir, 'templates'),
  };
}

/**
 * Render the whole persona surface. Idempotent and non-clobbering:
 *   - MANAGED outputs: always (re)written from templates.
 *   - CAPTURED outputs: written only if they don't already exist; if present,
 *     left exactly as the user edited them (recorded in `skipped`).
 * The file map + templates dir come from the persona manifest unless injected
 * via opts (hermetic tests).
 */
export function renderPersona(identity: Identity, opts: RenderOptions = {}): RenderResult {
  const root = resolve(opts.root ?? process.cwd());
  let files = opts.files;
  let tplRoot = opts.templatesDir ? resolve(opts.templatesDir) : undefined;
  if (!files || !tplRoot) {
    const manifest = loadPersonaManifest(opts.personaPackageDir, root);
    files = files ?? manifest.files;
    tplRoot = tplRoot ?? resolve(manifest.templatesDir);
  }
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    // Defense-in-depth: even though the manifest ships in the trusted persona
    // package, never let an output/template path escape its root via `..`.
    const outPath = resolve(root, f.output);
    if (outPath !== root && !outPath.startsWith(root + sep)) {
      throw new Error(`renderPersona: output path escapes project root: ${f.output}`);
    }
    if (f.mode === 'captured' && existsSync(outPath)) {
      skipped.push(f.output);
      continue;
    }
    const tplPath = resolve(tplRoot, f.template);
    if (!tplPath.startsWith(tplRoot + sep)) {
      throw new Error(`renderPersona: template path escapes templates dir: ${f.template}`);
    }
    const rendered = renderTemplate(readFileSync(tplPath, 'utf8'), identity.answers);
    if (!opts.dryRun) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, rendered, 'utf8');
    }
    written.push(f.output);
  }
  return { written, skipped };
}
