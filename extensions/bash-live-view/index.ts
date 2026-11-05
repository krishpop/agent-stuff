import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { executePtyCommand } from './pty-execute.ts';
import { resolveShell } from './shell.ts';
import { isPtyBackendAvailable, ptyBackendUnavailableMessage } from './pty-backend.ts';

export const TOOL_NAME = 'bash_pty';

const bashPtyParams = Type.Object({
  command: Type.String({ description: 'Command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds' })),
});

const DESCRIPTION = [
  'Run a shell command inside a PTY with a live terminal widget the user can watch while it runs.',
  'Use this instead of `bash` when the program emits interesting ANSI/progress output',
  '(build systems, test runners, installers, long-running tasks with spinners or progress bars),',
  'or when a program needs to believe it is attached to a TTY.',
  'For ordinary, fast, non-interactive commands prefer the regular `bash` tool.',
].join(' ');

async function runSlashCommand(args: string, ctx: ExtensionCommandContext) {
  const command = args.trim();
  if (!command) {
    ctx.ui.notify('Usage: /bash-pty <command>', 'error');
    return;
  }
  const result = await executePtyCommand(
    `slash-${Date.now()}`,
    { command },
    new AbortController().signal,
    ctx as unknown as ExtensionContext,
  );
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '(no output)';
  ctx.ui.notify(text.slice(0, 4000), 'info');
}

export default function bashLiveView(pi: ExtensionAPI) {
  // Registered under a dedicated name rather than overriding `bash`, so this
  // coexists with extensions that decorate the built-in bash tool
  // (e.g. @mobrienv/pi-tidy-tools). Overriding `bash` is a hard startup error
  // in pi >= 0.84: `Tool "bash" conflicts with ...`.
  pi.registerTool({
    name: TOOL_NAME,
    label: 'bash (pty)',
    description: DESCRIPTION,
    parameters: bashPtyParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!isPtyBackendAvailable()) throw new Error(ptyBackendUnavailableMessage());
      return executePtyCommand(toolCallId, params, signal, ctx);
    },
  });

  pi.registerCommand('bash-pty', {
    description: 'Run a command through the PTY-backed shell',
    handler: async (args, ctx) => {
      await runSlashCommand(args, ctx);
    },
  });

  pi.registerCommand('bash-pty-shell', {
    description: 'Show which shell the PTY live view resolves to',
    handler: async (_args, ctx) => {
      const r = resolveShell();
      const backend = isPtyBackendAvailable() ? 'script(1) available' : 'UNAVAILABLE - ' + ptyBackendUnavailableMessage();
      ctx.ui.notify(`bash_pty shell: ${r.shell} ${JSON.stringify(r.args)} (via ${r.source})\nbackend: ${backend}`, 'info');
    },
  });
}
