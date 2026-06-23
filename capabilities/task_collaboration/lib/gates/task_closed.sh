#!/usr/bin/env bash
# @desc Builtin gate: pass when tasks/<task_id>/state.json is in any TERMINAL status (completed | closed | failed).
# Args: <task_id>
# stdout: current status (or "missing")
#
# Use this when one task should only become ready once another task has finished — regardless of
# whether the other one succeeded (completed), was archived without success (closed), or failed.

set -uo pipefail
TID="${1:?usage: task_closed.sh <task_id>}"
STATE="tasks/$TID/state.json"

if [[ ! -f "$STATE" ]]; then
  echo "missing"
  exit 1
fi

STATUS="$(jq -r '.status // "unknown"' "$STATE" 2>/dev/null)"
echo "$STATUS"
case "$STATUS" in
  completed|closed|failed) exit 0 ;;
  *) exit 1 ;;
esac
