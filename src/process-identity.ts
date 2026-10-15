// OS process generation identity, independent of the project's heartbeat.
import { readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** null means identity cannot be established; never fall back to PID existence. */
export function readProcessIdentity(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) is parenthesized, but may itself contain ')' or whitespace.
      const end = stat.lastIndexOf(')');
      if (!stat.startsWith(`${pid} (`) || end < 0) return null;
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      const start = fields[19]; // fields[0] is state (field 3); starttime is field 22
      if (!start || !/^\d+$/.test(start) || ['Z', 'X', 'x'].includes(fields[0] ?? '')) return null;
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const namespace = readlinkSync(`/proc/${pid}/ns/pid`);
      if (!boot || !/^pid:\[\d+\]$/.test(namespace)) return null;
      return `linux:${boot}:${namespace}:${start}`;
    }
    // BSD/macOS ps exposes an OS-derived start time (second resolution).
    // Fix locale/timezone so callers with different environments compare equally.
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    const start = result.stdout.trim().replace(/\s+/g, ' ');
    if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)) return null;
    return `ps:${platform}:${start}`;
  } catch {
    return null;
  }
}
