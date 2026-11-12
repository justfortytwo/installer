import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MANAGED_MARKER, reconcileSkills, skillsReport } from '../src/skills.js';
import { findSiblingDir } from '../src/engine.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'installer-skills-')); dirs.push(d); return d; };

const SHIPPED = `---\nname: demo\n---\n<!-- ${MANAGED_MARKER} -->\nv1\n`;
const OUT = '.claude/skills/demo/SKILL.md';

/** A fake persona package dir with one skill (or the given manifest `skills`). */
function persona(skills: unknown = [{ source: 'skills/demo/SKILL.md', output: OUT }], body = SHIPPED): string {
  const dir = tmp();
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(skills === undefined ? { files: [] } : { files: [], skills }));
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), body);
  return dir;
}

describe('reconcileSkills', () => {
  it('copies a shipped skill into .claude/skills', () => {
    const root = tmp();
    expect(reconcileSkills(root, persona())).toEqual({ written: [OUT], unchanged: [], foreign: [] });
    expect(readFileSync(join(root, OUT), 'utf8')).toBe(SHIPPED);
  });

  it('reports an identical file as unchanged', () => {
    const root = tmp(); const pkg = persona();
    reconcileSkills(root, pkg);
    expect(reconcileSkills(root, pkg)).toEqual({ written: [], unchanged: [OUT], foreign: [] });
  });

  it('rewrites a file fortytwo wrote when the shipped version changed', () => {
    const root = tmp();
    reconcileSkills(root, persona());
    const v2 = SHIPPED.replace('v1', 'v2');
    expect(reconcileSkills(root, persona([{ source: 'skills/demo/SKILL.md', output: OUT }], v2)).written).toEqual([OUT]);
    expect(readFileSync(join(root, OUT), 'utf8')).toBe(v2);
  });

  it("leaves the owner's own skill of the same name alone", () => {
    const root = tmp();
    mkdirSync(dirname(join(root, OUT)), { recursive: true });
    writeFileSync(join(root, OUT), '---\nname: demo\n---\nmine\n');
    const r = reconcileSkills(root, persona());
    expect(r).toEqual({ written: [], unchanged: [], foreign: [OUT] });
    expect(readFileSync(join(root, OUT), 'utf8')).toContain('mine');
    expect(skillsReport(r)).toEqual([expect.stringContaining(`left ${OUT} alone`)]);
  });

  it('is a no-op for a persona that predates skills', () => {
    const root = tmp();
    const dir = tmp();
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: [] }));
    expect(reconcileSkills(root, dir)).toEqual({ written: [], unchanged: [], foreign: [] });
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('is a no-op for a persona package without a manifest', () => {
    const root = tmp();
    expect(reconcileSkills(root, tmp())).toEqual({ written: [], unchanged: [], foreign: [] });
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('is a no-op when persona is not installed in the project', () => {
    expect(reconcileSkills(tmp())).toEqual({ written: [], unchanged: [], foreign: [] });
  });

  it('refuses an output outside .claude/skills', () => {
    for (const output of ['context/rules/APPROVED.md', '.claude/settings.json', '.claude/skills/../../x.md', '../x.md']) {
      expect(() => reconcileSkills(tmp(), persona([{ source: 'skills/demo/SKILL.md', output }])), output)
        .toThrow(/outside \.claude\/skills/);
    }
  });

  it('refuses a source outside the persona package', () => {
    expect(() => reconcileSkills(tmp(), persona([{ source: '../secret', output: OUT }])))
      .toThrow(/escapes the persona package/);
  });
});

describe('skillsReport', () => {
  it('says nothing when nothing changed', () => {
    expect(skillsReport({ written: [], unchanged: [OUT], foreign: [] })).toEqual([]);
  });
  it('counts the files it installed', () => {
    expect(skillsReport({ written: [OUT], unchanged: [], foreign: [] })).toEqual(['✓ installed 1 skill file(s) in .claude/skills']);
  });
});

// Contract with the real sibling: every skill persona ships carries the marker
// (or an update could never refresh it) and lands where the scheduler looks.
describe('with the linked @justfortytwo/persona', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const personaDir = findSiblingDir('@justfortytwo/persona', here);

  it.runIf(personaDir)('installs daily-briefing and learn-review, each marked as managed', () => {
    const root = tmp();
    const r = reconcileSkills(root, personaDir!);
    expect(r.written.sort()).toEqual(['.claude/skills/daily-briefing/SKILL.md', '.claude/skills/learn-review/SKILL.md']);
    for (const f of r.written) expect(readFileSync(join(root, f), 'utf8'), f).toContain(MANAGED_MARKER);
  });
});
