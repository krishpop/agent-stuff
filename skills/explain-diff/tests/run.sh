#!/usr/bin/env bash
# Run every explain-diff test: renderer (node), config chains (python), Hunk end to end (skips without hunk).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
rc=0
echo "== lesson.mjs";      node --test "$HERE/test_lesson.mjs" 2>&1 | grep -E "^(ℹ (pass|fail)|✖)" || rc=1
node --test "$HERE/test_lesson.mjs" >/dev/null 2>&1 || rc=1
echo "== config_chain.py"; python3 "$HERE/test_config_chain.py" 2>&1 | tail -1; python3 "$HERE/test_config_chain.py" >/dev/null 2>&1 || rc=1
echo "== hunk e2e";        bash "$HERE/hunk_e2e.sh" || rc=1
[ $rc = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $rc
