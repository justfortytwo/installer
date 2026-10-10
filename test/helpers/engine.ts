// helpers/engine.ts — give a sandbox project its own engine install.
//
// The CLI resolves @justfortytwo/* siblings from the TARGET PROJECT (cwd), not
// from the installer's own tree, so a test that chdirs into a tmp sandbox must
// put the engine in that sandbox's node_modules — exactly where `init` would
// install it. We symlink the siblings this repo already has (linked locally,
// installed by CI) instead of re-installing them.

import { mkdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_SCOPE_DIR = fileURLToPath(new URL('../../node_modules/@justfortytwo', import.meta.url));

/** Link this repo's node_modules/@justfortytwo into `<projectDir>/node_modules`. */
export function linkEngineInto(projectDir: string): void {
  mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
  symlinkSync(REPO_SCOPE_DIR, join(projectDir, 'node_modules', '@justfortytwo'), 'dir');
}
