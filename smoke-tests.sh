#!/usr/bin/env bash
# OpenClaude smoke tests — exercises the agent end-to-end and verifies expected DB state.
# Run before pushing to main. Defaults to localhost; override with AGENT_URL=https://... for prod check.
#
# Usage:
#   chmod +x smoke-tests.sh
#   ./smoke-tests.sh                 # against http://localhost:10000 (default)
#   AGENT_URL=https://openclaude-agent.onrender.com ./smoke-tests.sh
#
# Env vars required (export before running, or put in .env.smoke):
#   NC_TOKEN  — NocoDB API token
#   NC_URL    — NocoDB base URL (default: https://openclaude-nocodb.onrender.com)
#   PEOPLE_TABLE_ID    — default mciuo6qr841ald4
#   TOUCHPOINTS_TABLE_ID — default m43ehtpo0gs8wi6
#
# Tests are designed to be self-cleaning. Each test creates a unique smoke-test record,
# verifies state, deletes the record. Safe to run against production.

set -uo pipefail

# Load .env.smoke if present
if [ -f "$(dirname "$0")/.env.smoke" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/.env.smoke"
  set +a
fi

AGENT_URL="${AGENT_URL:-http://localhost:10000}"
NC_URL="${NC_URL:-https://openclaude-nocodb.onrender.com}"
NC_TOKEN="${NC_TOKEN:-}"
PEOPLE_TABLE_ID="${PEOPLE_TABLE_ID:-mciuo6qr841ald4}"
TOUCHPOINTS_TABLE_ID="${TOUCHPOINTS_TABLE_ID:-m43ehtpo0gs8wi6}"

if [ -z "$NC_TOKEN" ]; then
  echo "ERROR: NC_TOKEN not set. Export it or put it in .env.smoke" >&2
  exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track pass/fail
PASS=0
FAIL=0
FAILURES=()
START_TIME=$(date +%s)

# Generate unique suffix so concurrent test runs don't collide
SUFFIX="smoke-$(date +%s)-$$"

# --- Helpers ---

agent_run() {
  local transcript="$1"
  curl -sS -X POST -H "Content-Type: application/json" \
    "$AGENT_URL/run" \
    -d "$(jq -nc --arg t "$transcript" '{transcript: $t}')" \
    --max-time 60
}

nc_get() {
  local path="$1"
  curl -sS -H "xc-token: $NC_TOKEN" "$NC_URL$path" --max-time 15
}

nc_delete_records() {
  local table_id="$1"
  local id_list="$2" # JSON array of {Id} objects
  if [ -n "$id_list" ] && [ "$id_list" != "[]" ]; then
    curl -sS -X DELETE -H "xc-token: $NC_TOKEN" -H "Content-Type: application/json" \
      "$NC_URL/api/v2/tables/$table_id/records" \
      -d "$id_list" --max-time 15 > /dev/null
  fi
}

cleanup_smoke_records() {
  # Delete any People with email containing 'smoke-' (this run + any leftovers from previous runs)
  local people_ids
  people_ids=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,like,%%25smoke-%%25)' | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=100" \
    | jq -c '[.list[].Id | {Id: .}]')
  nc_delete_records "$PEOPLE_TABLE_ID" "$people_ids"

  # Touchpoints with 'smoke-' in content
  local tp_ids
  tp_ids=$(nc_get "/api/v2/tables/$TOUCHPOINTS_TABLE_ID/records?limit=100&sort=-CreatedAt" \
    | jq -c '[.list[] | select(.Content // "" | contains("smoke-")) | {Id: .Id}]')
  nc_delete_records "$TOUCHPOINTS_TABLE_ID" "$tp_ids"
}

assert() {
  local label="$1"
  local condition="$2"
  if [ "$condition" = "true" ] || [ "$condition" = "1" ]; then
    echo -e "  ${GREEN}✓${NC} $label"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}✗${NC} $label"
    FAIL=$((FAIL+1))
    FAILURES+=("$label")
  fi
}

run_test() {
  local name="$1"
  echo -e "${BLUE}» $name${NC}"
}

# --- Pre-flight ---

echo -e "${YELLOW}OpenClaude smoke tests${NC}"
echo "  Agent: $AGENT_URL"
echo "  NocoDB: $NC_URL"
echo "  Suffix: $SUFFIX"
echo ""

# Health check
echo -e "${BLUE}» Health check${NC}"
HEALTH=$(curl -sS --max-time 5 "$AGENT_URL/healthz" || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo -e "  ${GREEN}✓${NC} Agent reachable"
else
  echo -e "  ${RED}✗${NC} Agent not reachable at $AGENT_URL"
  echo "  Response: $HEALTH"
  exit 1
fi

# --- Test 1: Create person + cohort link ---

run_test "Test 1: create_person + cohort link"
EMAIL_1="${SUFFIX}-alpha@test.example"
RESP=$(agent_run "Add Alpha Test ${SUFFIX} to May 9 cohort. Email ${EMAIL_1}. Paid in full \$4500. Welcome email sent.")
OK=$(echo "$RESP" | jq -r '.ok')
assert "Agent returned ok=true" "$OK"

PERSON=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EMAIL_1" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=1")
PERSON_ID=$(echo "$PERSON" | jq -r '.list[0].Id // empty')
assert "Person created in NocoDB" "$([ -n "$PERSON_ID" ] && echo true || echo false)"

COHORT_NAME=$(echo "$PERSON" | jq -r '.list[0]["Cohort name"][0] // empty')
assert "Linked to May 9 2026 cohort" "$([ "$COHORT_NAME" = "May 9 2026" ] && echo true || echo false)"

PAID_FULL=$(echo "$PERSON" | jq -r '.list[0]["10. Paid in full"]')
DEPOSIT_PAID=$(echo "$PERSON" | jq -r '.list[0]["2. Deposit paid"]')
assert "Stage 10 (Paid in full) set" "$PAID_FULL"
assert "Stage 2 (Deposit paid) cascaded from paid_in_full" "$DEPOSIT_PAID"

WELCOME=$(echo "$PERSON" | jq -r '.list[0]["3. Welcome email sent"]')
assert "Stage 3 (Welcome email sent) explicit" "$WELCOME"

# --- Test 2: stage cascade narrowness — toggling stage 4 should NOT cascade stage 1 ---

run_test "Test 2: stage cascade is narrow (no over-cascading)"
EMAIL_2="${SUFFIX}-beta@test.example"
agent_run "Add Beta Test ${SUFFIX} to May 10 cohort, ${EMAIL_2}. Mark form submitted." > /dev/null

P2=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EMAIL_2" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=1")
S1=$(echo "$P2" | jq -r '.list[0]["1. Onboarding call done"]')
S3=$(echo "$P2" | jq -r '.list[0]["3. Welcome email sent"]')
S4=$(echo "$P2" | jq -r '.list[0]["4. Form submitted"]')
S5=$(echo "$P2" | jq -r '.list[0]["5. Contract sent"]')

assert "Stage 4 (Form submitted) is true" "$S4"
assert "Stage 3 (Welcome email sent) cascaded from stage 4" "$S3"
assert "Stage 1 (Onboarding call) is FALSE (no over-cascade)" "$([ "$S1" = "false" ] && echo true || echo false)"
assert "Stage 5 (Contract sent) is FALSE (no forward cascade)" "$([ "$S5" = "false" ] && echo true || echo false)"

# --- Test 3: update existing — idempotency ---

run_test "Test 3: update path (idempotency, no duplicate creation)"
agent_run "Update on Alpha Test ${SUFFIX} (${EMAIL_1}): note that they confirmed attendance." > /dev/null

DUPS=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EMAIL_1" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=10" \
  | jq -r '.pageInfo.totalRows')
assert "No duplicate created (still 1 record)" "$([ "$DUPS" = "1" ] && echo true || echo false)"

# --- Test 4: list_people query (uses a filter the tool actually supports) ---

run_test "Test 4: list_people query returns May 9 cohort records"
RESP=$(agent_run "Show me everyone in the May 9 cohort.")
USED=$(echo "$RESP" | jq -r '[.trace[].tool] | map(select(. == "list_people")) | length')
SUMMARY=$(echo "$RESP" | jq -r '.summary // ""')
assert "Agent called list_people" "$([ "$USED" -gt 0 ] && echo true || echo false)"
assert "Response mentions Alpha Test (smoke record in May 9)" "$(echo "$SUMMARY" | grep -qi "alpha test" && echo true || echo false)"

# --- Test 5: list_recent_actions audit query ---

run_test "Test 5: list_recent_actions returns recent agent activity"
RESP=$(agent_run "What have you done in the last hour?")
USED_AUDIT=$(echo "$RESP" | jq -r '[.trace[].tool] | map(select(. == "list_recent_actions")) | length')
assert "Agent called list_recent_actions" "$([ "$USED_AUDIT" -gt 0 ] && echo true || echo false)"

# --- Test 6: genuinely ambiguous query → agent asks for info (any form) ---
# Claude may use the ask_for_clarification tool OR respond conversationally with a question.
# Both are correct user-facing behavior — we accept either by checking the response language.

run_test "Test 6: ambiguous query → agent asks for missing info"
RESP=$(agent_run "Update their email please.")
SUMMARY=$(echo "$RESP" | jq -r '.summary // ""')
NEEDS_CLAR=$(echo "$RESP" | jq -r '.clarification_needed // false')
DID_NO_DAMAGE=$(echo "$RESP" | jq -r '[.trace[].tool] | map(select(. == "create_person" or . == "update_person" or . == "update_payment" or . == "toggle_stage")) | length')
ASKED_FOR_INFO=$(echo "$SUMMARY" | grep -qiE "who|whose|which person|need (more|additional) (info|details|context)|clarif|don't have enough|specify" && echo "true" || echo "false")

assert "Agent did NOT mutate any records" "$([ "$DID_NO_DAMAGE" = "0" ] && echo true || echo false)"
assert "Agent asked for clarifying info (tool or text)" "$([ "$NEEDS_CLAR" = "true" ] || [ "$ASKED_FOR_INFO" = "true" ] && echo true || echo false)"

# --- Test 7: email transcription repair ---

run_test "Test 7: email transcription repair (dot/at → @)"
EMAIL_GMAIL="${SUFFIX}-gamma.gmail.com"  # malformed (missing @)
agent_run "Add Gamma Test ${SUFFIX} to May 9. Email is ${EMAIL_GMAIL}." > /dev/null
sleep 1
EXPECTED="${SUFFIX}-gamma@gmail.com"
P_GAMMA=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EXPECTED" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=1")
GAMMA_ID=$(echo "$P_GAMMA" | jq -r '.list[0].Id // empty')
assert "Email repaired to ${EXPECTED}" "$([ -n "$GAMMA_ID" ] && echo true || echo false)"

# --- Cleanup ---

echo ""
echo -e "${BLUE}» Cleanup${NC}"
cleanup_smoke_records
echo "  Deleted smoke-test records"

# --- Summary ---

ELAPSED=$(($(date +%s) - START_TIME))
echo ""
echo -e "${YELLOW}Results${NC}"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Duration: ${ELAPSED}s"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo -e "${RED}Failures:${NC}"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo -e "${GREEN}All tests passed.${NC}"
exit 0
