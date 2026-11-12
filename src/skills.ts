// skills.ts — copy the Claude Code skills that ship in @justfortytwo/persona
// into the project's `.claude/skills/`.
//
// These are MACHINE-OWNED runtime assets, not owner context: the scheduler's
// built-in jobs call them by name (daily-briefing, learn-review), so `init`
// and every `update` rewrite them from the installed persona package. That is
// why update may call this even though it never renders persona context.
//
// A file at a target path that fortytwo did not write (no MANAGED_MARKER) is
// the owner's own skill and is left alone, never overwritten. So is a target
// reached through a symlink (e.g. `.claude/skills` linked to a dotfiles repo):
// this runs unattended on update and must never write outside the project.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { findSiblingDir } from './engine.js';

/** Present in every skill file fortytwo ships; marks a target as safe to rewrite. */
export const MANAGED_MARKER = 'Managed by fortytwo';

/** The only directory this module writes into, relative to the project root. */
const SKILLS_OUTPUT_DIR = join('.claude', 'skills');

interface SkillEntry { source: string; output: string }

export interface SkillsResult {
  /** Outputs created or rewritten (relative to the project root). */
  written: string[];
  /** Outputs already identical to the shipped file. */
  unchanged: string[];
  /** Outputs left alone: the existing file was not written by fortytwo, or the path goes through a symlink. */
  foreign: string[];
}

/**
 * Bring the project's shipped skills in line with the installed persona
 * package. A persona that is not installed, or that predates skills (no
 * `skills` in its manifest), is a no-op.
 */
export function reconcileSkills(root: string, personaPackageDir?: string): SkillsResult {
  const result: SkillsResult = { written: [], unchanged: [], foreign: [] };
  const projectRoot = resolve(root);
  const found = personaPackageDir ?? findSiblingDir('@justfortytwo/persona', projectRoot);
  if (!found) return result;
  const pkgDir = resolve(found);

  // No manifest means there is nothing to copy. Update runs this unattended
  // right after installing packages, so a persona without one must not abort it.
  const manifestPath = join(pkgDir, 'manifest.json');
  if (!existsSync(manifestPath)) return result;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills?: SkillEntry[] };
  const outDir = join(projectRoot, SKILLS_OUTPUT_DIR);

  for (const entry of manifest.skills ?? []) {
    // Defense-in-depth, same as renderPersona: the manifest ships in the trusted
    // persona package, but a path must never escape its root. Outputs are also
    // confined to .claude/skills, since this runs unattended on every update.
    const srcPath = resolve(pkgDir, entry.source);
    if (!srcPath.startsWith(pkgDir + sep)) {
      throw new Error(`reconcileSkills: source path escapes the persona package: ${entry.source}`);
    }
    const outPath = resolve(projectRoot, entry.output);
    if (!outPath.startsWith(outDir + sep)) {
      throw new Error(`reconcileSkills: output path is outside ${SKILLS_OUTPUT_DIR}: ${entry.output}`);
    }

    if (throughSymlink(projectRoot, outPath)) { result.foreign.push(entry.output); continue; }

    const shipped = readFileSync(srcPath, 'utf8');
    if (existsSync(outPath)) {
      const current = readFileSync(outPath, 'utf8');
      if (current === shipped) { result.unchanged.push(entry.output); continue; }
      if (!current.includes(MANAGED_MARKER)) { result.foreign.push(entry.output); continue; }
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, shipped, 'utf8');
    result.written.push(entry.output);
  }
  return result;
}

/**
 * True when any existing component of `target` below `root` is a symbolic
 * link, including the file itself (also a dangling one). The lexical
 * containment check cannot see these: a link inside `.claude/skills` would
 * redirect the write to wherever it points.
 */
function throughSymlink(root: string, target: string): boolean {
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false; // does not exist yet: nothing below it can be a link
    }
  }
  return false;
}

/** One report line per outcome that the owner should know about ([] when nothing changed). */
export function skillsReport(r: SkillsResult): string[] {
  const lines: string[] = [];
  if (r.written.length > 0) lines.push(`✓ installed ${r.written.length} skill file(s) in .claude/skills`);
  for (const f of r.foreign) lines.push(`! left ${f} alone (not written by Fortytwo, or behind a symlink); the built-in schedule will use what is there`);
  return lines;
}
