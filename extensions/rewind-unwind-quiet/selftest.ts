/**
 * npx tsx selftest.ts
 *
 * Fails if the shim drops the wrong thing: `session_tree` must be gone, and
 * every other handler plus the `undo_files` tool and `/undo` command must
 * survive. Stubs the pi peer deps (.npmrc omits them on purpose — a second
 * copy of the pi runtime in-process breaks the extension at load).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STUB = '/tmp/rewind-unwind-quiet-stub/node_modules'
const anyProxy = 'const t=new Proxy(function(){},{get:()=>t,apply:()=>t,construct:()=>t});module.exports=new Proxy({},{get:()=>t});\n'
const stubs: Array<[string, string]> = [
  ['@earendil-works/pi-coding-agent', 'exports.isToolCallEventType = (n, e) => e && e.toolName === n;\n'],
  ['@earendil-works/pi-tui', anyProxy],
  ['typebox', anyProxy]
]
for (const [name, body] of stubs) {
  const dir = join(STUB, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), body)
}
if (!process.env.NODE_PATH?.includes(STUB)) {
  console.error(`re-run with: NODE_PATH=${STUB} npx tsx selftest.ts`)
  process.exit(2)
}

const mod = (await import('./index.ts')).default
const events: string[] = []
const tools: string[] = []
const commands: string[] = []
mod({
  on: (e: string) => { events.push(e) },
  registerTool: (t: { name?: string }) => tools.push(t?.name ?? 'tool'),
  registerCommand: (c: unknown) => commands.push(typeof c === 'string' ? c : ((c as { name?: string })?.name ?? 'cmd')),
  appendEntry: () => {}
})

const restoreOn = process.env.PI_REWIND_UNWIND_TREE_RESTORE
const fail = (msg: string) => { console.error('FAIL:', msg); process.exit(1) }
console.log('events:', events.join(','), '| tools:', tools.join(','), '| commands:', commands.join(','))
if (restoreOn) {
  if (!events.includes('session_tree')) fail('PI_REWIND_UNWIND_TREE_RESTORE set but session_tree was still suppressed')
} else if (events.includes('session_tree')) {
  fail('session_tree still registered — the /crop prompt will still fire')
}
for (const e of ['session_start', 'tool_call', 'tool_result', 'session_shutdown']) {
  if (!events.includes(e)) fail(`lost handler ${e}`)
}
if (!tools.includes('undo_files')) fail('undo_files tool missing')
if (!commands.includes('undo')) fail('/undo command missing')
console.log('PASS')
