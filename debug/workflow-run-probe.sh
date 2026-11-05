#!/usr/bin/env bash
# Is a pi-workflows run actually alive? Answers in one second, exits non-zero if not.
#
# WHY THIS EXISTS. A run whose worker crashes during bootstrap sits at status `queued` with
# consecutive_errors 0 and NOTHING in any log — the host's stderr is /dev/null. It looks idle. It
# is not: the host re-claims the lease every ~2s forever. One such run logged 3,983 park/claim
# cycles over 130 minutes before anyone looked (2026-09-01, cause: the `workflow` tool serializes
# `input` to a JSON string and the workflow's parseInput threw "input must be an object").
#
# Usage:
#   workflow-run-probe.sh                 # newest run
#   workflow-run-probe.sh <run-id-or-substring>
#   workflow-run-probe.sh <id> --wait 90  # poll until initialized, or fail after N seconds
#
# Exit: 0 healthy/finished · 1 park-loop or failed · 2 still un-started past --wait
set -uo pipefail

DB="${PI_WORKFLOWS_DB:-$HOME/.pi/agent/workflows/state.sqlite}"
[ -r "$DB" ] || { echo "no workflow db at $DB" >&2; exit 1; }

MATCH="${1:-}"; [ "${MATCH:0:2}" = "--" ] && MATCH=""
WAIT=0; [ "${2:-}" = "--wait" ] && WAIT="${3:-90}"; [ "${1:-}" = "--wait" ] && WAIT="${2:-90}"

q() { sqlite3 "$DB" "$1"; }

RUN=$(q "select run_id from runs where run_id like '%${MATCH}%' order by created_at desc limit 1;")
[ -n "$RUN" ] || { echo "no run matching '${MATCH}'" >&2; exit 1; }
RES=$(q "select resource_id from runs where run_id='${RUN}';")

deadline=$(( $(date +%s) + WAIT ))
while :; do
  STATUS=$(q "select status from runs where run_id='${RUN}';")
  QSTATUS=$(q "select status from run_queue where run_id='${RUN}';")
  INIT=$(q "select count(*) from events where resource_id='${RES}' and event_type='run_initialized';")
  PARKS=$(q "select count(*) from events where resource_id='${RES}' and event_type='run.queue_parked';")

  if [ "$INIT" -gt 0 ] || [ "$STATUS" = "completed" ] || [ "$STATUS" = "cancelled" ]; then
    echo "$RUN  status=$STATUS queue=$QSTATUS initialized=$([ "$INIT" -gt 0 ] && echo yes || echo no) parks=$PARKS"
    [ "$PARKS" -gt 3 ] && echo "note: ${PARKS} parks — this run crash-looped before it reached terminal state"
    if [ "$STATUS" = "failed" ]; then
      echo "--- last error:"
      q "select cast(b.content as text) from events e join blobs b on b.blob_hash=e.payload_hash
         where e.resource_id='${RES}' and e.event_type in ('node_failed','run_failed')
         order by e.event_seq desc limit 2;"
      exit 1
    fi
    exit 0
  fi

  # Not initialized. More than a couple of parks means the worker is crash-looping, not waiting.
  if [ "$PARKS" -gt 3 ]; then
    echo "PARK LOOP: $RUN parked ${PARKS}x and never initialized (status=$STATUS queue=$QSTATUS)" >&2
    echo "The worker is dying during bootstrap. Host stderr is /dev/null, so reproduce it by hand:" >&2
    echo "  sqlite3 \"$DB\" \"select cast(b.content as text) from runs r join blobs b on b.blob_hash=r.input_hash where r.run_id='$RUN';\" > /tmp/in.json" >&2
    echo "  # if that prints a QUOTED STRING rather than an object, the input was double-serialized" >&2
    echo "  # then run the workflow's own input parser over it (see debug-pi SKILL.md Part 1b)" >&2
    echo "Cancel it before it logs thousands more events: pi workflow cancel, or the workflow tool." >&2
    exit 1
  fi

  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 3
done

echo "NOT STARTED: $RUN status=$STATUS queue=$QSTATUS initialized=no parks=$PARKS after ${WAIT}s" >&2
exit 2
