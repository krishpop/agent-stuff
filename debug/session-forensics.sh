#!/usr/bin/env bash
# Post-mortem on a session that already felt slow. Finds the wall-clock gaps,
# the error surface, and how big the session got.
#
#   ./session-forensics.sh                     # biggest session for $PWD
#   ./session-forensics.sh <session.jsonl>
#   ./session-forensics.sh <session dir>
#
# Session format: pi-coding-agent/docs/session-format.md
set -uo pipefail

ARG="${1:-}"
if [ -z "$ARG" ]; then
  # pi encodes the project path into the session dir name.
  DIR=~/.pi/agent/sessions/--$(echo "${PWD#/}" | tr '/.' '--')--
  [ -d "$DIR" ] || DIR=$(ls -dt ~/.pi/agent/sessions/*/ 2>/dev/null | head -1)
elif [ -d "$ARG" ]; then
  DIR="$ARG"
else
  DIR=$(dirname "$ARG")
fi

if [ -f "${ARG:-}" ]; then F="$ARG"; else F=$(ls -S "$DIR"/*.jsonl 2>/dev/null | head -1); fi
[ -f "${F:-}" ] || { echo "no session files under $DIR"; exit 1; }

echo "=== session forensics  $(date -Is) ==="
echo "    dir:  $DIR"
ls -laS "$DIR"/*.jsonl 2>/dev/null | head -5 | sed 's/^/    /'
echo "    file: $(basename "$F")  entries=$(wc -l < "$F")"
echo
echo "--- entry types (a type that dwarfs the rest is a recording bug) ---"
jq -r '.type // "?"' "$F" 2>/dev/null | sort | uniq -c | sort -rn | head -12 | sed 's/^/    /'

echo
echo "--- wall-clock gaps > 10s ---"
python3 - "$F" <<'PY'
import datetime, json, sys
prev, gaps = None, []
for line in open(sys.argv[1]):
    try:
        e = json.loads(line)
    except Exception:
        continue
    ts = e.get("timestamp")
    if not ts:
        continue
    try:
        t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        continue
    if prev:
        d = (t - prev[0]).total_seconds()
        if d > 10:
            gaps.append((d, prev[1], e.get("type")))
    prev = (t, e.get("type"))
for d, a, b in sorted(gaps, reverse=True)[:15]:
    print(f"    {d:8.1f}s   after {a} -> {b}")
print(f"    ({len(gaps)} gaps >10s)")
print("    message -> message gaps are the human thinking. Anything else,")
print("    especially tool_result -> message, is the agent stalling.")
PY

echo
echo "--- error / warning surface ---"
for pat in SQLITE_BUSY ECONNRESET ETIMEDOUT "Could not " "timed out" "ERR_MODULE_NOT_FOUND"; do
  n=$(grep -Foc "$pat" "$DIR"/*.jsonl 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  [ "$n" -gt 0 ] && printf '    %-22s %d\n' "$pat" "$n"
done
grep -ho '"content":"Could not [^"]*"' "$DIR"/*.jsonl 2>/dev/null |
  sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'

echo
echo "--- other artefacts worth a look ---"
ls -la ~/.pi/agent/pi-debug.log 2>/dev/null | sed 's/^/    /'
du -sh ~/.pi/agent/state 2>/dev/null | sed 's/^/    state dir: /'
ls ~/.pi/agent/*/*-journal ~/.pi/agent/*/*.sqlite-journal 2>/dev/null |
  sed 's/^/    !! stale journal: /'

echo
echo "--- reproduce it: replay this session against one extension ---"
echo "    ./bisect.sh --session \"$F\""
echo "    (--fork, so the record is not mutated)"
