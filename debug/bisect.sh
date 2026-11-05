#!/usr/bin/env bash
# Which extension is making pi slow?
#
# Times pi with NO extensions (floor), with each extension alone, and with
# everything as configured (ceiling). Reports wall time AND event-loop blocked
# time -- blocked time is what actually freezes the TUI.
#
#   ./bisect.sh                      # every discovered extension, startup only
#   ./bisect.sh --workload           # also make it call tools (steady-state cost)
#   ./bisect.sh --session FILE       # fork a long session (finds O(n) bugs)
#   ./bisect.sh dt tmux-pi           # only these
#   ./bisect.sh --reps 3             # median of 3 instead of best of 2
#
# Env: PI_DEBUG_MODEL (cheap model), PI_DEBUG_OUT (default /tmp/pi-debug).
set -uo pipefail

OUT="${PI_DEBUG_OUT:-/tmp/pi-debug}"; mkdir -p "$OUT"
R="$OUT/bisect.txt"; : > "$R"
LAG="$OUT/lag.jsonl"; : > "$LAG"
HERE=$(cd "$(dirname "$0")" && pwd)
CANARY="$HERE/lag-canary.ts"
say() { echo "$*" | tee -a "$R"; }

MODEL="${PI_DEBUG_MODEL:?Set PI_DEBUG_MODEL to a model available on this machine}"
REPS=2
SESSION=""
declare -a PI_WORK=(--no-tools -p "reply with exactly: ok")
declare -a ONLY=()

while [ $# -gt 0 ]; do
  case "$1" in
    --workload) PI_WORK=(-t bash -p 'Run these three commands one at a time using the bash tool: `echo one`, `echo two`, `echo three`. Then reply done.') ;;
    --session)  SESSION="$2"; shift ;;
    --reps)     REPS="$2"; shift ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *)          ONLY+=("$1") ;;
  esac
  shift
done

# Every loadable extension: the symlinked/local ones under ~/.pi/agent/extensions,
# plus each npm package's declared `pi.extensions` entry points. Discovering them
# instead of hardcoding a list is what makes this survive a package bump.
mapfile -t ENTRIES < <(python3 - <<'PY'
import glob, json, os
nm = os.path.expanduser("~/.pi/agent/npm/node_modules")
for d in sorted(glob.glob(os.path.expanduser("~/.pi/agent/extensions/*"))):
    print(f"{os.path.basename(d)}\t{d}")
for pj in sorted(glob.glob(nm + "/*/package.json") + glob.glob(nm + "/@*/*/package.json")):
    root = os.path.dirname(pj)
    name = os.path.relpath(root, nm)
    try:
        entries = (json.load(open(pj)).get("pi") or {}).get("extensions") or []
    except Exception:
        continue
    for e in entries:
        full = os.path.normpath(os.path.join(root, e))
        if os.path.isdir(full):
            for f in sorted(glob.glob(full + "/*.ts")) + sorted(glob.glob(full + "/*.js")):
                print(f"{name}\t{f}")
        elif os.path.exists(full):
            print(f"{name}\t{full}")
PY
)

if [ ${#ONLY[@]} -gt 0 ]; then
  keep=()
  for row in "${ENTRIES[@]}"; do
    for want in "${ONLY[@]}"; do
      case "${row%%$'\t'*}" in *"$want"*) keep+=("$row") ;; esac
    done
  done
  ENTRIES=("${keep[@]}")
fi

measure() {  # $1=tag, rest=extra pi args. Best (or median) of $REPS.
  local tag="$1"; shift
  local times=() t0 t1 i
  for ((i = 0; i < REPS; i++)); do
    t0=$(date +%s.%N)
    PI_LAG_TAG="$tag" PI_LAG_LOG="$LAG" timeout 400 pi --model "$MODEL" \
      "${PI_WORK[@]}" ${SESSION:+--fork "$SESSION"} "$@" >/dev/null 2>&1
    t1=$(date +%s.%N)
    times+=("$(echo "$t1 - $t0" | bc)")
  done
  local wall
  wall=$(printf '%s\n' "${times[@]}" | sort -n | head -1)
  python3 - "$LAG" "$tag" "$wall" <<'PY' | tee -a "$R"
import json, sys
log, tag, wall = sys.argv[1], sys.argv[2], float(sys.argv[3])
rec = None
for line in open(log):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("tag") == tag:
        rec = r
if rec is None:
    print(f"  {tag:38.38s} wall {wall:7.2f}s   (no lag data)")
else:
    print(f"  {tag:38.38s} wall {wall:7.2f}s   blocked {rec['blocked_total']/1000:6.2f}s"
          f"   p95 {rec['p95']:7.1f}ms   max {rec['max']:8.1f}ms   >1s:{rec['over_1s']:3d}")
PY
}

say "=== pi extension bisection  $(date -Is) ==="
say "    model=$MODEL reps=$REPS entries=${#ENTRIES[@]}${SESSION:+ session=$(basename "$SESSION")}"
say "    state fs: $(df -T ~/.pi/agent 2>/dev/null | awk 'NR==2{print $2" on "$1}')"
say ""
say "--- floor: canary only, no extensions ---"
measure FLOOR -ne -e "$CANARY"
say ""
say "--- one extension at a time, on top of the floor ---"
for row in "${ENTRIES[@]}"; do
  measure "${row%%$'\t'*}" -ne -e "$CANARY" -e "${row#*$'\t'}"
done
say ""
say "--- ceiling: everything as configured ---"
measure CEILING -e "$CANARY"

say ""
say "=== ranked by blocked time (what makes the TUI hang) ==="
python3 - "$R" <<'PY' | tee -a "$R"
import re, sys
rows = []
for line in open(sys.argv[1]):
    m = re.search(r"^\s+(\S.*?)\s+wall\s+([\d.]+)s\s+blocked\s+([\d.]+)s.*?max\s+([\d.]+)ms", line)
    if m:
        rows.append((m.group(1).strip(), float(m.group(2)), float(m.group(3)), float(m.group(4))))
floor = next((r for r in rows if r[0] == "FLOOR"), None)
fw, fb = (floor[1], floor[2]) if floor else (0.0, 0.0)
print(f"  {'extension':34s} {'wall':>8s} {'d_wall':>8s} {'blocked':>9s} {'d_block':>9s} {'maxstall':>10s}")
for n, w, b, mx in sorted(rows, key=lambda r: -r[2]):
    print(f"  {n:34.34s} {w:7.2f}s {w-fw:+7.2f}s {b:8.2f}s {b-fb:+8.2f}s {mx:9.1f}ms")
PY
say ""
say "report -> $R"
