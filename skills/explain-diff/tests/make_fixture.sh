#!/usr/bin/env bash
# Build the "retry" fixture repo: one commit, then an uncommitted change to two files.
# usage: make_fixture.sh <dir>
set -euo pipefail
F=${1:?usage: make_fixture.sh <dir>}
rm -rf "$F"; mkdir -p "$F/src" "$F/configs"; cd "$F"
git init -q -b main; git config user.email fixture@example.com; git config user.name fixture
cat > src/fetch.py <<'PY'
import time


def fetch_user(client, user_id):
    resp = client.get(f"/users/{user_id}")
    return resp.json()
PY
printf 'optimizer:\n  lr: 0.001\n  warmup_steps: 500\ntrainer:\n  max_iters: 30000\n' > configs/train.yaml
git add -A; git commit -qm base
cat > src/fetch.py <<'PY'
import time

RETRYABLE = (TimeoutError, ConnectionError)


def fetch_user(client, user_id, attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            resp = client.get(f"/users/{user_id}")
            return resp.json()
        except RETRYABLE:
            if attempt == attempts:
                raise
            time.sleep(0.1 * attempt)
PY
python3 -c "from pathlib import Path; p = Path('configs/train.yaml'); p.write_text(p.read_text().replace('warmup_steps: 500', 'warmup_steps: 1000'))"
echo "$F"
