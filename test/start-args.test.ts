// `fortytwo start [-- <claude args>]`: everything after `--` is handed to Claude
// Code through FORTYTWO_CLAUDE_ARGS (a JSON array the services read at boot).
import { describe, it, expect } from 'vitest';
import { CLAUDE_ARGS_ENV, applyStartFlags, parseStartArgs } from '../src/commands/start.js';

describe('parseStartArgs', () => {
  it('leaves Claude arguments untouched when there is no --', () => {
    expect(parseStartArgs([])).toEqual({ help: false, claudeArgs: null });
  });

  it('takes everything after -- verbatim as Claude arguments', () => {
    expect(parseStartArgs(['--', '--chrome', '--append-system-prompt', 'be brief']))
      .toEqual({ help: false, claudeArgs: ['--chrome', '--append-system-prompt', 'be brief'] });
  });

  it('treats a bare -- as "no Claude arguments", overriding any saved value', () => {
    expect(parseStartArgs(['--'])).toEqual({ help: false, claudeArgs: [] });
  });

  it('does not read --help after -- as its own', () => {
    expect(parseStartArgs(['--', '--help'])).toEqual({ help: false, claudeArgs: ['--help'] });
    expect(parseStartArgs(['--help']).help).toBe(true);
    expect(parseStartArgs(['-h']).help).toBe(true);
  });

  it('rejects an option before -- and says where Claude arguments go', () => {
    const r = parseStartArgs(['--chrome']);
    expect(r.error).toMatch(/--chrome/);
    expect(r.error).toMatch(/after `--`/);
  });
});

describe('applyStartFlags', () => {
  it('uses the variable name the services read', () => {
    expect(CLAUDE_ARGS_ENV).toBe('FORTYTWO_CLAUDE_ARGS');
  });

  it('keeps the env value when no -- was given', () => {
    const env = applyStartFlags({ FORTYTWO_CLAUDE_ARGS: '["--from-env"]' }, { help: false, claudeArgs: null });
    expect(env.FORTYTWO_CLAUDE_ARGS).toBe('["--from-env"]');
  });

  it('lets the command line win over the env, as a JSON array', () => {
    const base = { FORTYTWO_CLAUDE_ARGS: '["--from-env"]', OTHER: 'x' };
    const env = applyStartFlags(base, { help: false, claudeArgs: ['--chrome', 'two words'] });
    expect(JSON.parse(env.FORTYTWO_CLAUDE_ARGS!)).toEqual(['--chrome', 'two words']);
    expect(env.OTHER).toBe('x');
    expect(base.FORTYTWO_CLAUDE_ARGS).toBe('["--from-env"]'); // input not mutated
  });
});
