// shim.ts — the user-level `fortytwo` command.
//
// `npx @justfortytwo/installer init` runs from npm's temporary exec cache, so
// nothing it brings along survives the command. init therefore (a) installs the
// CLI into the project itself (node_modules/.bin/fortytwo, pinned in
// package-lock.json) and (b) drops this tiny POSIX launcher into a directory
// that is ALREADY on the user's PATH. The launcher carries no version and no
// project path: it finds the Fortytwo project the user is in (the nearest
// directory, from cwd upward, containing .fortytwo/) and execs THAT project's
// own CLI from the project root. One launcher serves any number of projects,
// each running its own pinned CLI version.
//
// We never edit shell rc files or PATH. If no suitable directory is on PATH,
// init says so and the project-local `npx fortytwo` keeps working.

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';

/** Identifies a launcher we wrote, so we only ever replace our own file. */
export const SHIM_MARKER = 'fortytwo-shim';

export const SHIM_SCRIPT = `#!/bin/sh
# fortytwo — user-level launcher installed by @justfortytwo/installer (${SHIM_MARKER} v1).
# It holds no version and no project path. It finds the Fortytwo project you are
# in (the nearest directory, from here upward, that contains .fortytwo/) and runs
# that project's own CLI, node_modules/.bin/fortytwo, from the project root.
# Safe to delete: \`npx @justfortytwo/installer init\` puts it back.
d=$(pwd -P) || exit 1
while :; do
  if [ -d "$d/.fortytwo" ]; then
    if [ -x "$d/node_modules/.bin/fortytwo" ]; then
      cd "$d" && exec "$d/node_modules/.bin/fortytwo" "$@"
    fi
    echo "fortytwo: $d is a Fortytwo project, but its CLI is not installed there." >&2
    echo "Install it with: (cd \\"$d\\" && npm install @justfortytwo/installer)" >&2
    exit 1
  fi
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
echo "fortytwo: not inside a Fortytwo project (no .fortytwo/ here or in any parent directory)." >&2
echo "Create one with: npx @justfortytwo/installer init" >&2
exit 1
`;

export type ShimResult =
  | { status: 'installed' | 'updated' | 'unchanged'; path: string }
  /** A `fortytwo` we did not write is in the way (user file, global npm install): left alone. */
  | { status: 'foreign'; path: string }
  /** No writable directory on PATH; nothing written. */
  | { status: 'no-dir' }
  | { status: 'unsupported'; platform: string };

export interface ShimEnv {
  home: string;
  /** The user's PATH. */
  pathEnv: string;
  platform: NodeJS.Platform;
  /** FORTYTWO_BIN_DIR: install into exactly this directory (created if needed). */
  override?: string;
  /** npm's global bin directory, if known (looked up lazily, last resort). */
  npmGlobalBin?: () => string | null;
}

export function isOurShim(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').slice(0, 512).includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * The user's own PATH entries. Entries npm adds while running a bin
 * (node_modules/.bin of the project or of the npx cache) are not the user's
 * PATH and vanish once the command exits, so they never count.
 */
export function userPathDirs(pathEnv: string): string[] {
  return pathEnv
    .split(delimiter)
    .filter((d) => d && !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(d) && !/[\\/]_npx[\\/]/.test(d));
}

/** The first executable `name` on the user's PATH, or null. */
export function findOnPath(name: string, pathEnv: string): string | null {
  for (const dir of userPathDirs(pathEnv)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; }
    } catch { /* not here */ }
  }
  return null;
}

function writableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to put the launcher: the first of ~/.local/bin, ~/bin, npm's global bin
 * directory that is already on PATH and writable. null if none is.
 */
export function chooseShimDir(env: ShimEnv): string | null {
  const onPath = new Set(userPathDirs(env.pathEnv).map(canonical));
  const candidates: (() => string | null)[] = [
    () => join(env.home, '.local', 'bin'),
    () => join(env.home, 'bin'),
    () => env.npmGlobalBin?.() ?? null,
  ];
  for (const next of candidates) {
    const dir = next();
    if (dir && onPath.has(canonical(dir)) && writableDir(dir)) return dir;
  }
  return null;
}

/**
 * Install or refresh the launcher. Idempotent; never replaces a file it did not
 * write. A launcher already on PATH (ours) is refreshed in place rather than
 * duplicated elsewhere.
 */
export function installShim(env: ShimEnv): ShimResult {
  if (env.platform === 'win32') return { status: 'unsupported', platform: env.platform };

  let target: string;
  if (env.override) {
    if (!writableDir(env.override)) return { status: 'no-dir' };
    target = join(env.override, 'fortytwo');
  } else {
    const existing = findOnPath('fortytwo', env.pathEnv);
    if (existing) {
      if (!isOurShim(existing)) return { status: 'foreign', path: existing };
      target = existing;
    } else {
      const dir = chooseShimDir(env);
      if (!dir) return { status: 'no-dir' };
      target = join(dir, 'fortytwo');
    }
  }

  const present = existsSync(target);
  if (present && !isOurShim(target)) return { status: 'foreign', path: target };
  if (present && readFileSync(target, 'utf8') === SHIM_SCRIPT) return { status: 'unchanged', path: target };

  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, SHIM_SCRIPT, { encoding: 'utf8', mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  return { status: present ? 'updated' : 'installed', path: target };
}

/** `npm prefix -g`/bin — where npm itself puts user commands (on PATH wherever npm works). */
export function npmGlobalBin(): string | null {
  const res = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8' });
  const prefix = res.status === 0 ? res.stdout.trim() : '';
  return prefix ? join(prefix, 'bin') : null;
}
