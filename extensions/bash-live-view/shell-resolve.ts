// Pure shell-resolution logic. Deliberately free of any pi / node-native imports
// so it can be exercised directly by selftest.ts.

export type ResolvedShell = { shell: string; args: string[]; source: string };

export type ResolveShellDeps = {
  exists: (p: string) => boolean;
  piShell: () => { shell: string; args?: string[] } | undefined;
  onPath: () => string | undefined;
  env: Record<string, string | undefined>;
};

/**
 * Candidate bash locations, most-preferred first.
 *
 * /usr/bin/bash leads deliberately: upstream pi's getShellConfig() hardcodes a
 * /bin/bash existence probe first, which breaks on images that ship bash only at
 * /usr/bin/bash with no /bin -> /usr/bin merge.
 */
export const BASH_CANDIDATES = ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash'];

/**
 * Order:
 *   1. PI_BASH_LIVE_VIEW_SHELL override (testing / explicit opt-out)
 *   2. pi's getShellConfig() -- only if the path actually exists, so we stay
 *      consistent with the built-in `bash` tool and honour settings.shellPath
 *   3. Known bash locations, /usr/bin/bash first
 *   4. bash discovered on PATH
 *   5. sh
 */
export function resolveShellWith(deps: ResolveShellDeps): ResolvedShell {
  const override = deps.env.PI_BASH_LIVE_VIEW_SHELL;
  if (override) return { shell: override, args: ['-c'], source: 'env:PI_BASH_LIVE_VIEW_SHELL' };

  try {
    const cfg = deps.piShell();
    // Trust pi's answer only when it points at something real. Upstream can hand
    // back a stale /bin/bash on images where that path does not exist.
    if (cfg?.shell && deps.exists(cfg.shell)) {
      return { shell: cfg.shell, args: cfg.args ?? ['-c'], source: 'pi:getShellConfig' };
    }
  } catch {
    // getShellConfig throws when settings.shellPath is set but missing.
  }

  for (const candidate of BASH_CANDIDATES) {
    if (deps.exists(candidate)) return { shell: candidate, args: ['-c'], source: 'candidate' };
  }

  const found = deps.onPath();
  if (found) return { shell: found, args: ['-c'], source: 'which:bash' };

  return { shell: 'sh', args: ['-c'], source: 'fallback:sh' };
}
