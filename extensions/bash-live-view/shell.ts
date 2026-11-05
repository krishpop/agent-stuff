import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { resolveShellWith, type ResolvedShell } from './shell-resolve.ts';

export type { ResolvedShell };

function bashOnPath(): string | undefined {
  try {
    const r = spawnSync('which', ['bash'], { encoding: 'utf-8', timeout: 5000 });
    const first = r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined;
    return first && existsSync(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the shell used for PTY sessions. See shell-resolve.ts for the policy. */
export function resolveShell(): ResolvedShell {
  return resolveShellWith({
    exists: existsSync,
    piShell: getShellConfig,
    onPath: bashOnPath,
    env: process.env,
  });
}
