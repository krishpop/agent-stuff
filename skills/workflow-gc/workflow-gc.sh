#!/usr/bin/env bash
# workflow-gc — reclaim a pi-workflows host wedged behind a stale lock/socket.
#
# Safety model (this is the whole point of the script):
#   host.lock.json carries {pid, startIdentity} where startIdentity is
#   "linux-proc-start:<field 22 of /proc/<pid>/stat>" — the kernel's process start
#   time. Checking `kill -0 $pid` ALONE IS NOT ENOUGH: after a reboot or PID
#   wraparound some unrelated process can hold that pid and look alive. The start
#   identity is what makes "is this MY host" decidable.
#
#     pid absent                          -> STALE
#     pid alive, startIdentity differs    -> STALE (pid reuse)
#     pid alive, startIdentity matches    -> LIVE. Refuse. Never GC.
#
#   The socket is judged independently by connecting:
#     connect OK                          -> LIVE listener
#     ECONNREFUSED                        -> stale inode, nothing bound; blocks bind()
#     ENOENT                              -> already gone
#
# Nothing is deleted. Everything is renamed to <name>.stale-<timestamp> so a wrong
# call is recoverable. `restore` puts the most recent set back.
#
# Usage:
#   workflow-gc.sh status              # read-only diagnosis, exit 0 clean / 3 stale / 4 live-wedged / 5 schema skew / 6 remote lease
#   workflow-gc.sh takeover [--apply]  # shared $HOME, other node holds the lease -> move the host here
#   workflow-gc.sh clean [--force]     # rename stale lock+socket aside
#   workflow-gc.sh reset-state [--apply]  # archive a schema-skewed state.sqlite so the host can boot
#   workflow-gc.sh verify              # can a fresh host bind? (binds a probe socket, unlinks it)
#   workflow-gc.sh restore             # undo the most recent clean
#   workflow-gc.sh list                # classify generated *.workflow.ts (read-only)
#   workflow-gc.sh archive [--apply] [name...]  # move dead workflow files into archive-<ts>/
#   HOST_DIR=... to override (default ~/.pi/agent/workflows/host)
set -uo pipefail

HOST_DIR="${HOST_DIR:-$HOME/.pi/agent/workflows/host}"
WF_DIR="${WF_DIR:-$(dirname "$HOST_DIR")}"
STATE_DB="$WF_DIR/state.sqlite"
LOCK="$HOST_DIR/host.lock.json"
SOCK="$HOST_DIR/host.sock"
KIDS="$HOST_DIR/host.children.json"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }

# ---- durable-state compatibility -> STATE_STATE {ok,skew,none,unreadable}
#
# The host calls StateDatabase.verifySchema() BEFORE it binds the socket. On a mismatch it
# throws and exits, and the client spawns it with stdio:"ignore" — so the only symptom you
# ever see is `connect ENOENT`, which looks exactly like ordinary host garbage but is not:
# there is nothing to collect, and `clean`/`verify` both report success while the host still
# refuses to start.
#
# Compare schema_meta.schema_digest against the installed package's STATE_SCHEMA_DIGEST.
# NOT app_version: 0.16.0 still ships STATE_APP_VERSION "0.14.0", so a version compare
# reports a match across the exact upgrade that breaks the host. The digest is the field
# verifySchema actually tests.
PKG_DIR="${PKG_DIR:-$HOME/.pi/agent/npm/node_modules/@osolmaz/pi-workflows}"

# The host entry moved dist/host/host-entry.js -> dist/server/server-entry.js in 0.16.x.
# Resolve it instead of hardcoding: a wrong path fails as MODULE_NOT_FOUND *after* the
# lease is already expired, which looks like "takeover broke it".
host_entry() {
  local c
  for c in "$PKG_DIR/dist/server/server-entry.js" "$PKG_DIR/dist/host/host-entry.js"; do
    [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  printf '%s' "$PKG_DIR/dist/server/server-entry.js"   # best guess, for message text
}
inspect_state() {
  STATE_STATE=none; STATE_DETAIL="no state.sqlite"; DB_DIGEST=""; PKG_DIGEST=""
  [ -f "$STATE_DB" ] || return 0
  DB_DIGEST=$(python3 - "$STATE_DB" <<'PY'
import sqlite3,sys
try:
    c=sqlite3.connect("file:%s?mode=ro"%sys.argv[1],uri=True)
    print(c.execute("select lower(hex(schema_digest)) from schema_meta").fetchone()[0])
except Exception as e:
    print("ERR:%s"%e)
PY
)
  if [ ! -d "$PKG_DIR" ]; then
    STATE_STATE=unreadable; STATE_DETAIL="package not found at $PKG_DIR (set PKG_DIR)"; return 0
  fi
  PKG_DIGEST=$(node -e "import('$PKG_DIR/dist/state/schema.js').then(m=>console.log(Buffer.from(m.STATE_SCHEMA_DIGEST).toString('hex')),e=>console.log('ERR:'+e.message))" 2>/dev/null)
  case "$DB_DIGEST$PKG_DIGEST" in
    *ERR:*|"") STATE_STATE=unreadable; STATE_DETAIL="db=${DB_DIGEST:-?} pkg=${PKG_DIGEST:-?}"; return 0 ;;
  esac
  if [ "$DB_DIGEST" = "$PKG_DIGEST" ]; then
    STATE_STATE=ok; STATE_DETAIL="schema digest matches installed package"
  else
    STATE_STATE=skew
    STATE_DETAIL="db=${DB_DIGEST:0:16}… pkg=${PKG_DIGEST:0:16}… — host exits before bind()"
  fi
}

# ---- host lease -> LEASE_STATE {none,expired,held}, LEASE_PID, LEASE_LOCAL {yes,no}, LEASE_DETAIL
#
# On a shared $HOME (cluster home on NFS/weka) every node resolves the SAME
# ~/.pi/agent/workflows: one state.sqlite, one host.sock path. The socket is
# machine-local no matter what the filesystem shows, so a host on node A is
# unreachable from node B — and node B cannot start its own, because
# acquireHost() throws "A live Pi Workflows host already owns epoch N" while the
# 30s lease in workflow_host_state is renewed. Symptom on node B: connect ENOENT
# with a CLEAN lock verdict, indistinguishable by eye from schema skew.
#
# The lease row carries pid + process_start_identity but NO hostname, so remote
# and simply-dead look the same. That is fine: the question worth asking is not
# "where does it live" but "is it usable from here", and the socket probe already
# answers that. pid alive here AND identity matches -> ours; anything else -> not
# serving this node.
inspect_lease() {
  LEASE_STATE=none; LEASE_PID=""; LEASE_LOCAL=no; LEASE_DETAIL="no state.sqlite"
  [ -f "$STATE_DB" ] || return 0
  local out
  out=$(python3 - "$STATE_DB" <<'PY'
import sqlite3,sys,os,time
try:
    c=sqlite3.connect("file:%s?mode=ro"%sys.argv[1],uri=True)
    r=c.execute("select host_id,pid,process_start_identity,expires_at,epoch"
                " from workflow_host_state where id=1").fetchone()
except Exception as e:
    print("none||no|unreadable: %s"%e); raise SystemExit
if r is None or r[0] is None:
    print("none||no|no host has ever claimed this database"); raise SystemExit
host_id,pid,ident,exp,epoch=r
now=int(time.time()*1000)
local="no"
try:
    got="linux-proc-start:%s"%open("/proc/%d/stat"%pid).read().rsplit(")",1)[1].split()[19]
    if got==ident: local="yes"
    else: local="no"
except Exception:
    pass
left=((exp or 0)-now)/1000.0
if left>0:
    where="this node" if local=="yes" else "another node (or a dead pid)"
    print("held|%d|%s|epoch %d held by pid %d on %s, %.0fs left"%(pid,local,epoch,pid,where,left))
else:
    print("expired|%d|%s|epoch %d lease expired %.0fs ago — free to claim"%(pid,local,epoch,-left))
PY
)
  LEASE_STATE="$(printf '%s' "$out" | cut -d'|' -f1)"
  LEASE_PID="$(printf '%s' "$out" | cut -d'|' -f2)"
  LEASE_LOCAL="$(printf '%s' "$out" | cut -d'|' -f3)"
  LEASE_DETAIL="$(printf '%s' "$out" | cut -d'|' -f4-)"
}

# ---- lock state -> LOCK_STATE {none,stale-nopid,stale-reused,live}, LOCK_PID, LOCK_DETAIL
inspect_lock() {
  LOCK_STATE=none; LOCK_PID=""; LOCK_DETAIL="no lock file"
  [ -f "$LOCK" ] || return 0
  local out
  out=$(python3 - "$LOCK" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception as e:
    print("BADJSON||%s"%e); raise SystemExit
pid=d.get("pid"); want=d.get("startIdentity") or ""
if not isinstance(pid,int):
    print("BADJSON||no pid"); raise SystemExit
try:
    raw=open("/proc/%d/stat"%pid).read()
    got="linux-proc-start:%s"%raw.rsplit(")",1)[1].split()[19]
except FileNotFoundError:
    print("NOPID|%d|pid not running"%pid); raise SystemExit
except Exception as e:
    print("NOPID|%d|unreadable: %s"%(pid,e)); raise SystemExit
if want and want!=got:
    print("REUSED|%d|lock=%s proc=%s"%(pid,want,got))
else:
    print("LIVE|%d|%s"%(pid,got))
PY
)
  LOCK_PID="$(printf '%s' "$out" | cut -d'|' -f2)"
  LOCK_DETAIL="$(printf '%s' "$out" | cut -d'|' -f3-)"
  case "${out%%|*}" in
    LIVE)    LOCK_STATE=live ;;
    NOPID)   LOCK_STATE=stale-nopid ;;
    REUSED)  LOCK_STATE=stale-reused ;;
    *)       LOCK_STATE=stale-nopid; LOCK_DETAIL="unparseable lock: $LOCK_DETAIL" ;;
  esac
}

# ---- socket state -> SOCK_STATE {none,live,stale}
inspect_sock() {
  SOCK_STATE=none; SOCK_DETAIL="no socket file"
  [ -e "$SOCK" ] || return 0
  local out
  out=$(python3 - "$SOCK" <<'PY'
import socket,sys,errno
p=sys.argv[1]
s=socket.socket(socket.AF_UNIX); s.settimeout(2)
try:
    s.connect(p); print("live|listener accepted connect")
except ConnectionRefusedError: print("stale|ECONNREFUSED, nothing bound")
except FileNotFoundError:      print("none|ENOENT")
except Exception as e:         print("stale|%s: %s"%(type(e).__name__,e))
finally:
    try: s.close()
    except Exception: pass
PY
)
  SOCK_STATE="${out%%|*}"; SOCK_DETAIL="${out#*|}"
}

cmd_status() {
  inspect_lock; inspect_sock
  say "host dir : $HOST_DIR"
  say "lock     : $LOCK_STATE  (pid=${LOCK_PID:-none}) — $LOCK_DETAIL"
  [ -f "$LOCK" ] && say "           mtime $(stat -c%y "$LOCK" 2>/dev/null)"
  say "socket   : $SOCK_STATE — $SOCK_DETAIL"
  if [ -f "$KIDS" ]; then
    say "children : $(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("processes",[])))' "$KIDS" 2>/dev/null || echo '?') registered"
  fi
  inspect_state
  say "state    : $STATE_STATE — $STATE_DETAIL"
  inspect_lease
  say "lease    : $LEASE_STATE — $LEASE_DETAIL"
  # Schema skew outranks every lock verdict except a healthy host: no amount of cleaning
  # makes a host boot against a database it refuses to open.
  if [ "$STATE_STATE" = skew ] && ! { [ "$LOCK_STATE" = live ] && [ "$SOCK_STATE" = live ]; }; then
    say "VERDICT  : SCHEMA SKEW — the host cannot boot; this is NOT lock garbage."
    say "           state.sqlite was written by a different pi-workflows schema than the"
    say "           installed package. clean/verify will both 'succeed' and change nothing."
    say "           Reproduce: node $(host_entry) --database $STATE_DB"
    say "           Fix:       $(basename "$0") reset-state --apply   (archives the db, loses run history)"
    return 5
  fi
  if [ "$LOCK_STATE" = live ] && [ "$SOCK_STATE" = live ]; then
    say "VERDICT  : HEALTHY — do not gc"; return 0
  fi
  if [ "$LOCK_STATE" = live ] && [ "$SOCK_STATE" != live ]; then
    say "VERDICT  : LIVE PROCESS, DEAD SOCKET — the host is running but unreachable."
    say "           GC will NOT help and --force here kills a working host's lock."
    say "           Investigate that pid (or stop it deliberately) first."
    return 4
  fi
  # A held lease we cannot reach outranks CLEAN: there is no garbage here, the host
  # is simply somewhere else. Cleaning in a loop will never fix it.
  if [ "$SOCK_STATE" != live ] && [ "$LEASE_STATE" = held ] && [ "$LEASE_LOCAL" = no ]; then
    say "VERDICT  : REMOTE LEASE — the lease is held by a host this node cannot reach."
    say "           Shared \$HOME: one state.sqlite, one socket path, many nodes. The"
    say "           holder keeps renewing, so no host can start here — and its socket is"
    say "           machine-local anyway. This is NOT lock garbage and NOT schema skew."
    say "           Fix:       $(basename "$0") takeover --apply   (holder self-evicts)"
    return 6
  fi
  if [ "$LOCK_STATE" = none ] && [ "$SOCK_STATE" = none ]; then
    say "VERDICT  : CLEAN — nothing to collect"; return 0
  fi
  say "VERDICT  : STALE — safe to clean"
  return 3
}

cmd_clean() {
  local force="${1:-}"
  inspect_lock; inspect_sock
  if [ "$LOCK_STATE" = live ] && [ "$force" != "--force" ]; then
    say "REFUSING: lock pid $LOCK_PID is alive AND its start identity matches."
    say "This is a healthy host. Re-run with --force only if you have stopped it yourself."
    return 4
  fi
  local moved=0
  for f in "$LOCK" "$SOCK" "$KIDS"; do
    [ -e "$f" ] || continue
    # a live socket is the one thing we never move unless forced
    if [ "$f" = "$SOCK" ] && [ "$SOCK_STATE" = live ] && [ "$force" != "--force" ]; then
      say "keep  $(basename "$f")  (live listener)"; continue
    fi
    mv -- "$f" "$f.stale-$TS" && { say "moved $(basename "$f") -> $(basename "$f").stale-$TS"; moved=$((moved+1)); }
  done
  say "moved $moved file(s). Nothing deleted; run 'restore' to undo."
  cmd_verify
}

cmd_verify() {
  # A real bind is the only proof the path is reclaimable. Probe, then unlink.
  python3 - "$SOCK" <<'PY'
import socket,sys,os
p=sys.argv[1]+".gcprobe"
try: os.unlink(p)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX)
try:
    s.bind(p); s.listen(1); print("VERIFY: bind OK — a fresh host can claim this path")
except Exception as e:
    print("VERIFY: bind FAILED — %s: %s"%(type(e).__name__,e)); raise SystemExit(5)
finally:
    s.close()
    try: os.unlink(p)
    except FileNotFoundError: pass
PY
  local rc=$?
  [ $rc -eq 0 ] && say "NOTE: the host does not respawn mid-session if the extension loaded before its deps. Expect it back on next session start."
  return $rc
}

# The error message names the fix: move state.sqlite + -wal + -shm aside and a fresh one is
# created on next boot. Run history is lost, so refuse while any run is non-terminal.
cmd_reset_state() {
  local apply="${1:-}"
  inspect_state
  [ "$STATE_STATE" = ok ] && { say "state schema matches the installed package — nothing to reset"; return 0; }
  [ "$STATE_STATE" = none ] && { say "no state.sqlite — a fresh one is created on next host boot"; return 0; }
  inspect_lock
  if [ "$LOCK_STATE" = live ]; then
    say "REFUSING: host pid $LOCK_PID is alive. Stop it before moving its database."; return 4
  fi
  local live_runs
  live_runs=$(python3 - "$STATE_DB" <<'PY'
import sqlite3,sys
try:
    c=sqlite3.connect("file:%s?mode=ro"%sys.argv[1],uri=True)
    print(c.execute("select count(*) from runs where status not in"
                    " ('completed','failed','cancelled','timed_out')").fetchone()[0])
except Exception:
    print(0)   # unreadable schema is itself the skew; nothing recoverable to strand
PY
)
  if [ "${live_runs:-0}" -gt 0 ]; then
    say "REFUSING: $live_runs non-terminal run(s) in this database. Archiving strands them."
    say "Finish or cancel them first, or accept the loss with a manual mv."
    return 4
  fi
  local dest="$WF_DIR/archive-$TS-schemaskew"
  if [ "$apply" != "--apply" ]; then
    say "DRY RUN — would move state.sqlite{,-wal,-shm} -> $dest/"
    say "re-run with --apply"; return 0
  fi
  mkdir -p "$dest"
  local n=0
  for f in "$STATE_DB" "$STATE_DB-wal" "$STATE_DB-shm"; do
    [ -e "$f" ] || continue
    mv -- "$f" "$dest/" && { say "moved $(basename "$f") -> $(basename "$dest")/"; n=$((n+1)); }
  done
  say "moved $n file(s). Restore: mv $dest/state.sqlite* $WF_DIR/"
  say "The host creates a fresh database on next boot. Start one now with:"
  say "  setsid nohup node $(host_entry) --database $STATE_DB >/tmp/wfhost.log 2>&1 &"
}

# ---- takeover: move the host to THIS node
#
# Why this is safe, and why it is only three steps:
#   * acquireHostLock() judges host.lock.json by pid + start identity ON THIS NODE, so a
#     lock written by another node reads as stale and is rewritten. It never blocks.
#   * Runner.listen() does fs.rmSync(socketPath) before bind(), so the stale path is the
#     new host's problem to clear, not ours. (This is also why the evicted host ends up
#     listening on an unlinked inode — visible nowhere, reachable by no one.)
#   * The ONLY thing that blocks a second node is the lease, and renewHost() matches on
#     expires_at > now. Setting it to 0 makes the holder's next heartbeat throw; the
#     runner catches that as "host claim lost" and calls stop() on itself. The eviction
#     is cooperative — we never signal another machine's process.
#
# ponytail: two hosts share one state.sqlite for up to one renew interval (~30s) during
# the handover. Fine over weka for a lease row; if you ever see SQLITE_BUSY storms here,
# give each node its own --database instead of sharing one.
cmd_takeover() {
  local apply="" force=""
  for a in "$@"; do case "$a" in --apply) apply=1 ;; --force) force=1 ;; esac; done
  inspect_sock
  if [ "$SOCK_STATE" = live ]; then
    say "NOTHING TO DO: a reachable host is already listening on $SOCK"; return 0
  fi
  inspect_state
  if [ "$STATE_STATE" = skew ]; then
    say "REFUSING: schema skew — a new host cannot boot here either."
    say "Run '$(basename "$0") reset-state --apply' first."; return 5
  fi
  inspect_lease
  if [ "$LEASE_STATE" = held ] && [ "$LEASE_LOCAL" = yes ]; then
    say "REFUSING: lease pid $LEASE_PID is alive ON THIS NODE and its start identity matches,"
    say "but its socket is unreachable. Stealing the lease from a local host hides a real"
    say "bug. Investigate (or stop) that pid first."; return 4
  fi
  # Non-terminal runs belong to the holder. Taking the lease orphans its workers.
  local live_runs
  live_runs=$(python3 - "$STATE_DB" <<'PY'
import sqlite3,sys
try:
    c=sqlite3.connect("file:%s?mode=ro"%sys.argv[1],uri=True)
    print(c.execute("select count(*) from runs where status not in"
                    " ('completed','failed','cancelled','timed_out')").fetchone()[0])
except Exception:
    print(0)
PY
)
  if [ "${live_runs:-0}" -gt 0 ] && [ -z "$force" ]; then
    say "REFUSING: $live_runs non-terminal run(s). They belong to the current holder and its"
    say "workers are orphaned by the epoch bump. Finish/cancel them, or pass --force."
    return 4
  fi
  if [ -z "$apply" ]; then
    say "DRY RUN on $(hostname) — would:"
    say "  1. expire the lease  ($LEASE_DETAIL)"
    say "  2. start a host here on $STATE_DB"
    say "  3. wait for the socket to accept a connect"
    say "re-run with --apply"; return 0
  fi
  if [ "$LEASE_STATE" = held ]; then
    python3 - "$STATE_DB" <<'PY' || return 1
import sqlite3,sys
c=sqlite3.connect(sys.argv[1],timeout=10)
n=c.execute("update workflow_host_state set expires_at=0 where id=1").rowcount
c.commit(); c.close()
print("expired the lease (%d row) — holder self-evicts on its next heartbeat"%n)
PY
  fi
  [ -d "$PKG_DIR" ] || { say "package not found at $PKG_DIR (set PKG_DIR)"; return 1; }
  setsid nohup node "$(host_entry)" --database "$STATE_DB" \
    >/tmp/wfhost-$(hostname).log 2>&1 &
  say "started a host on $(hostname); log /tmp/wfhost-$(hostname).log"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1; inspect_sock
    [ "$SOCK_STATE" = live ] && { say "TAKEOVER OK — host reachable on this node after ${i}s"; return 0; }
  done
  say "socket still $SOCK_STATE after 10s. Host log:"; tail -5 "/tmp/wfhost-$(hostname).log"
  say "(a client may also have raced us to spawn one — re-run 'status')"
  return 3
}

cmd_restore() {
  local newest
  newest=$(ls -1dt "$HOST_DIR"/*.stale-* 2>/dev/null | head -1) || true
  [ -z "${newest:-}" ] && { say "nothing to restore"; return 1; }
  local stamp="${newest##*.stale-}" n=0
  for f in "$HOST_DIR"/*.stale-"$stamp"; do
    [ -e "$f" ] || continue
    mv -- "$f" "${f%.stale-$stamp}" && { say "restored $(basename "${f%.stale-$stamp}")"; n=$((n+1)); }
  done
  say "restored $n file(s) from $stamp"
}


# ---------------------------------------------------------------------------
# Workflow-FILE gc. A separate concern from the host lock: these are the
# *.workflow.ts files planning sessions leave behind. Three rules make it safe:
#
#   1. A file with a NON-TERMINAL run (outside completed/failed/cancelled/
#      timed_out) is PROTECTED. Archiving it strands that run's workflow_ref.
#   2. A SYMLINK is never followed. These point into version-controlled notes
#      (~/dev/notebook/...). Moving the link is fine; the target is never touched.
#   3. Nothing is deleted. Files move into archive-<ts>/ beside the originals,
#      matching the archive-* convention already used in this directory.
#
# It also flags DIVERGED duplicates: the same basename in two places with
# different bytes. That is how a run ends up executing a stale copy of a file
# you believed you had edited.
classify_workflows() {
  python3 - "$WF_DIR" "$STATE_DB" <<'PY'
import os,sqlite3,sys,hashlib,glob
wf_dir,db=sys.argv[1],sys.argv[2]
TERMINAL={"completed","failed","cancelled","timed_out"}
runs={}
if os.path.exists(db):
    try:
        c=sqlite3.connect("file:%s?mode=ro"%db,uri=True)
        for ref,st,upd in c.execute("select workflow_ref,status,coalesce(updated_at,created_at) from runs"):
            if not ref or ref.startswith("builtin:"): continue
            runs.setdefault(os.path.realpath(ref),[]).append((st,upd or 0,ref))
        c.close()
    except Exception as e:
        print("WARN|state.sqlite unreadable: %s|||0|"%e)
def sha(p):
    try: return hashlib.sha256(open(p,'rb').read()).hexdigest()[:12]
    except Exception: return "?"
for p in sorted(glob.glob(os.path.join(wf_dir,"*.workflow.ts"))):
    base=os.path.basename(p); islink=os.path.islink(p)
    kind="symlink -> "+os.readlink(p) if islink else "file"
    real=os.path.realpath(p); rs=runs.get(real,[])
    live=sorted({s for s,_,_ in rs if s not in TERMINAL})
    last=max([u for _,u,_ in rs],default=0)
    diverged=""
    for ref_real,entries in runs.items():
        if os.path.basename(ref_real)==base and ref_real!=real and os.path.exists(ref_real) \
           and sha(ref_real)!=sha(p):
            diverged=ref_real
    if live:  state,why="PROTECTED","live run(s): "+",".join(live)
    elif rs:  state,why="ARCHIVABLE","%d run(s), all terminal"%len(rs)
    else:     state,why="ARCHIVABLE","no runs recorded (orphan)"
    print("%s|%s|%s|%s|%d|%s"%(state,base,why,kind,last,diverged))
PY
}

_fmt_when() { [ "${1:-0}" = "0" ] && echo never || date -d "@$(( $1 / 1000 ))" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$1"; }

cmd_list() {
  say "workflow dir: $WF_DIR"
  local n=0
  while IFS='|' read -r state base why kind last diverged; do
    [ -z "${state:-}" ] && continue
    [ "$state" = WARN ] && { say "WARN: $base"; continue; }
    n=$((n+1))
    say "$(printf '%-11s %s' "$state" "$base")"
    say "            $why | $kind | last run: $(_fmt_when "$last")"
    [ -n "${diverged:-}" ] && say "            !! DIVERGED duplicate with different bytes: $diverged"
  done < <(classify_workflows)
  [ "$n" = 0 ] && say "(no *.workflow.ts files)"
  say ""
  say "archive with:  $(basename "$0") archive --apply [name...]"
}

cmd_archive() {
  local apply="" names=()
  for a in "$@"; do case "$a" in --apply) apply=1 ;; *) names+=("$a") ;; esac; done
  local dest="$WF_DIR/archive-$TS" picked=() skipped=0
  while IFS='|' read -r state base why kind last diverged; do
    [ -z "${state:-}" ] || [ "$state" = WARN ] && continue
    if [ ${#names[@]} -gt 0 ]; then
      local want=0; for x in "${names[@]}"; do [[ "$base" == *"$x"* ]] && want=1; done
      [ "$want" = 1 ] || continue
    fi
    if [ "$state" = PROTECTED ]; then
      say "SKIP  $base — $why"; skipped=$((skipped+1)); continue
    fi
    picked+=("$base"); say "TAKE  $base — $why | $kind | last run: $(_fmt_when "$last")"
  done < <(classify_workflows)

  [ ${#picked[@]} -eq 0 ] && { say "nothing to archive ($skipped protected)"; return 0; }
  if [ -z "$apply" ]; then
    say ""; say "DRY RUN — ${#picked[@]} file(s) would move to $dest ; $skipped protected."
    say "Re-run with --apply to do it. Nothing is ever deleted."
    return 0
  fi
  mkdir -p "$dest" || return 1
  for b in "${picked[@]}"; do
    mv -- "$WF_DIR/$b" "$dest/$b" && say "archived $b -> archive-$TS/"
  done
  say "archived ${#picked[@]} file(s) to $dest ; $skipped protected. Restore: mv $dest/<f> $WF_DIR/"
}

case "${1:-status}" in
  status)  cmd_status ;;
  takeover) shift; cmd_takeover "$@" ;;
  clean)   cmd_clean "${2:-}" ;;
  verify)  cmd_verify ;;
  restore) cmd_restore ;;
  reset-state) cmd_reset_state "${2:-}" ;;
  list)    cmd_list ;;
  archive) shift; cmd_archive "$@" ;;
  *) say "usage: $(basename "$0") {status|takeover [--apply] [--force]|clean [--force]|verify|restore|reset-state [--apply]|list|archive [--apply] [name...]}"; exit 2 ;;
esac
