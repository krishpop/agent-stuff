# debug/ — why is pi slow to start?

Tools for finding which extension, package, or state file is costing you
startup time, and for proving it before you change anything.

Ordered by how much you learn per minute spent.

| Step | Tool | Answers |
|---|---|---|
| 0 | `pi -ne -c` | Is it extensions at all? |
| 1 | `./bisect.sh` | *Which* extension, ranked by blocked time |
| 2 | `./state-probe.sh` | Is it that extension's SQLite file — and is it slow because of *where* it lives? |
| 3 | `./profile.sh -ne -e <ext>` | CPU or I/O, and which frames |
| 4 | `./session-forensics.sh` | Post-mortem on a session that already felt slow |
| 5 | `hookprobe.ts` | Permanent per-hook timing inside an extension you own |

Output goes to `$PI_DEBUG_OUT` (default `/tmp/pi-debug`). All of it is
read-only or copy-first; nothing mutates a live session or DB.

## 0. First, thirty seconds

```sh
pi -ne -c        # no extensions, resume the same session
```

Snappy without extensions and slow with them → it is an extension, and step 1
names it in one pass. Slow both ways → it is not an extension; look at the
model, the network, or the filesystem holding `~/.pi`.

## 1. Bisect

```sh
./bisect.sh                          # every extension, startup cost
./bisect.sh --workload               # make it call tools too
./bisect.sh --session <file.jsonl>   # replay a long session (finds O(n) bugs)
./bisect.sh dt tmux-pi               # just these
```

Runs pi with no extensions (floor), with each one alone, then with everything
(ceiling). Extensions are **discovered**, not hardcoded — local ones under
`~/.pi/agent/extensions`, npm ones from each package's `pi.extensions`.

Read the **blocked** column, not wall time. `lag-canary.ts` rides along in
every run and measures how long the event loop was stalled; that is what
freezes keystrokes. Wall time also contains model latency, which is noise.

Expect the floor to be ~1 s and a healthy extension to add ~0.1 s. One
extension at 20× the floor is the normal shape of this bug — it is rarely
death by a thousand cuts.

**Startup vs steady-state are different bugs.** A startup regression shows on
the first prompt. A steady-state one only appears after 20+ turns, and you
reproduce it with `--session` against a long session file. If cost grows with
session length, something is rescanning the whole conversation per tick.

## 2. Probe the state

```sh
./state-probe.sh                     # every *.sqlite under ~/.pi/agent
```

For each state DB: pragmas, row counts, who holds it open, stale journals, how
much is reclaimable bloat, and a commit-latency ladder by journal mode.

The column that matters is **"local copy"** — the identical file scanned on
local disk. A 10×+ gap means the problem is the *location*, not the code:
`$HOME` on a network filesystem (wekafs, NFS, Lustre) turns every SQLite page
fault into a round trip. Fix that before touching anything else.

Order of fixes, best value first:

1. **Move the DB off the network home** (local NVMe, `/tmp/$USER/…`, or
   `$XDG_RUNTIME_DIR`), and snapshot it back with `VACUUM INTO` if you need
   durability. Biggest win, zero correctness risk.
2. **Prune.** Append-only telemetry tables are usually 98% of the file.
3. **Stop writing per-token rows.** Coalesce and flush on `message_end`.
4. **Only then consider WAL** + `synchronous=NORMAL` (typically 13× on
   commits). WAL's `-shm` index can wedge into `"file is not a database"` on a
   shared home, so it is only safe *after* step 1.

Check that a journal-mode pragma actually took effect. Code that sets
`truncate` while the live file reports `delete` means the exclusive-lock
conversion never won, because long-lived sessions hold the file open.

## 3. Profile

```sh
./profile.sh -ne -e ~/.pi/agent/extensions/<name>
```

`strace -c` first: **futex** dominating means blocked on I/O, **fsync**
dominating means commit cost, CPU dominating means a real hot loop. Then a
`--cpu-prof` top-frames table. If sampled CPU is far below wall time, stop
looking for a slow function — the process was waiting.

Attach to an already-stalled session instead of relaunching:

```sh
pgrep -af 'dist/bundle/cli.js'
kill -USR1 <pid>          # inspector on 127.0.0.1:9229 → chrome://inspect
```

## 4. Post-mortem

```sh
./session-forensics.sh                 # biggest session for $PWD
./session-forensics.sh <session.jsonl>
```

Gaps, error surface, entry-type histogram. Interpretation: `message -> message`
gaps are the human thinking; `tool_result -> message` gaps are the agent
stalling. An entry type that dwarfs the rest is a recording bug.

## 5. Static screen (free, before you spend a bisection slot)

```sh
cd ~/dev/agent-stuff/extensions
grep -rn 'message_update\|tool_execution_update' */src   # per-chunk hooks
grep -rn 'setInterval' */src                              # pollers
grep -rn 'execSync\|readFileSync\|appendFileSync' */src   # sync I/O in a hook
grep -rln 'message_update' ~/.pi/agent/npm/node_modules/*/dist/*.js
```

Priors that keep being right:

- Terminal/shell extensions spawning a subprocess per hook — 50–200 ms each.
- Render-path extensions that are O(session length) per frame.
- Anything with a sub-30 s timer that touches disk.

## 6. Keep the instrumentation

Wire `hookprobe.ts` into extensions you own, gated on `PI_PERF=1`. Zero cost
off, instant answers on. Budgets worth asserting: no sync hook > 16 ms, no
per-chunk hook > 1 ms, no disk-touching timer under 30 s. Log the state path
and runtime on open, so you never profile the code branch that isn't running.

## Honesty rule

Every hypothesis in `case-pi-workflows/CASE.md` that came from reading code —
session-length scans, lock contention, poll churn, fragmentation — was wrong.
The one that came from measurement was right. Write down the killed hypotheses;
they are the most reusable part of an investigation.

## case-pi-workflows/

The worked example this folder came from: a 22 s startup traced to a 45 MB
`state.sqlite` on wekafs. `CASE.md` has the numbers and the killed hypotheses;
the scripts beside it are the one-off harnesses from that hunt (DB
relocate/prune maintenance, wedged-run isolation, fork↔upstream swap, capture
verification). Kept as a reference for the shape of the argument, not as tools.
