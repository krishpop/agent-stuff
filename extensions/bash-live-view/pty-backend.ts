// PTY backend.
//
// Upstream pi-bash-live-view uses node-pty. That does NOT work under pi >= 0.84,
// which ships as a Bun binary: pty.spawn() returns a live pid, but the master fd
// is torn down immediately and the child dies with SIGHUP (~20ms, exit signal 1)
// before executing anything. Verified against plain node, where the same
// node-pty build works correctly -- so it is a Bun/node-pty incompatibility,
// not a packaging problem.
//
// Instead we allocate the PTY with script(1) and read it over an ordinary pipe,
// which Bun handles fine. The child still gets a real controlling terminal
// (isatty()==true, TERM honoured) and output still streams incrementally, so the
// live widget and ANSI emulation are unaffected.
//
// Linux util-linux: `script -qec CMD FILE`. macOS/BSD: `script -q FILE CMD...`
// (`-c` is illegal on BSD — that was crashing /bash-pty on darwin).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export type PtyExit = { exitCode: number | null; signal?: number };

export type PtyHandle = {
  pid: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (e: PtyExit) => void): void;
  kill(signal?: string): void;
};

export type SpawnPtyOptions = {
  shell: string;
  shellArgs: string[];
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
};

const SCRIPT_BIN = ['/usr/bin/script', '/bin/script'].find((p) => existsSync(p));

export function isPtyBackendAvailable(): boolean {
  return Boolean(SCRIPT_BIN);
}

export function ptyBackendUnavailableMessage(): string {
  return 'bash_pty requires script(1) (looked in /usr/bin/script, /bin/script). Use the built-in `bash` tool instead.';
}

/**
 * script(1) prints its own termination banner to the PTY when the session is
 * killed (timeout / abort). That is our plumbing, not command output, so keep it
 * out of what the model sees.
 */
export function stripScriptNoise(text: string): string {
  return text
    .replace(/^\s*Script started, output (log )?file is.*$/gm, '')
    .replace(/^\s*Script done, output (log )?file is.*$/gm, '')
    .replace(/^\s*Session terminated, killing shell\.{0,3}\s*\.{0,3}killed\.\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

/** argv after the script binary. linux = util-linux; anything else = BSD. */
export function scriptArgs(platform: string, shell: string, shellArgs: string[], sized: string): string[] {
  if (platform === 'linux') return ['-qec', sized, '/dev/null'];
  const args = shellArgs.length ? shellArgs : ['-c'];
  return ['-q', '/dev/null', shell, ...args, sized];
}

export function spawnPty(options: SpawnPtyOptions): PtyHandle {
  if (!SCRIPT_BIN) throw new Error(ptyBackendUnavailableMessage());
  const { shell, shellArgs, command, cwd, cols, rows, env } = options;

  // script(1) has no size flag; it sizes from its controlling terminal, which we
  // do not have. Set the size from inside the PTY before the real command runs.
  const sized = `stty cols ${cols} rows ${rows} 2>/dev/null; ${command}`;

  // util-linux `script -c` runs through $SHELL; BSD takes the shell as argv.
  const child = spawn(SCRIPT_BIN, scriptArgs(process.platform, shell, shellArgs, sized), {
    cwd,
    detached: true, // own process group, so killing -pid reaches the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
      SHELL: shell,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLUMNS: String(cols),
      LINES: String(rows),
    } as NodeJS.ProcessEnv,
  });

  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(e: PtyExit) => void>();
  let exited: PtyExit | undefined;

  const emitData = (d: unknown) => {
    const s = String(d);
    for (const cb of dataListeners) cb(s);
  };
  child.stdout?.on('data', emitData);
  child.stderr?.on('data', emitData);

  const finish = (e: PtyExit) => {
    if (exited) return;
    exited = e;
    for (const cb of exitListeners) cb(e);
  };

  child.on('error', () => finish({ exitCode: 127 }));
  child.on('close', (code, signal) => {
    finish({ exitCode: signal ? null : (code ?? 0), signal: signal ? 1 : undefined });
  });

  return {
    pid: child.pid ?? 0,
    onData(cb) {
      dataListeners.add(cb);
    },
    onExit(cb) {
      if (exited) cb(exited);
      else exitListeners.add(cb);
    },
    kill(signal = 'SIGTERM') {
      try {
        child.kill(signal as NodeJS.Signals);
      } catch {
        /* already dead */
      }
    },
  };
}
