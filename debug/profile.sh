#!/usr/bin/env bash
# Where does the time actually go for one pi configuration? Answers
# "CPU or I/O?" first, then names the frames.
#
#   ./profile.sh -ne -e ~/.pi/agent/extensions/dt      # profile one extension
#   ./profile.sh                                       # profile the full config
#
# Everything after the script name is passed to pi verbatim.
set -uo pipefail

OUT="${PI_DEBUG_OUT:-/tmp/pi-debug}"; mkdir -p "$OUT"
MODEL="${PI_DEBUG_MODEL:?Set PI_DEBUG_MODEL to a model available on this machine}"
CLI="${PI_CLI:-$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js}"
[ -f "$CLI" ] || CLI=$(node -e 'console.log(require.resolve("@earendil-works/pi-coding-agent/dist/bundle/cli.js"))' 2>/dev/null)
PROMPT="reply with exactly: ok"

echo "=== 1. syscall time: is it fsync, network, or CPU? ==="
if command -v strace >/dev/null; then
  strace -f -c -w -e trace=fsync,fdatasync,openat,read,write,connect,clone,execve,futex \
    timeout 120 node "$CLI" --model "$MODEL" --no-tools -p "$PROMPT" "$@" \
    >/dev/null 2>"$OUT/strace.txt"
  tail -25 "$OUT/strace.txt" | sed 's/^/  /'
  echo "  read it as: futex dominating => blocked on I/O, not computing."
  echo "              fsync dominating => commit/journal cost."
  echo
  echo "  child processes spawned:"
  grep -o 'execve("[^"]*"' "$OUT/strace.txt" | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'
else
  echo "  (strace not available; skipping)"
fi

echo
echo "=== 2. CPU profile: which frames ==="
rm -rf "$OUT/prof"; mkdir -p "$OUT/prof"
timeout 120 node --cpu-prof --cpu-prof-dir="$OUT/prof" "$CLI" \
  --model "$MODEL" --no-tools -p "$PROMPT" "$@" >/dev/null 2>&1
python3 - "$OUT/prof" <<'PY'
import collections, glob, json, sys
files = sorted(glob.glob(sys.argv[1] + "/*.cpuprofile"))
if not files:
    print("  no profile produced")
    raise SystemExit
p = json.load(open(files[-1]))
nodes = {n["id"]: n for n in p["nodes"]}
self_time = collections.Counter()
deltas, samples = p.get("timeDeltas") or [], p.get("samples") or []
for i, sid in enumerate(samples):
    self_time[sid] += deltas[i] if i < len(deltas) else 0
total = sum(self_time.values()) or 1
print(f"  total sampled: {total/1e6:.1f} s over {len(samples)} samples")
print("  (if this is far less than wall time, the process was blocked, not busy)")
for sid, us in self_time.most_common(25):
    if us / 1e6 < 0.05:
        break
    cf = nodes.get(sid, {}).get("callFrame", {})
    print(f"    {us/1e6:7.2f}s {100*us/total:5.1f}%  "
          f"{(cf.get('functionName') or '(anon)'):38.38s} "
          f"{(cf.get('url') or '').split('/')[-1]}:{cf.get('lineNumber', -1)}")
PY
echo
echo "  full profile: $OUT/prof/*.cpuprofile   (npx speedscope $OUT/prof/*.cpuprofile)"
echo
echo "  to profile a stall in a session already running:"
echo "    pgrep -af 'dist/bundle/cli.js'; kill -USR1 <pid>; then chrome://inspect"
