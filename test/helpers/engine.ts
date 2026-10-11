// helpers/engine.ts — give a sandbox project its own engine install.
//
// The CLI resolves @justfortytwo/* siblings from the TARGET PROJECT (cwd), not
// from the installer's own tree, so a test that chdirs into a tmp sandbox must
// put the engine in that sandbox's node_modules — exactly where `init` would
// install it. We symlink the siblings this repo already has (linked locally,
// installed by CI) instead of re-installing them, plus this repo itself as the
// project's own @justfortytwo/installer (init pins the CLI into the project).

import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_SCOPE_DIR = fileURLToPath(new URL('../../node_modules/@justfortytwo', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Link this repo's engine siblings, and the repo as the project CLI, into `<projectDir>/node_modules`. */
export function linkEngineInto(projectDir: string): void {
  const scope = join(projectDir, 'node_modules', '@justfortytwo');
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(REPO_SCOPE_DIR)) {
    symlinkSync(join(REPO_SCOPE_DIR, name), join(scope, name), 'dir');
  }
  symlinkSync(REPO_ROOT, join(scope, 'installer'), 'dir');
}
