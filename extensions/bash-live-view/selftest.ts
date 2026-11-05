import { resolveShellWith } from './shell-resolve.ts';
import { resolveShell } from './shell.ts';
import { scriptArgs } from './pty-backend.ts';

const NO_PATH = () => undefined;
const THROWS = () => { throw new Error('Custom shell path not found'); };

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.error(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

export default function (_pi: unknown) {
  check('env override wins',
    resolveShellWith({ env: { PI_BASH_LIVE_VIEW_SHELL: '/opt/weird/bash' }, exists: () => true, piShell: () => ({ shell: '/bin/bash' }), onPath: NO_PATH }),
    { shell: '/opt/weird/bash', args: ['-c'], source: 'env:PI_BASH_LIVE_VIEW_SHELL' });

  check("honours pi's shell when it exists",
    resolveShellWith({ env: {}, exists: (p) => p === '/bin/bash', piShell: () => ({ shell: '/bin/bash', args: ['-c'] }), onPath: NO_PATH }),
    { shell: '/bin/bash', args: ['-c'], source: 'pi:getShellConfig' });

  check('THE BUG: pi says /bin/bash but it is absent -> /usr/bin/bash',
    resolveShellWith({ env: {}, exists: (p) => p === '/usr/bin/bash', piShell: () => ({ shell: '/bin/bash', args: ['-c'] }), onPath: NO_PATH }),
    { shell: '/usr/bin/bash', args: ['-c'], source: 'candidate' });

  check('bad settings.shellPath (throws) -> /usr/bin/bash',
    resolveShellWith({ env: {}, exists: (p) => p === '/usr/bin/bash', piShell: THROWS, onPath: NO_PATH }),
    { shell: '/usr/bin/bash', args: ['-c'], source: 'candidate' });

  check('prefers /usr/bin/bash over /bin/bash when both exist and pi is unusable',
    resolveShellWith({ env: {}, exists: () => true, piShell: THROWS, onPath: NO_PATH }),
    { shell: '/usr/bin/bash', args: ['-c'], source: 'candidate' });

  check('no candidates -> PATH lookup',
    resolveShellWith({ env: {}, exists: () => false, piShell: THROWS, onPath: () => '/weird/bin/bash' }),
    { shell: '/weird/bin/bash', args: ['-c'], source: 'which:bash' });

  check('nothing found -> sh',
    resolveShellWith({ env: {}, exists: () => false, piShell: THROWS, onPath: NO_PATH }),
    { shell: 'sh', args: ['-c'], source: 'fallback:sh' });

  check('linux script -qec',
    scriptArgs('linux', '/bin/bash', ['-c'], 'echo hi'),
    ['-qec', 'echo hi', '/dev/null']);
  check('bsd script file+cmd',
    scriptArgs('darwin', '/bin/bash', ['-c'], 'echo hi'),
    ['-q', '/dev/null', '/bin/bash', '-c', 'echo hi']);

  console.error(`LIVE resolveShell() -> ${JSON.stringify(resolveShell())}`);
  console.error(`SELFTEST ${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
}
