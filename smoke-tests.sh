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
PEOPLE_TABLE_ID="${PEOPLE_TABLE_ID:-}"
TOUCHPOINTS_TABLE_ID="${TOUCHPOINTS_TABLE_ID:-}"
OPENCLAUDE_ENV="${OPENCLAUDE_ENV:-}"
RUN_SHARED_SECRET="${RUN_SHARED_SECRET:-}"

# === Safety guards ===
# Refuse to run unless we're explicitly in test mode (avoids accidentally
# polluting prod data + audit log when env file is misconfigured).
if [ "$OPENCLAUDE_ENV" != "test" ]; then
  echo "ERROR: smoke tests refuse to run unless OPENCLAUDE_ENV=test." >&2
  echo "  Set this in .env.smoke (use the 'Operations Test' base, not production)." >&2
  exit 1
fi

# Refuse to run against the known production tables.
PROD_PEOPLE="mciuo6qr841ald4"
PROD_TOUCHPOINTS="m43ehtpo0gs8wi6"
PROD_AGENT_ACTIONS="mkifqf7pr88ytsp"
if [ "$PEOPLE_TABLE_ID" = "$PROD_PEOPLE" ] || \
   [ "$TOUCHPOINTS_TABLE_ID" = "$PROD_TOUCHPOINTS" ] || \
   [ "${AGENT_ACTIONS_TABLE_ID:-}" = "$PROD_AGENT_ACTIONS" ]; then
  echo "ERROR: smoke tests refuse to run against production table IDs." >&2
  echo "  Use Operations Test base IDs in .env.smoke." >&2
  exit 1
fi

# Refuse to run against the production agent URL.
if [[ "$AGENT_URL" == *"openclaude-agent.onrender.com"* ]]; then
  echo "ERROR: smoke tests refuse to run against the production agent URL." >&2
  echo "  Run the agent locally (npm start) and target http://localhost:10000." >&2
  exit 1
fi

if [ -z "$NC_TOKEN" ] || [ -z "$PEOPLE_TABLE_ID" ] || [ -z "$TOUCHPOINTS_TABLE_ID" ]; then
  echo "ERROR: NC_TOKEN, PEOPLE_TABLE_ID, TOUCHPOINTS_TABLE_ID must be set." >&2
  echo "  Copy .env.smoke.example to .env.smoke and fill in." >&2
  exit 1
fi

if [ -z "$RUN_SHARED_SECRET" ]; then
  echo "ERROR: RUN_SHARED_SECRET must be set (the agent now requires auth on /run)." >&2
  echo "  Use the same value the local agent process is started with." >&2
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
  curl -sS -X POST \
    -H "Content-Type: application/json" \
    -H "X-Run-Secret: $RUN_SHARED_SECRET" \
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

echo -e "${YELLOW}Compass smoke tests${NC}"
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

# --- Test 8: confirmation gating on update_payment ---
# Verifies that a payment-amount change does NOT execute on the first call —
# the agent must ask for confirmation and leave the record untouched.

run_test "Test 8: update_payment is confirmation-gated (no first-call mutation)"
EMAIL_DELTA="${SUFFIX}-delta@test.example"
agent_run "Add Delta Test ${SUFFIX} to May 9. Email ${EMAIL_DELTA}. \$2000 deposit paid." > /dev/null
sleep 1
P_DELTA_BEFORE=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EMAIL_DELTA" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=1")
DELTA_PAID_BEFORE=$(echo "$P_DELTA_BEFORE" | jq -r '.list[0]["Amount paid"] // 0')

RESP=$(agent_run "Update Delta Test ${SUFFIX}'s payment to \$5000 paid in full.")
SUMMARY=$(echo "$RESP" | jq -r '.summary // ""')
# Confirmation-required result should appear in the trace
GATED=$(echo "$RESP" | jq -r '[.trace[] | select(.tool == "update_payment") | .result.status // ""] | map(select(. == "confirmation_required")) | length')
P_DELTA_AFTER=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,eq,%s)' "$EMAIL_DELTA" | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=1")
DELTA_PAID_AFTER=$(echo "$P_DELTA_AFTER" | jq -r '.list[0]["Amount paid"] // 0')

assert "update_payment returned confirmation_required (didn't execute)" "$([ "$GATED" -gt 0 ] && echo true || echo false)"
assert "Amount paid unchanged (gate held)" "$([ "$DELTA_PAID_BEFORE" = "$DELTA_PAID_AFTER" ] && echo true || echo false)"
assert "Reply mentions confirmation/preview" "$(echo "$SUMMARY" | grep -qiE "confirm|approve|sure|go ahead|preview" && echo true || echo false)"

# --- Test 9: confirmation gating on bulk/destructive ops ---
# Asks for a sweeping update; agent must NOT execute without explicit confirmation.

run_test "Test 9: bulk_update_records is confirmation-gated"
# Pre-count: how many smoke records exist (should be at least 3 from previous tests)
PRE_COUNT=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,like,%%25smoke-%%25)' | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=100" | jq -r '.pageInfo.totalRows')

RESP=$(agent_run "Set Status to 'Archived' on every person whose email contains '${SUFFIX}'.")
DESTRUCTIVE_USED=$(echo "$RESP" | jq -r '[.trace[] | select(.tool == "bulk_update_records" or .tool == "update_person" or .tool == "delete_records") | .result.status // ""] | map(select(. == "confirmation_required")) | length')
EXECUTED=$(echo "$RESP" | jq -r '[.trace[] | select(.tool == "bulk_update_records" or .tool == "delete_records") | .result.ok // false] | map(select(. == true)) | length')

# Verify counts unchanged (no records vanished, no rogue archive sweep)
POST_COUNT=$(nc_get "/api/v2/tables/$PEOPLE_TABLE_ID/records?where=$(printf '(Primary email,like,%%25smoke-%%25)' | python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read()))')&limit=100" | jq -r '.pageInfo.totalRows')
assert "Bulk/destructive op did not execute on first call" "$([ "$EXECUTED" = "0" ] && echo true || echo false)"
assert "Smoke record count unchanged ($PRE_COUNT == $POST_COUNT)" "$([ "$PRE_COUNT" = "$POST_COUNT" ] && echo true || echo false)"

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
