---
name: debug-pi
description: >-
  Debug the pi agent itself — slow or hanging startup, a laggy TUI, an extension that won't load, a workflow run that never starts or silently loops — and manage what pi has installed: add/remove/pin packages, symlink a local fork, re-download or update a package, and get the change loaded into a new session. Use when the user says "/debug-pi", "pi is slow", "pi takes forever to start", "the TUI is laggy", "which extension is slow", "my extension isn't loading", "reinstall/update a pi package", "relink my fork", "why didn't my extension change take effect", "the workflow is stuck", "the workflow never started", or "the run is queued forever".
---

# debug-pi

Two jobs: **find out why pi is slow or broken**, and **change what pi loads**.

Repo: `~/dev/agent-stuff` (`$AS` below). Tools: `$AS/debug/`. If that checkout
is missing, everything here still works except the scripts.

```sh
AS=~/dev/agent-stuff
```

---

## Part 1 — startup is slow or the TUI hangs

Follow the order. Each step is cheap and eliminates a whole class.

### 1. Is it extensions at all? (30 s)

```sh
pi -ne -c        # -ne = no extension discovery; resume the same session
```

Fast without, slow with → extension. Slow both ways → not an extension: check
the model, the network, or the filesystem under `~/.pi` (see step 3).

### 2. Which one?

```sh
$AS/debug/bisect.sh                        # all, startup cost
$AS/debug/bisect.sh --workload             # include tool calls
$AS/debug/bisect.sh --session <file.jsonl> # replay a long session
$AS/debug/bisect.sh dt tmux-pi             # only these
```

Read the **blocked** column, not wall time — blocked is event-loop stall, which
is what freezes keystrokes; wall time also contains model latency. Floor is
~1 s; a healthy extension adds ~0.1 s. Expect one bad actor, not many.

Startup and steady-state are different bugs. If cost grows with `--session`
length, something rescans the conversation every tick.

### 3. Is it a state file, and is it slow because of *where* it lives?

```sh
$AS/debug/state-probe.sh
```

Compare the "in place" and "local copy" columns. A 10×+ gap means the fix is
the location: `$HOME` on wekafs/NFS/Lustre makes every SQLite page fault a
network round trip. Move the DB to local disk first; only then consider WAL
(its `-shm` index can wedge on a shared home).

Also flags stale `-journal` files (a writer died mid-transaction) and how much
of the file is reclaimable bloat versus live rows.

### 4. CPU or I/O, and which frames?

```sh
$AS/debug/profile.sh -ne -e ~/.pi/agent/extensions/<name>
```

`futex` dominating = blocked on I/O. `fsync` dominating = commit cost. CPU
dominating = a real hot loop. Sampled CPU far below wall time means stop
looking for a slow function.

### 5. After the fact

```sh
$AS/debug/session-forensics.sh          # biggest session for $PWD
```

`message -> message` gaps are the human thinking. `tool_result -> message` gaps
are the agent stalling.

### 6. Instrument an extension you own

Wire `$AS/debug/hookprobe.ts` into it, gated on `PI_PERF=1`. Budgets: no sync
hook > 16 ms, no per-chunk (`message_update`, `tool_execution_update`) hook
> 1 ms, no disk-touching timer under 30 s.

### Write down what you disproved

In the worked case (`$AS/debug/case-pi-workflows/CASE.md`) every hypothesis
from reading code was wrong and the measured one was right. Record the killed
hypotheses — they are the reusable part.

---

## Part 1b — a workflow run is "stuck"

**A queued pi-workflows run is not idle. It is usually crash-looping.** When the worker dies
during bootstrap the run stays `status: queued` with `consecutive_errors: 0`, and the host
re-claims the lease every ~2 s forever. Nothing appears in any log — the host's stderr is
`/dev/null`. Measured 2026-09-01: **3,983 park/claim cycles in 130 minutes**, invisible.

### Always verify a start. Never fire-and-forget.

```sh
$AS/debug/workflow-run-probe.sh                 # newest run
$AS/debug/workflow-run-probe.sh <id> --wait 90  # poll until initialized, else fail
```

Exit 0 healthy · 1 park-loop or failed (prints the error) · 2 never started.
**Run this within a minute of every `workflow start`.** A start that returns a run id has proved
nothing except that a row was written.

### Reading it by hand

```sh
DB=~/.pi/agent/workflows/state.sqlite
sqlite3 -header -column $DB "select run_id,status from run_queue order by rowid desc limit 5;"
sqlite3 -header -column $DB "select event_type,count(*) from events e join runs r
  on r.resource_id=e.resource_id where r.run_id like '%<id>%' group by 1;"
```

| Event mix | Meaning |
|---|---|
| only `lease.claimed` / `run.queue_running` / `run.queue_parked`, repeating | worker dies in bootstrap — **never initialized** |
| `run_initialized` + `run_started` present | it really did start; look at nodes |
| `node_failed` then `run_failed` | read the payload, below |

```sh
# the actual error, which exists nowhere else
sqlite3 $DB "select cast(b.content as text) from events e join blobs b on b.blob_hash=e.payload_hash
  join runs r on r.resource_id=e.resource_id where r.run_id like '%<id>%'
  and e.event_type in ('node_failed','run_failed') order by e.event_seq desc limit 2;"
```

### The input is a JSON STRING, not an object

The `workflow` tool serializes `input` before it reaches the store. Both failures seen so far are
this one bug wearing two hats:

```sh
sqlite3 $DB "select cast(b.content as text) from runs r join blobs b
  on b.blob_hash=r.input_hash where r.run_id='<id>';" | head -c 120
# starts with  "{\"task\":...   -> a STRING. Object would start with {"task":
```

1. **Bootstrap death.** `parseInput` calls an `asRecord`-style guard, which throws
   `input must be an object` → worker exits ~350 ms in → park loop.
   **Fix at the root**, inside `parseInput`, because every entry point routes through it:
   `const raw = typeof value === "string" ? JSON.parse(value) : value;`
2. **Death on the *second* node.** Node bodies that write `input as GauntletInput` do a
   compile-time **cast, not a runtime parse**. The hosted runner hands the raw value to nodes
   after the first, so `input.slices` is `undefined` and the prompt builder dies on
   `Cannot read properties of undefined (reading 'length')`.
   **Fix: call `parseInput(input)` at every call site.** Never cast.

Reproduce either without touching the host — this is the fastest loop there is:

```sh
cd /tmp && NODE_PATH=~/.pi/agent/npm/node_modules node \
  --import ~/.local/lib/node_modules/tsx/dist/loader.mjs -e "
import('~/.pi/agent/workflows/<wf>.workflow.ts').then(m=>{
  const w=m.default?.default??m.default;               // NOTE the double default
  const raw=require('fs').readFileSync('/tmp/in.json','utf8');
  for (const n of Object.keys(w.nodes)) {
    const node=w.nodes[n];
    try{ node.run?node.run({input:raw,outputs:{}}):node.prompt({input:raw,outputs:{}}); console.log(n,'OK'); }
    catch(e){ console.log(n,'THROWS:',e.message); }
  }});"
```

`m.default?.default ?? m.default` matters: under tsx the namespace is double-wrapped, and reading
`m.default` alone yields `{nodes: undefined}` — which fakes a *convincing* "the definition is
broken" result. That false lead cost a full diagnosis cycle.

### Also true, and separate

- `workflow start` **does not validate the graph the way the worker does**. A definition that
  starts fine can still be rejected later. Validate up front:
  `validateWorkflowDefinition(w)` from `@osolmaz/pi-workflows/src/workflows/graph.ts`.
- Unreachable nodes are a **hard** error (`Workflow has unreachable nodes: …`). Moving `startAt`
  past early nodes orphans them. Gate them behind a flag rather than deleting:
  `...(GATE_FIRST ? { a: …, b: … } : {})` in `nodes`, and the matching spread in `edges`.
- A park loop writes thousands of rows into `state.sqlite`. Cancel promptly, and run the
  `workflow-gc` skill afterwards when nothing is live.

---

## Part 2 — an extension fails to load

Symptoms and causes, most common first:

| Symptom | Cause |
|---|---|
| `Tool "X" conflicts with …` | Two packages register the same tool name. pi ≥ 0.84 hard-fails at startup. Remove one, or fork it to rename the tool |
| `ERR_MODULE_NOT_FOUND: @earendil-works/pi-coding-agent` | The package resolves the pi runtime from its own tree. Symlink the global install into `~/.pi/agent/npm/node_modules/@earendil-works/` — `install.sh` does this |
| Two copies of the pi runtime in-process | The package depends on the pre-rename `@mariozechner/*` scope. Fork and re-scope, or `omit=peer` in the fork's `.npmrc` |
| Skill or command silently missing | Name collision — pi keeps the first of a colliding pair and warns |
| The extension loads but its change didn't apply | You edited a different copy. See "which copy is live" below |

Isolate one extension away from all the others:

```sh
pi -ne -e /path/to/extension            # only this one
pi -ne                                  # none
```

---

## Part 3 — where pi keeps things

| Path | What |
|---|---|
| `~/.pi/agent/settings.json` | The load list. `packages: [...]`, each a string or `{source, extensions: []}` |
| `~/.pi/agent/npm/node_modules/` | Installed npm packages |
| `~/.pi/agent/extensions/<name>` | Local/forked extensions — symlinks into `$AS/extensions/` |
| `~/.pi/agent/skills/<name>` | Auto-discovered skills — symlinks into `$AS/skills/` |
| `~/.pi/agent/prompts/*.md` | Auto-discovered prompt templates |
| `~/.pi/agent/sessions/--<path>--/` | Session JSONL, one per session |
| `~/.pi/agent/*/state.sqlite` | Per-extension state |
| `$AS/pi-packages.txt` | The pinned manifest — the source of truth, not settings.json |

Skills and prompts are **auto-discovered**; they need no settings.json entry.
That is deliberate: it keeps an absolute `$HOME` path out of a checked-in
settings file.

**Which copy is live?** A package installed from npm *and* present as a local
fork will bite you. Check both:

```sh
pi list
ls -la ~/.pi/agent/extensions/           # symlink targets
grep -o '"source": *"[^"]*"' ~/.pi/agent/settings.json
```

---

## Part 4 — changing what pi loads

**The manifest is the source of truth.** Install ad hoc, then capture it:

```sh
pi install npm:some-pkg@1.2.3      # or: pi update --all
cd $AS && ./update-manifest.sh     # rewrites pi-packages.txt from what's installed
git commit -am "bump some-pkg"
```

Converge a machine to the manifest (idempotent, safe to re-run):

```sh
$AS/install.sh              # everything
$AS/install.sh --forks      # only extensions/  (npm install + symlink + pi install)
$AS/install.sh --skills     # only relink skills/
$AS/install.sh --prompts    # only relink prompts/
$AS/install.sh --patches    # re-apply patches/ to installed npm packages
```

Manifest line prefixes (`pi-packages.txt`):

| Prefix | Effect |
|---|---|
| *(none)* | `pi install <source>` |
| `@no-extensions ` | Install it, but force `extensions: []` in settings.json — skills/prompts/CLI still load. Re-applied *after* each install, because `pi install` rewrites the entry back to a plain string |
| `@remove ` | Uninstall if present (renamed packages whose old copy collides on a tool name) |
| `@darwin ` | macOS only |

Turn one extension off without uninstalling:

- Package: add `@no-extensions` to its manifest line, rerun `install.sh`.
- Local fork: `touch $AS/extensions/<name>/.disabled`, rerun `install.sh --forks`.
  For a submodule fork, add the name to `DISABLED_FORKS` in `install.sh` instead —
  an untracked `.disabled` file inside a submodule would not propagate to other hosts.
- Just for one run: `pi -ne -e <the ones you want>`.

### Re-download / repair a package

```sh
pi remove npm:some-pkg
rm -rf ~/.pi/agent/npm/node_modules/some-pkg
pi install npm:some-pkg@1.2.3
$AS/install.sh --patches           # patches/ are wiped by any reinstall
```

`pi install` re-extracts `node_modules`, so **anything you patched by hand is
gone after every install**. That is what `patches/*.sh` are for — each is
idempotent and refuses to write when upstream source no longer matches.

### Add a local fork

```sh
mkdir -p $AS/extensions/<name>            # package.json with a `pi.extensions` entry
$AS/install.sh --forks
```

`install.sh` runs `npm install` in the fork, symlinks it into
`~/.pi/agent/extensions/<name>`, and installs *through that path* so
settings.json records the portable relative `extensions/<name>` rather than an
absolute `$HOME` path.

Pin deps to exact versions in the fork's `package.json` and leave lockfiles
gitignored — a committed `package-lock.json` bakes in `resolved` URLs for
whichever registry you were on, which breaks the repo off-network.

### Getting a change loaded

| Changed | To load it |
|---|---|
| Fork source (`extensions/<name>/**`) | **Start a new pi session.** The symlink means no reinstall |
| Fork deps or a new fork | `install.sh --forks`, then a new session |
| Skill body (`skills/<name>/SKILL.md`) | New session |
| New or renamed skill | `install.sh --skills`, then a new session |
| Prompt template | New session (`install.sh --prompts` if new/renamed) |
| `pi-packages.txt` | `install.sh`, then a new session |
| `settings.json` | New session |

There is no hot reload. A running session holds the extensions it loaded at
start — that is the single most common reason "my change did nothing".

Verify before you trust it:

```sh
pi list                                    # what pi thinks is installed
pi -ne -e <path> -p "say ok"               # does this one load at all
$AS/debug/bisect.sh <name>                 # and what does it cost
```

Forks in this repo ship a `selftest.ts` run through pi's own runtime:

```sh
pi -e $AS/extensions/<name>/selftest.ts -p x
```

---

## Don't

- Don't hand-edit `settings.json` as a fix — `pi install` and `install.sh`
  rewrite it. Change `pi-packages.txt` and converge.
- Don't delete anything under `~/.pi/agent/sessions/` — it is the only record
  of a session.
- Don't move or prune a live `state.sqlite` while a session holds it open.
  `workflow-db-maint.sh` is dry-run by default for that reason.
