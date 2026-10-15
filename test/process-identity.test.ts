import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { readProcessIdentity } from '../src/process-identity.js';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), readFileSync: vi.fn(), readlinkSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function linux(start = '123456', boot = 'boot-a', ns = 'pid:[123]') {
  // Field 2 can contain spaces, newlines and closing parentheses.
  const stat = `42 (a tricky) name\n) S ${Array(18).fill('0').join(' ')} ${start} 0`;
  vi.mocked(fs.readFileSync).mockImplementation(((path: string) => path.endsWith('/stat') ? stat : boot + '\n') as typeof fs.readFileSync);
  vi.mocked(fs.readlinkSync).mockReturnValue(ns);
}

describe('Linux process identity', () => {
  it('uses field 22, boot ID and PID namespace without parsing comm as fields', () => {
    linux();
    expect(readProcessIdentity(42, 'linux')).toBe('linux:boot-a:pid:[123]:123456');
    linux('123457'); expect(readProcessIdentity(42, 'linux')).not.toBe('linux:boot-a:pid:[123]:123456');
    linux('123456', 'boot-b'); expect(readProcessIdentity(42, 'linux')).not.toBe('linux:boot-a:pid:[123]:123456');
    linux('123456', 'boot-a', 'pid:[456]'); expect(readProcessIdentity(42, 'linux')).not.toBe('linux:boot-a:pid:[123]:123456');
  });
  it('fails closed on missing proc metadata without falling back to ps', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readProcessIdentity(42, 'linux')).toBeNull();
    expect(cp.spawnSync).not.toHaveBeenCalled();
  });
  it('rejects malformed stat, zombies and invalid PIDs', () => {
    linux(); vi.mocked(fs.readFileSync).mockReturnValue('malformed');
    expect(readProcessIdentity(42, 'linux')).toBeNull();
    linux(); const stat = `42 (gone) Z ${Array(18).fill('0').join(' ')} 123 0`;
    vi.mocked(fs.readFileSync).mockReturnValue(stat);
    expect(readProcessIdentity(42, 'linux')).toBeNull();
    for (const pid of [0, -1, 1.5, NaN, Infinity]) expect(readProcessIdentity(pid, 'linux')).toBeNull();
  });
});

describe('portable process identity', () => {
  it('uses a bounded locale-independent ps start timestamp', () => {
    vi.mocked(cp.spawnSync).mockReturnValue({ status: 0, stdout: ' Thu Oct 15 10:00:00 2026\n' } as any);
    expect(readProcessIdentity(42, 'darwin')).toBe('ps:darwin:Thu Oct 15 10:00:00 2026');
    expect(cp.spawnSync).toHaveBeenCalledWith('ps', ['-p', '42', '-o', 'lstart='], expect.objectContaining({ timeout: 2000, env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }) }));
  });
  it('fails closed when ps fails or returns empty/invalid output', () => {
    for (const result of [{ status: 1, stdout: '' }, { status: 0, stdout: '' }, { status: 0, stdout: 'garbage' }, { status: null, stdout: '', error: new Error('timeout') }]) {
      vi.mocked(cp.spawnSync).mockReturnValue(result as any);
      expect(readProcessIdentity(42, 'darwin')).toBeNull();
    }
  });
});
