#!/usr/bin/env bash
# @desc Builtin gate: pass when tasks/<task_id>/state.json status equals <expected>.
# Args: <task_id> <expected_status>
# stdout: current status (or "missing")

set -uo pipefail
TID="${1:?usage: task_status.sh <task_id> <expected>}"
EXPECTED="${2:?usage: task_status.sh <task_id> <expected>}"
STATE="tasks/$TID/state.json"

if [[ ! -f "$STATE" ]]; then
  echo "missing"
  exit 1
fi

STATUS="$(jq -r '.status // "unknown"' "$STATE" 2>/dev/null)"
echo "$STATUS"
if [[ "$STATUS" == "$EXPECTED" ]]; then
  exit 0
fi
exit 1
