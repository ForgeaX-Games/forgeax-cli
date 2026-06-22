#!/usr/bin/env bash
# @desc Builtin gate: pass when tasks/<task_id>/state.json status == "active". Useful for mutual-exclusion gates.
# Args: <task_id>
# stdout: current status (or "missing")

set -uo pipefail
TID="${1:?usage: task_active.sh <task_id>}"
STATE="tasks/$TID/state.json"

if [[ ! -f "$STATE" ]]; then
  echo "missing"
  exit 1
fi

STATUS="$(jq -r '.status // "unknown"' "$STATE" 2>/dev/null)"
echo "$STATUS"
if [[ "$STATUS" == "active" ]]; then
  exit 0
fi
exit 1
