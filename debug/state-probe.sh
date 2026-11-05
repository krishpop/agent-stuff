#!/usr/bin/env bash
# Is an extension's SQLite state file slow, and is it slow because of WHERE it
# lives? Answers both without touching the live file.
#
#   ./state-probe.sh                       # every *.sqlite under ~/.pi/agent
#   ./state-probe.sh ~/.pi/agent/foo.sqlite
#
# The interesting number is "same file on local disk". A network home (wekafs,
# NFS, Lustre) turns every SQLite page fault into a round trip; a 100x gap
# between the two columns means the fix is the location, not the code.
set -uo pipefail

OUT="${PI_DEBUG_OUT:-/tmp/pi-debug}"; mkdir -p "$OUT"
LOCAL="${PI_DEBUG_LOCAL:-/tmp/$USER/pi-state-probe}"; mkdir -p "$LOCAL"

if [ $# -gt 0 ]; then
  DBS=("$@")
else
  mapfile -t DBS < <(find ~/.pi/agent -maxdepth 3 -name '*.sqlite' -size +0 2>/dev/null)
fi
[ ${#DBS[@]} -gt 0 ] || { echo "no sqlite state found under ~/.pi/agent"; exit 0; }

echo "=== pi state probe  $(date -Is) ==="
fs_of() { df -T "$1" 2>/dev/null | awk 'NR==2{print $2" on "$1}'; }
echo "    ~/.pi/agent = $(fs_of ~/.pi/agent)"
echo "    $LOCAL = $(fs_of "$LOCAL")"

for DB in "${DBS[@]}"; do
  [ -e "$DB" ] || { echo "!! missing: $DB"; continue; }
  echo
  echo "--- $DB"
  ls -la "$DB"* 2>/dev/null | sed 's/^/    /'
  [ -e "$DB-journal" ] && echo "    !! stale rollback journal -> a writer died mid-transaction"
  [ -e "$DB-wal" ] && echo "    (WAL mode active)"
  echo "    open right now:"
  lsof "$DB" 2>/dev/null | awk 'NR>1{print "      "$1" pid="$2" "$4}' | sort -u

  cp "$DB" "$LOCAL/probe.sqlite" 2>/dev/null || { echo "    !! could not copy"; continue; }

  DB="$DB" LOCALDB="$LOCAL/probe.sqlite" python3 - <<'PY'
import os, sqlite3, time

def ms(fn):
    t = time.perf_counter()
    v = fn()
    return v, (time.perf_counter() - t) * 1000

def ro(p):
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)

live, local = os.environ["DB"], os.environ["LOCALDB"]
c = ro(live)
print("    pragmas: " + "  ".join(
    f"{p}={c.execute('pragma ' + p).fetchone()[0]}"
    for p in ("journal_mode", "synchronous", "page_size", "page_count", "freelist_count")))

tables = [r[0] for r in c.execute(
    "select name from sqlite_master where type='table' order by name")]
print(f"    tables ({len(tables)}): row counts, biggest first")
counts = []
for t in tables:
    try:
        counts.append((c.execute(f'select count(*) from "{t}"').fetchone()[0], t))
    except Exception:
        pass
for n, t in sorted(counts, reverse=True)[:8]:
    print(f"      {n:>10,}  {t}")

# The headline: identical whole-file scan, network home vs local disk.
print(f"    {'check':22s} {'in place':>12s} {'local copy':>12s}")
for label, sql in (("quick_check", "pragma quick_check"),
                   ("foreign_key_check", "pragma foreign_key_check")):
    _, a = ms(lambda: ro(live).execute(sql).fetchall())
    _, b = ms(lambda: ro(local).execute(sql).fetchall())
    flag = "   <-- location is the problem" if b and a / max(b, 0.01) > 10 else ""
    print(f"    {label:22s} {a:10.0f}ms {b:10.0f}ms{flag}")
PY

  echo "    VACUUM on the copy (how much is bloat vs live data):"
  before=$(stat -c %s "$LOCAL/probe.sqlite")
  sqlite3 "$LOCAL/probe.sqlite" 'VACUUM;' 2>/dev/null
  after=$(stat -c %s "$LOCAL/probe.sqlite")
  echo "      $(numfmt --to=iec "$before") -> $(numfmt --to=iec "$after")  (reclaimable: $(numfmt --to=iec $((before - after))))"
done

echo
echo "--- commit latency in the state directory, by journal mode (synthetic) ---"
STATE_DIR=$(dirname "${DBS[0]}") python3 - <<'PY'
import os, sqlite3, tempfile, time

def bench(d, journal, sync, n=200):
    f = tempfile.mktemp(dir=d, suffix=".bench")
    c = sqlite3.connect(f, isolation_level=None)
    c.execute(f"pragma journal_mode={journal}")
    c.execute(f"pragma synchronous={sync}")
    c.execute("create table t(a integer primary key, b text)")
    t = time.perf_counter()
    for _ in range(n):
        c.execute("begin")
        c.execute("insert into t(b) values(?)", ("x" * 200,))
        c.execute("commit")
    took = (time.perf_counter() - t) * 1000
    c.close()
    for ext in ("", "-journal", "-wal", "-shm"):
        try:
            os.unlink(f + ext)
        except OSError:
            pass
    return took

d = os.environ["STATE_DIR"]
for jm, sy in (("delete", "FULL"), ("truncate", "FULL"), ("wal", "FULL"), ("wal", "NORMAL")):
    t = bench(d, jm, sy)
    print(f"    {jm:9s} synchronous={sy:6s}  200 commits: {t:8.1f} ms  ({t/200:.2f} ms/commit)")
PY
echo
echo "note: WAL is usually far faster, but its -shm index can wedge on a shared"
echo "      network home. Move the DB to local disk first, then consider WAL."
