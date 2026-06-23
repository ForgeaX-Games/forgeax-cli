#!/usr/bin/env bash
# @desc Gateway integration tests — automated version of the manual test plan.
#
# Usage:  ./tests/gateway-integration.sh
# Requires: Gateway NOT running (script manages its own lifecycle).
# Exit code: 0 = all passed, 1 = failures.
set -uo pipefail

cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
FAILURES=""

STATE_DIR="${AGENTEAM_STATE_DIR:-$HOME/.agenteam}"
LOG="$STATE_DIR/gateway.log"
PID_FILE="$STATE_DIR/gateway.pid"
WORKER_DIR="$STATE_DIR/workers"
TOKEN=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE_DIR/gateway.json','utf-8')).token)}catch{}" 2>/dev/null)
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE_DIR/gateway.json','utf-8')).port||3700)}catch{console.log(3700)}" 2>/dev/null)
BASE="http://127.0.0.1:$PORT"
INSTANCE_ID=""

api() {
  local method=$1 path=$2
  shift 2
  curl -sf -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@" "$BASE$path" 2>/dev/null
}

pass() { ((PASS++)); printf "  ${GREEN}PASS${NC} %s\n" "$1"; }
fail() { ((FAIL++)); FAILURES="$FAILURES\n  - $1"; printf "  ${RED}FAIL${NC} %s\n" "$1"; }
skip() { ((SKIP++)); printf "  ${YELLOW}SKIP${NC} %s\n" "$1"; }
section() { printf "\n${BOLD}--- %s ---${NC}\n" "$1"; }

assert_eq() {
  local desc=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then pass "$desc"
  else fail "$desc (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local desc=$1 needle=$2 haystack=$3
  if echo "$haystack" | grep -q "$needle"; then pass "$desc"
  else fail "$desc (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local desc=$1 needle=$2 haystack=$3
  if echo "$haystack" | grep -q "$needle"; then fail "$desc (should not contain '$needle')"
  else pass "$desc"
  fi
}

wait_for_instance_running() {
  local max_wait=${1:-15}
  for i in $(seq 1 $max_wait); do
    local s
    s=$(api GET /health 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const i=j.instances?.find(x=>x.id==='$INSTANCE_ID');console.log(i?.status||'?')}catch{console.log('?')}})" 2>/dev/null)
    if [ "$s" = "running" ]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_for_worker_pid() {
  local max_wait=${1:-15}
  for i in $(seq 1 $max_wait); do
    local pid
    pid=$(cat "$WORKER_DIR/$INSTANCE_ID.pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return 0; fi
    sleep 1
  done
  return 1
}

shutdown_gateway() {
  api POST /api/shutdown >/dev/null 2>&1
  for i in $(seq 1 20); do
    [ ! -f "$PID_FILE" ] && return 0
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null)
    [ -z "$pid" ] && return 0
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
}

start_gateway() {
  > "$LOG"
  ./start.sh >/dev/null 2>&1
  sleep 2
  local health
  health=$(api GET /health 2>/dev/null)
  if echo "$health" | grep -q '"running"'; then
    INSTANCE_ID=$(echo "$health" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).instances[0]?.id||'')}catch{console.log('')}})" 2>/dev/null)
    return 0
  fi
  return 1
}

cleanup() {
  shutdown_gateway 2>/dev/null
}
trap cleanup EXIT

# ──────────────────────────────────────────────────────────────
printf "${BOLD}Gateway Integration Tests${NC}\n"
printf "State dir: $STATE_DIR\n"
printf "Port: $PORT\n"

# Ensure clean slate
shutdown_gateway 2>/dev/null
sleep 1

# ── A: start.sh ──────────────────────────────────────────────

section "A — start.sh"

if start_gateway; then
  pass "A1: Cold start succeeds"
else
  fail "A1: Cold start failed"
fi

if [ -n "$INSTANCE_ID" ]; then
  pass "A1: Instance discovered ($INSTANCE_ID)"
else
  fail "A1: No instance discovered"
fi

if wait_for_instance_running 15; then
  pass "A1: Instance reaches running state"
else
  fail "A1: Instance did not reach running state"
fi

# A2: Idempotent start (start.sh detects port in use → shutdown + restart)
OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
./start.sh >/dev/null 2>&1
sleep 3
NEW_PID=$(cat "$PID_FILE" 2>/dev/null)
if [ -n "$NEW_PID" ]; then
  pass "A2: Duplicate start.sh results in running Gateway"
else
  fail "A2: Gateway not running after duplicate start.sh"
fi
# Ensure instance still works
wait_for_instance_running 15 || true

# ── B: CLI Commands ──────────────────────────────────────────

section "B — CLI Commands"

# B1: Status
HEALTH=$(api GET /health)
assert_contains "B1: /health returns running" '"running"' "$HEALTH"
assert_contains "B1: /health includes instances" '"instances"' "$HEALTH"

INSTANCES=$(api GET /api/instances)
assert_contains "B1: /api/instances returns list" '"instances"' "$INSTANCES"

# B2: Lifecycle — stop
STOP_RESULT=$(api POST "/api/instances/$INSTANCE_ID/stop")
assert_contains "B2: stop returns stopped:true" '"stopped":true' "$STOP_RESULT"
sleep 1
STATUS_AFTER_STOP=$(api GET /health | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).instances.find(x=>x.id==='$INSTANCE_ID')?.status||'?')}catch{console.log('?')}})" 2>/dev/null)
assert_eq "B2: Status is stopped after stop" "stopped" "$STATUS_AFTER_STOP"

# B2: Lifecycle — start
START_RESULT=$(api POST "/api/instances/$INSTANCE_ID/start")
assert_contains "B2: start returns started:true" '"started":true' "$START_RESULT"
if wait_for_instance_running 15; then
  pass "B2: Instance running after start"
else
  fail "B2: Instance not running after start"
fi

# B2: Lifecycle — restart (soft)
RESTART_RESULT=$(api POST "/api/instances/$INSTANCE_ID/restart")
assert_contains "B2: restart returns restarted:true" '"restarted":true' "$RESTART_RESULT"
if wait_for_instance_running 15; then
  pass "B2: Instance running after restart"
else
  fail "B2: Instance not running after restart"
fi

# B3: Team operations
TEAM_INFO=$(api GET "/api/instances/$INSTANCE_ID/team")
assert_contains "B3: team info returns team data" '"teamId"' "$TEAM_INFO"

SAVE_RESULT=$(api POST "/api/instances/$INSTANCE_ID/team/save" -d '{"name":"ci-test-backup"}')
assert_contains "B3: save returns saved:true" '"saved":true' "$SAVE_RESULT"

TEAM_INFO_AFTER=$(api GET "/api/instances/$INSTANCE_ID/team")
assert_contains "B3: backup appears in list" '"ci-test-backup"' "$TEAM_INFO_AFTER"

# B4: /health endpoint is correct (regression for /api/status bug)
HEALTH_CHECK=$(curl -sf "$BASE/health" 2>/dev/null)
assert_contains "B4: /health endpoint works" '"status":"running"' "$HEALTH_CHECK"
NOT_FOUND=$(curl -sf "$BASE/api/status" 2>/dev/null || echo '{"error":"Not found"}')
assert_contains "B4: /api/status does not exist" '"error"' "$NOT_FOUND"

# B5: Auth check
UNAUTH=$(curl -sf "$BASE/api/instances" 2>/dev/null || echo '{"error":"Unauthorized"}')
assert_contains "B5: Unauthenticated request rejected" '"Unauthorized"' "$UNAUTH"

# ── C: Crash Recovery ────────────────────────────────────────

section "C — Crash Auto-Recovery"

# Ensure clean crash counters
shutdown_gateway; sleep 2; start_gateway; sleep 3
wait_for_instance_running 15
> "$LOG"

# C1: Single crash
WORKER_PID=$(wait_for_worker_pid 10)
if [ -n "$WORKER_PID" ]; then
  kill -9 "$WORKER_PID" 2>/dev/null
  sleep 8
  if wait_for_instance_running 10; then
    pass "C1: Instance recovers after single crash"
  else
    fail "C1: Instance did not recover after single crash"
  fi

  assert_contains "C1: Log shows hard-restart attempt 1" "attempt 1/5" "$(cat "$LOG")"
  assert_contains "C1: Log shows successful recovery" "hard-restarted successfully" "$(cat "$LOG")"

  NEW_WORKER_PID=$(cat "$WORKER_DIR/$INSTANCE_ID.pid" 2>/dev/null)
  if [ "$NEW_WORKER_PID" != "$WORKER_PID" ] && [ -n "$NEW_WORKER_PID" ]; then
    pass "C1: Worker PID changed ($WORKER_PID -> $NEW_WORKER_PID)"
  else
    fail "C1: Worker PID did not change"
  fi
else
  skip "C1: Could not find worker PID"
fi

# C2: Consecutive crashes — verify backoff
shutdown_gateway; sleep 2; start_gateway; sleep 3
wait_for_instance_running 15
> "$LOG"

CRASH_OK=true
for attempt in 1 2 3; do
  WP=$(wait_for_worker_pid 20)
  if [ -z "$WP" ]; then CRASH_OK=false; break; fi
  kill -9 "$WP" 2>/dev/null
  sleep 2
done

sleep 30
LOG_CONTENT=$(cat "$LOG")

if $CRASH_OK; then
  if echo "$LOG_CONTENT" | grep -q "attempt 1/5" && echo "$LOG_CONTENT" | grep -q "attempt 2/5"; then
    pass "C2: Backoff escalation visible (attempt 1 and 2)"
  else
    fail "C2: Backoff escalation not visible in logs"
  fi
else
  fail "C2: Could not execute consecutive kills"
fi

# C3: Exceed MAX_RESTARTS
shutdown_gateway; sleep 2; start_gateway; sleep 3
wait_for_instance_running 15
> "$LOG"

for i in $(seq 1 7); do
  WP=$(wait_for_worker_pid 20)
  if [ -n "$WP" ]; then kill -9 "$WP" 2>/dev/null; fi
  sleep 1
done

sleep 80
LOG_CONTENT=$(cat "$LOG")

assert_contains "C3: Log shows 'Giving up'" "Giving up" "$LOG_CONTENT"

GW_HEALTH=$(api GET /health 2>/dev/null)
assert_contains "C3: Gateway itself still healthy" '"running"' "$GW_HEALTH"

# C4: Counter reset after stable period
shutdown_gateway; sleep 2; start_gateway; sleep 3
wait_for_instance_running 15
> "$LOG"

WP=$(wait_for_worker_pid 10)
if [ -n "$WP" ]; then
  kill -9 "$WP" 2>/dev/null
  sleep 8
  wait_for_instance_running 15

  sleep 65

  WP2=$(wait_for_worker_pid 10)
  if [ -n "$WP2" ]; then
    kill -9 "$WP2" 2>/dev/null
    sleep 8

    SECOND_CRASH_LINES=$(grep "attempt 1/5" "$LOG" | wc -l)
    if [ "$SECOND_CRASH_LINES" -ge 2 ]; then
      pass "C4: Counter reset — two separate 'attempt 1/5' entries"
    else
      fail "C4: Counter did not reset (only $SECOND_CRASH_LINES 'attempt 1/5' lines)"
    fi
  else
    fail "C4: Could not get worker PID after stable period"
  fi
else
  skip "C4: Could not find initial worker PID"
fi

# ── D: Admin UI ──────────────────────────────────────────────

section "D — Admin UI"

shutdown_gateway; sleep 2; start_gateway; sleep 3

ADMIN_HTML=$(curl -sf "$BASE/admin" 2>/dev/null)
assert_contains "D1: Admin UI serves HTML" "<!doctype html>" "$ADMIN_HTML"
assert_contains "D1: Admin UI title present" "AgenTeam Admin" "$ADMIN_HTML"

UNAUTH_API=$(curl -sf "$BASE/api/instances" 2>/dev/null || echo "Unauthorized")
assert_contains "D2: API without token is rejected" "Unauthorized" "$UNAUTH_API"

AUTH_API=$(api GET /api/instances)
assert_contains "D2: API with token returns data" '"instances"' "$AUTH_API"

# ── Summary ──────────────────────────────────────────────────

section "Summary"
TOTAL=$((PASS + FAIL + SKIP))
printf "\n  ${GREEN}$PASS passed${NC}  ${RED}$FAIL failed${NC}  ${YELLOW}$SKIP skipped${NC}  ($TOTAL total)\n"

if [ $FAIL -gt 0 ]; then
  printf "\n${RED}Failures:${NC}$FAILURES\n"
  exit 1
fi

printf "\n${GREEN}All tests passed.${NC}\n"
exit 0
