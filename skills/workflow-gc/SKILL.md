---
name: workflow-gc
description: Diagnose and fix any pi-workflows host or state problem, and archive abandoned generated *.workflow.ts plans. Use whenever a workflow will not start, run, or resume - "Workflow host is unavailable", "host did not become ready", connect ECONNREFUSED or ENOENT on host.sock, a run stuck queued/waiting with no steps for hours, "durable state is incompatible", after upgrading pi-workflows, or when the workflows dir is cluttered with dead plans. Start here before restarting pi or deleting anything by hand.
---

# workflow-gc

Four kinds of garbage accumulate around pi-workflows, and they fail differently.

**Triage order: `status` first, always.** It now distinguishes all three, and the top two
produce the *same* user-visible error. Guessing between them is how a working host gets
clobbered or a schema skew gets "fixed" five times in a row.

**Host garbage.** The host holds `host.lock.json` + a bound `host.sock`. If the process
dies without unwinding, the lock names a dead pid and the socket inode survives with
nothing listening. Every subsequent start fails, and the symptom is misleading: you get
`ECONNREFUSED` (stale inode present) rather than anything naming a lock.

**State garbage (the impostor).** `state.sqlite` written by a different schema than the
installed package. `StateDatabase.verifySchema()` runs *before* the socket is bound, so the
host throws and exits, and the client spawns it with `stdio:"ignore"` — the error is never
seen by anyone. All you get is `connect ENOENT`, which looks like host garbage but is not:
there is nothing to collect, `clean` and `verify` both report success, and the host still
refuses to start. Cleaning cannot fix it; only moving the database can.

**Plan garbage.** Every planning session that writes a `*.workflow.ts` leaves it in the
workflows dir forever. Some are live, some are orphans, and some are *stale duplicates of
a file you edited somewhere else* — which is how a run silently executes the wrong bytes.

**A lease held by another node (shared `$HOME` only).** Not garbage at all: a perfectly
healthy host, on a machine you are not sitting on. It also presents as `connect ENOENT`
with a CLEAN verdict — the *third* thing wearing that costume. See below.

Exit codes: 0 healthy/clean · 3 stale · 4 live-but-wedged · 5 schema skew · 6 remote lease.

Script: `workflow-gc.sh`, beside this file.
`GC=~/.pi/agent/skills/workflow-gc/workflow-gc.sh` (the skill dir symlinks into `~/dev/agent-stuff`).

## The safety model — read this before using `clean`

`host.lock.json` looks like:

```json
{"schema":"pi-workflows.host-lock.v1","pid":670752,
 "startIdentity":"linux-proc-start:99148740",
 "hostId":"host-4898404e-..."}
```

`startIdentity` is field 22 of `/proc/<pid>/stat` — the kernel's process start time.
**`kill -0 $pid` alone is not a liveness test.** After a reboot or pid wraparound an
unrelated process can hold that pid and look alive, and a GC that trusts pid-only will
either refuse forever or clobber a healthy host. The identity is what makes ownership
decidable:

| pid | startIdentity | verdict |
|---|---|---|
| absent | — | STALE |
| alive | differs | STALE (pid reuse) |
| alive | matches | **LIVE — never gc** |

The socket is judged independently, by connecting: `connect OK` = live listener;
`ECONNREFUSED` = stale inode blocking `bind()`; `ENOENT` = already gone.

The dangerous middle case is **live pid + dead socket**: the host is running but
unreachable. GC will not help, and `--force` there destroys a working host's lock.
`status` returns exit 4 and tells you to investigate that pid instead.

**Nothing is ever deleted.** Everything is renamed `<name>.stale-<ts>`; `restore` undoes
the most recent set.

## Host workflow

```bash
GC=~/.pi/agent/skills/workflow-gc/workflow-gc.sh
$GC status          # exit 0 healthy/clean · 3 stale · 4 live-but-wedged · 5 schema skew · 6 remote lease
$GC takeover        # DRY RUN; --apply moves the host to this node (cluster/shared-$HOME)
$GC clean           # renames stale lock+socket aside, then verifies
$GC verify          # proof: actually bind() a probe socket on the path, then unlink
$GC restore         # undo
$GC reset-state     # DRY RUN; --apply archives a schema-skewed db so the host can boot
```

`verify` is the check that the fix worked, and it is a real `bind()` — not an inference
from the files being gone. A path can still be unusable after cleanup.

### The host may not come back this session

Cleaning unblocks the *path*; it does not respawn the host. If the extension loaded
before its dependencies were installed, the bind happens at startup and cannot be
re-triggered from inside the running session. Expect the host on **next session start**.
Symptom that you are in this case: `clean` succeeds, `verify` says bind OK, and
`ECONNREFUSED` has become `ENOENT` — but no host appears. That is success, not failure.

## Schema skew (exit 5)

`status` compares `schema_meta.schema_digest` in `state.sqlite` against the installed
package's `STATE_SCHEMA_DIGEST` (`dist/state/schema.js`) — the exact field `verifySchema`
tests.

**Do not compare versions.** 0.16.0 still ships `STATE_APP_VERSION = "0.14.0"`, so both the
broken 0.14.0 database and a fresh 0.16.0 one report `app_version = 0.14.0`. A version check
reports a match across the precise upgrade that breaks the host. Only the digest moved
(`27923e72…` → `cbb39f7e…`).

```bash
$GC status              # -> VERDICT: SCHEMA SKEW, exit 5
$GC reset-state         # dry run: names the files it would move
$GC reset-state --apply # -> archive-<ts>-schemaskew/, then start a host
```

Skew outranks every lock verdict except a live-and-reachable host, because no amount of
cleaning makes a host boot against a database it will not open. `reset-state` refuses while
the host pid is alive, and refuses while any run is non-terminal (archiving strands them) —
finish or cancel those first.

The reset **loses all run history**; nothing is deleted, the trio is moved to
`archive-<ts>-schemaskew/`. Restoring it reinstates the crash loop unless you also downgrade
the package.

The host does not always respawn on its own. Start one directly:

```bash
P=~/.pi/agent/npm/node_modules/@osolmaz/pi-workflows
setsid nohup node $P/dist/host/host-entry.js --database ~/.pi/agent/workflows/state.sqlite \
  >/tmp/wfhost.log 2>&1 &   # expect: [pi-workflows host] ready on …/host.sock at epoch 1
```

Running that entry in the **foreground** is also the way to see any startup error the client
swallows — reach for it whenever the host is missing and `status` says nothing is wrong.

## Remote lease (exit 6) — shared `$HOME` across nodes

On a cluster every node resolves the same `~/.pi/agent/workflows`: **one** `state.sqlite`,
**one** `host.sock` path. A unix socket is machine-local no matter what the filesystem
shows, so a host on node A cannot serve node B — and node B cannot start its own, because
`acquireHost()` throws `A live Pi Workflows host already owns epoch N` while the 30s lease
in `workflow_host_state` keeps being renewed. On node B that surfaces as `connect ENOENT`
with a CLEAN lock verdict: identical to schema skew by eye, and `clean` fixes neither.

The lease row carries `pid` + `process_start_identity` but **no hostname**, so "remote" and
"simply dead" are indistinguishable. That does not matter. The question is not *where does
it live* but *is it usable from here*, and the socket probe already answers that.

```bash
$GC status            # -> VERDICT: REMOTE LEASE, exit 6
$GC takeover          # dry run: prints the three steps
$GC takeover --apply  # -> TAKEOVER OK — host reachable on this node after 1s
```

Takeover is three steps because the other two blockers are self-clearing:

| artifact | why it does not block a new node |
|---|---|
| `host.lock.json` | `acquireHostLock()` judges pid + start identity **locally**, so another node's lock reads as stale and is rewritten |
| `host.sock` | `Runner.listen()` does `fs.rmSync(socketPath)` before `bind()` — which is also why an evicted host ends up listening on an unlinked inode, visible nowhere |
| **the lease** | the only real blocker. `renewHost()` matches on `expires_at > now`; set it to 0 and the holder's next heartbeat throws, the runner catches `host claim lost` and calls `stop()` on itself |

Eviction is **cooperative** — nothing signals another machine's process. Two guards:

- lease holder alive **on this node** with a matching start identity → exit 4, refuse. A
  local host with a dead socket is a real bug; stealing its lease hides it.
- any non-terminal run → refuse. Those belong to the holder and its workers are orphaned
  by the epoch bump. `--force` overrides.

### Shared storage

SQLite WAL is not supported on network filesystems. Give each node its own
local database; a lease is not a substitute for filesystem coherence.

## Workflow-file workflow

```bash
$GC list                       # read-only classification
$GC archive                    # DRY RUN by default — shows what would move
$GC archive --apply            # move into archive-<ts>/ beside the originals
$GC archive --apply gauntlet   # substring filter
```

Classification rules:

- **PROTECTED** — the file has a run whose status is outside
  `completed/failed/cancelled/timed_out`. Archiving it strands the run's `workflow_ref`.
  Never archived, not even with a name filter.
- **ARCHIVABLE** — all runs terminal, or no runs recorded (orphan).
- **`!! DIVERGED`** — the same basename exists elsewhere with different bytes. Do not
  archive on autopilot; work out which copy the runs actually reference first.

Symlinks are reported as `symlink -> <target>` and **never followed**. These usually point
into version-controlled notes; moving the link is safe, and the target is never touched.

Archived files land in `archive-<ts>/`, matching the `archive-*` convention already used
in that directory. Restore is a plain `mv` back, printed at the end of every run.

## Rules

- Never `--force` to make an error go away. Diagnose `status` first; exit 4 means the
  problem is not the lock, exit 5 means the problem is not the socket, exit 6 means the
  problem is not on this machine.
- Never reach for `takeover` on a single-machine setup. There, a held lease with a dead
  socket is a bug worth reading, not a lease worth stealing.
- `ENOENT` with a CLEAN verdict is the schema-skew signature. Check `state`, do not clean
  in a loop.
- Never restore an archived skewed database into a newer package. Downgrade first or leave
  it archived.
- Never archive a PROTECTED file by editing the script's filter. Cancel or finish the run.
- Never resolve a DIVERGED pair by deleting one side before checking which the runs use.
- `state.sqlite`, `host/`, and existing `archive-*` dirs are out of scope and untouched.
