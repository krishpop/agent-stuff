#!/usr/bin/env bash
# End-to-end: the lesson's Hunk outputs load into a real Hunk session.
# Runs Hunk in a private, detached tmux server (never the user's terminal), then checks it through
# `hunk session` commands. Skips (exit 0) when hunk or tmux is missing.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); S="$HERE/../scripts"
command -v hunk >/dev/null && command -v tmux >/dev/null || { echo "skip: needs hunk and tmux"; exit 0; }
W=$(mktemp -d); R="$W/retry"; T="tmux -L explain-diff-e2e"
"$HERE/make_fixture.sh" "$R" >/dev/null
node "$S/lesson.mjs" collect --git --repo "$R" --out "$W" >/dev/null
node "$S/lesson.mjs" render "$HERE/fixtures/retry/lesson.json" --changeset "$W/changeset.json" \
  --sidecar "$W/sidecar.json" --guide "$W/guide.json" --comments "$W/comments.json" >/dev/null || { echo "FAIL: render"; exit 1; }
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
start() {  # start <env-prefix> <hunk args...>
  $T kill-server 2>/dev/null
  $T new-session -d -s ed -x 220 -y 60 -c "$R" "$1 hunk ${*:2}; sleep 120"
  for _ in $(seq 1 40); do
    [ "$(cd "$R" && hunk session list --json 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["sessions"]))' 2>/dev/null)" = 1 ] && return 0
    sleep 0.5
  done
  echo "FAIL: hunk did not register a session"; $T capture-pane -p -t ed | tail -5; return 1
}
review() { (cd "$R" && hunk session review --repo . --json); }
order() { review | python3 -c 'import json,sys;print(" ".join(f["path"] for f in json.load(sys.stdin)["review"]["files"]))'; }
notes() { review | python3 -c 'import json,sys;print(json.load(sys.stdin)["review"].get("reviewNoteCount",0))'; }
cd "$R" || exit 1

# 1. A new window: sidecar in story order, notes attached, hunk-guide pane from the guide file.
start "HUNK_GUIDE_FILE=$W/guide.json" diff --agent-context "$W/sidecar.json" --agent-notes || exit 1
check "sidecar puts files in story order" '[ "$(order)" = "src/fetch.py configs/train.yaml" ]'
check "one note per step target" '[ "$(notes)" = 4 ]'
if hunk extension list 2>/dev/null | grep -q hunk-guide; then
  sleep 1; check "hunk-guide pane shows the lesson" '$T capture-pane -p -t ed | grep -q "fetch_user retries"'
else echo "skip hunk-guide pane (not installed)"; fi

# 2. An open window: reload with a sidecar under .git/explain-diff/ (reload refuses paths outside the repo).
start "" diff || exit 1
mkdir -p .git/explain-diff && cp "$W/sidecar.json" .git/explain-diff/sidecar.json
check "reload accepts the sidecar under .git/" 'hunk session reload --repo . --json -- diff --agent-context "$R/.git/explain-diff/sidecar.json" >/dev/null'
sleep 1
check "reload applied the story order" '[ "$(order)" = "src/fetch.py configs/train.yaml" ]'
check ".git/explain-diff stays out of the review" '! order | grep -q explain-diff'

# 3. Live notes, navigation, and an attention mark on the step-1 highlight.
check "comment batch applies" 'hunk session comment apply --repo . --stdin --json < "$W/comments.json" | grep -q "\"applied\""'
check "navigate to step 2" 'hunk session navigate --repo . --file src/fetch.py --new-line 6 --json >/dev/null'
line=$(sed -n 3p src/fetch.py); hl="(TimeoutError, ConnectionError)"; pre=${line%%"$hl"*}
check "highlight the step-1 expression" 'hunk session highlight add --repo . --file src/fetch.py --new-line 3 --start ${#pre} --end $(( ${#pre} + ${#hl} )) --tone current --focus --json >/dev/null'

$T kill-server 2>/dev/null
rm -rf "$W"
[ $fail = 0 ] && echo "hunk e2e: pass" || echo "hunk e2e: FAIL"
exit $fail
