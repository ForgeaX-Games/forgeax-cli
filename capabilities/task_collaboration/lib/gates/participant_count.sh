#!/usr/bin/env bash
# @desc Builtin gate: pass when state.participants.length >= MIN.
# Args: <min>
# Env: TASK_ID, TASK_DIR (relative to cwd = team/shared-workspace/)
# stdout: "<count>/<min>"

set -uo pipefail
MIN="${1:?usage: participant_count.sh <min>}"
STATE="${TASK_DIR:?TASK_DIR env required}/state.json"

if [[ ! -f "$STATE" ]]; then
  echo "0/$MIN"
  exit 1
fi

COUNT="$(jq '.participants | length' "$STATE" 2>/dev/null)"
if [[ -z "$COUNT" ]]; then
  echo "parse-error"
  exit 1
fi

echo "$COUNT/$MIN"
if (( COUNT >= MIN )); then
  exit 0
fi
exit 1
