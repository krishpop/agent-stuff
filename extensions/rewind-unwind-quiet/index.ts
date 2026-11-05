/**
 * pi-rewind-unwind, minus its `session_tree` handler.
 *
 * WHY
 * ---
 * pi-rewind-unwind restores files on disk when the session leaf moves, so a
 * `/tree` jump rolls back write/edit changes made on the branch you left. It
 * implements that in one `session_tree` handler that (a) asks "Untracked file
 * edits — overwrite them?", (b) asks "Restore files?", and (c) checks out the
 * captured snapshots.
 *
 * pi-context-tree's `/crop` moves the leaf too — `applyCropPlan` calls
 * `ctx.navigateTree(anchorId, { summarize: false })` before appending the
 * reconstruction block. That is the same event, so cropping a fat tool result
 * (a pure context-window operation, no file intent at all) pops the restore
 * prompt and offers to revert every edit made since the crop anchor.
 *
 * The two cannot be told apart at `session_tree` time. `event.fromExtension`
 * means "an extension supplied the branch summary", not "an extension drove
 * the navigation", and it is `undefined` for both `/tree` and `/crop`. The
 * `ctree/crop` marker entry that would identify a crop is appended *after*
 * `navigateTree` resolves, i.e. after this handler has already returned, so
 * waiting for it deadlocks the detection rather than fixing it.
 *
 * So the knob is behavioural, not a discriminator: drop the leaf-move file
 * restore entirely and keep the deliberate, model- and user-driven undo path.
 * `/undo`, the `undo_files` tool, and every write/edit capture are unaffected
 * — this only stops the disk from following the conversation around.
 *
 * Set PI_REWIND_UNWIND_TREE_RESTORE=1 to restore stock behaviour for a run.
 *
 * Implemented as a Proxy over the ExtensionAPI rather than a patch, so the
 * upstream package stays a plain pinned npm dependency and `npm update` here
 * is a version bump, not a rebase.
 */
import * as upstreamModule from 'pi-rewind-unwind/index.ts'

const SUPPRESSED = 'session_tree'

// Depending on how the host transpiles the upstream .ts, the extension factory
// arrives directly, under `.default`, or under `.default.default` (ESM shim
// over a CJS interop wrapper). Unwrap until it is callable instead of guessing.
function unwrapDefault(mod: unknown): (pi: unknown) => unknown {
  let cur: unknown = mod
  for (let i = 0; i < 3 && typeof cur !== 'function'; i++) {
    cur = (cur as { default?: unknown })?.default
  }
  if (typeof cur !== 'function') {
    throw new Error('pi-rewind-unwind: no callable default export found')
  }
  return cur as (pi: unknown) => unknown
}

const upstream = unwrapDefault(upstreamModule)

function treeRestoreEnabled(): boolean {
  const v = process.env.PI_REWIND_UNWIND_TREE_RESTORE
  return v === '1' || v === 'true'
}

export default function rewindUnwindQuiet(pi: any) {
  if (treeRestoreEnabled()) {
    return upstream(pi)
  }

  // Only `on` is intercepted; every other member is passed straight through,
  // so tool/command registration and appendEntry keep working unchanged.
  const shim = new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop !== 'on') {
        return Reflect.get(target, prop, receiver)
      }
      return (event: string, handler: unknown) => {
        if (event === SUPPRESSED) {
          return undefined
        }
        return (target.on as (e: string, h: unknown) => unknown)(event, handler)
      }
    }
  })

  return upstream(shim)
}
