// helpers/engine.ts — give a sandbox project its own engine install.
//
// The CLI resolves @justfortytwo/* siblings from the TARGET PROJECT (cwd), not
// from the installer's own tree, so a test that chdirs into a tmp sandbox must
// put the engine in that sandbox's node_modules — exactly where `init` would
// install it. We symlink the siblings this repo already has (linked locally,
// installed by CI) instead of re-installing them, plus this repo itself as the
// project's own @justfortytwo/installer (init pins the CLI into the project).

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_SCOPE_DIR = fileURLToPath(new URL('../../node_modules/@justfortytwo', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Link this repo's engine siblings, and the repo as the project CLI, into `<projectDir>/node_modules`. */
export function linkEngineInto(projectDir: string): void {
  // Every fortytwo.compat package must be linkable here. A missing one would make
  // init run a real `npm install` in the sandbox, which prunes these symlinks
  // (persona vanishes) and turns a setup gap into confusing e2e failures.
  const compat = Object.keys(
    (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { fortytwo: { compat: Record<string, string> } })
      .fortytwo.compat,
  );
  const missing = compat.filter((pkg) => !existsSync(join(REPO_SCOPE_DIR, pkg.replace('@justfortytwo/', ''), 'package.json')));
  if (missing.length > 0) {
    throw new Error(
      `linkEngineInto: ${missing.join(', ')} not in ${REPO_SCOPE_DIR}. Link or install every fortytwo.compat ` +
      'package (CI: add it to `siblings` in .github/workflows/ci.yml).',
    );
  }
  const scope = join(projectDir, 'node_modules', '@justfortytwo');
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(REPO_SCOPE_DIR)) {
    symlinkSync(join(REPO_SCOPE_DIR, name), join(scope, name), 'dir');
  }
  symlinkSync(REPO_ROOT, join(scope, 'installer'), 'dir');
}
