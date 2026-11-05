import { executePtyCommand } from './pty-execute.ts';
import { resolveShell } from './shell.ts';
import { isPtyBackendAvailable } from './pty-backend.ts';

type Case = [name: string, cmd: string, check: (t: string) => boolean];
const CASES: Case[] = [
  ['echo',        'echo PTY_WORKS',                                    (t) => t.includes('PTY_WORKS')],
  ['is a tty',    'tty',                                               (t) => /\/dev\/(pts\/\d+|ttys\d+)/.test(t)],
  ['isatty(1)',   '[ -t 1 ] && echo IS_TTY || echo NOT_TTY',           (t) => t.includes('IS_TTY')],
  ['TERM',        'echo TERM=$TERM',                                   (t) => t.includes('TERM=xterm-256color')],
  ['shell is bash','echo BV=$BASH_VERSION',                             (t) => /BV=\d+\./.test(t)],
  ['multiline',   'for i in 1 2 3; do echo line$i; done',              (t) => t.includes('line1') && t.includes('line3')],
  ['stderr',      'echo oops >&2',                                     (t) => t.includes('oops')],
  ['real work',   'sleep 0.3; echo AFTER_SLEEP',                       (t) => t.includes('AFTER_SLEEP')],
  ['side effect', 'echo yes > /tmp/pty_se.txt; echo WROTE',            (t) => t.includes('WROTE')],
  ['cols',        'stty size',                                         (t) => t.includes('100')],
  ['ansi colour', 'printf "\\033[31mRED\\033[0m\\n"',                  (t) => t.includes('RED')],
];

export default async function (_pi: unknown) {
  console.error(`BACKEND available=${isPtyBackendAvailable()} shell=${JSON.stringify(resolveShell())}`);
  const ctx = { cwd: '/tmp', hasUI: false } as any;
  let pass = 0, fail = 0;
  for (const [name, cmd, check] of CASES) {
    try {
      const r = await executePtyCommand(`t-${name}`, { command: cmd }, new AbortController().signal, ctx);
      const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
      const ok = check(text);
      ok ? pass++ : fail++;
      console.error(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(12)} => ${JSON.stringify(text.slice(0, 70))}`);
    } catch (e: any) {
      fail++;
      console.error(`FAIL  ${name.padEnd(12)} => THREW ${JSON.stringify(String(e.message).slice(0, 90))}`);
    }
  }
  // non-zero exit must throw
  try {
    await executePtyCommand('t-exit', { command: 'echo before_fail; exit 3' }, new AbortController().signal, ctx);
    fail++; console.error('FAIL  nonzero exit  => did not throw');
  } catch (e: any) {
    const ok = /code 3/.test(e.message) && e.message.includes('before_fail');
    ok ? pass++ : fail++;
    console.error(`${ok ? 'ok  ' : 'FAIL'}  nonzero exit => ${JSON.stringify(String(e.message).slice(0, 70))}`);
  }
  // timeout must throw
  try {
    await executePtyCommand('t-to', { command: 'echo starting; sleep 10', timeout: 1 }, new AbortController().signal, ctx);
    fail++; console.error('FAIL  timeout      => did not throw');
  } catch (e: any) {
    const ok = /timed out after 1 seconds/.test(e.message);
    ok ? pass++ : fail++;
    console.error(`${ok ? 'ok  ' : 'FAIL'}  timeout      => ${JSON.stringify(String(e.message).slice(0, 70))}`);
  }
  // abort must throw promptly
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    try {
      await executePtyCommand('t-ab', { command: 'echo running; sleep 10' }, ac.signal, ctx);
      fail++; console.error('FAIL  abort        => did not throw');
    } catch (e: any) {
      const dt = Date.now() - t0;
      const ok = /aborted/.test(e.message) && dt < 3000;
      ok ? pass++ : fail++;
      console.error(`${ok ? 'ok  ' : 'FAIL'}  abort        => ${dt}ms ${JSON.stringify(String(e.message).slice(0, 50))}`);
    }
  }
  console.error(`PTYTEST ${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
}
