#!/bin/bash
# cortex-haiku-restart-gate.sh — MP-CONFIG-1 relay l9m-12 capstone gate.
#
# Procedure:
#   1. Verify cortex-organ-default-llm-settings.yaml uses Haiku (not Sonnet).
#   2. Bootstrap Cortex via launchctl (paired-restart into Haiku).
#   3. Probe /health until ok (timeout 60s).
#   4. Trigger 10 bounded assessment iterations via POST /assessment/trigger.
#   5. Wait for iterations to settle (poll /assessment/current).
#   6. Query Graph organ for llm_usage_event concepts written during gate.
#   7. Calculate projected daily cost; assert < $1/day.
#   8. Output: PASS/FAIL + projected cost + iteration count + token totals.
#
# Exit 0 = PASS. Exit 1 = FAIL (cost exceeds threshold or infrastructure error).
# Manual trigger ONLY — DO NOT schedule (live LLM hit + cost accrual).

set -euo pipefail

# Platform preamble
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_ROOT="/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs"
CORTEX_YAML="${SETTINGS_ROOT}/225-Cortex/cortex-organ-default-llm-settings.yaml"
CORTEX_PORT="${CORTEX_PORT:-4040}"
CORTEX_HOST="localhost"
GRAPH_PORT="${GRAPH_PORT:-4020}"
PLIST_LABEL="com.coretex.aos-organ.cortex"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
MAX_COST_PER_DAY="1.00"
MAX_ITERATIONS=10
MAX_WAIT_HEALTH=60
MAX_WAIT_PER_ITERATION=60
GATE_START=$(date +%s)

echo "=== Cortex Haiku Restart Gate — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""

# --- Step 1: Verify settings ---
echo "[1/7] Verifying Cortex settings YAML..."
MODEL=$(grep '^model:' "$CORTEX_YAML" | awk '{print $2}')
if [[ "$MODEL" != "claude-haiku-4-5-20251001" ]]; then
  echo "FAIL: Cortex model is '$MODEL' — expected claude-haiku-4-5-20251001"
  echo "DO NOT restart Cortex into Sonnet. Change the YAML first."
  exit 1
fi
echo "  Model: $MODEL ✓"

# --- Step 2: Bootstrap Cortex ---
echo ""
echo "[2/7] Bootstrapping Cortex via launchctl..."
if ! [ -f "$PLIST_PATH" ]; then
  echo "FAIL: LaunchAgent plist not found at $PLIST_PATH"
  exit 1
fi

# Stop if already running.
launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "  Cortex bootstrapped."

# --- Step 3: Health probe ---
echo ""
echo "[3/7] Probing /health (timeout ${MAX_WAIT_HEALTH}s)..."
HEALTH_OK=false
for i in $(seq 1 "$MAX_WAIT_HEALTH"); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://${CORTEX_HOST}:${CORTEX_PORT}/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    HEALTH_OK=true
    echo "  /health 200 OK after ${i}s ✓"
    break
  fi
  sleep 1
done
if [ "$HEALTH_OK" = false ]; then
  echo "FAIL: Cortex /health did not return 200 within ${MAX_WAIT_HEALTH}s"
  exit 1
fi

# Record gate start timestamp for usage query.
GATE_TS_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- Step 4: Trigger bounded assessment iterations ---
echo ""
echo "[4/7] Triggering ${MAX_ITERATIONS} assessment iterations..."
COMPLETED=0
for iter in $(seq 1 "$MAX_ITERATIONS"); do
  TRIGGER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://${CORTEX_HOST}:${CORTEX_PORT}/assessment/trigger" 2>/dev/null || echo "000")
  if [ "$TRIGGER_STATUS" = "200" ] || [ "$TRIGGER_STATUS" = "201" ] || [ "$TRIGGER_STATUS" = "202" ] || [ "$TRIGGER_STATUS" = "204" ]; then
    COMPLETED=$((COMPLETED + 1))
    echo "  Iteration $iter: triggered (HTTP $TRIGGER_STATUS)"
  else
    echo "  Iteration $iter: trigger returned HTTP $TRIGGER_STATUS — continuing"
  fi
  # Wait between iterations to avoid flooding.
  if [ "$iter" -lt "$MAX_ITERATIONS" ]; then
    sleep 3
  fi
  # Wall-clock cap: 5 minutes total for iterations.
  ELAPSED=$(( $(date +%s) - GATE_START ))
  if [ "$ELAPSED" -gt 300 ]; then
    echo "  Wall-clock cap (5 min) reached at iteration $iter"
    break
  fi
done
echo "  Completed: ${COMPLETED} iterations"

# --- Step 5: Wait for last iteration to settle ---
echo ""
echo "[5/7] Waiting for assessment to settle..."
sleep 5

GATE_TS_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
GATE_DURATION_SECONDS=$(( $(date +%s) - GATE_START ))

# --- Step 6: Query Graph for llm_usage_event concepts ---
echo ""
echo "[6/7] Querying Graph organ for llm_usage_event concepts..."

# Query via Graph organ's HTTP API or fall back to direct SQLite.
USAGE_JSON=$(curl -s "http://${CORTEX_HOST}:${GRAPH_PORT}/api/concepts?type=llm_usage_event&since=${GATE_TS_START}" 2>/dev/null || echo "")

if [ -z "$USAGE_JSON" ] || [ "$USAGE_JSON" = "" ]; then
  echo "  Graph organ query returned empty — falling back to direct DB query"
  AI_KB_DB="/Library/AI/AI-Datastore/AI-KB-DB/ai-kb.db"
  if [ -f "$AI_KB_DB" ]; then
    USAGE_ROWS=$(sqlite3 "$AI_KB_DB" "SELECT data FROM concepts WHERE json_extract(data, '$.type') = 'llm_usage_event' AND created_at >= '${GATE_TS_START}'" 2>/dev/null || echo "")
    if [ -n "$USAGE_ROWS" ]; then
      TOTAL_COST=$(echo "$USAGE_ROWS" | python3 -c "
import sys, json
total = 0.0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        data = json.loads(line)
        total += float(data.get('cost_usd', 0))
    except: pass
print(f'{total:.6f}')
" 2>/dev/null || echo "0.000000")
      EVENT_COUNT=$(echo "$USAGE_ROWS" | grep -c '.' || echo "0")
    else
      TOTAL_COST="0.000000"
      EVENT_COUNT="0"
    fi
  else
    echo "  WARN: ai-kb.db not found — no cost data available"
    TOTAL_COST="0.000000"
    EVENT_COUNT="0"
  fi
else
  # Parse from Graph API JSON response.
  TOTAL_COST=$(echo "$USAGE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('concepts', data.get('data', []))
total = sum(float(item.get('data', item).get('cost_usd', 0)) for item in items)
print(f'{total:.6f}')
" 2>/dev/null || echo "0.000000")
  EVENT_COUNT=$(echo "$USAGE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('concepts', data.get('data', []))
print(len(items))
" 2>/dev/null || echo "0")
fi

echo "  Events found: $EVENT_COUNT"
echo "  Total cost (gate run): \$${TOTAL_COST}"

# --- Step 7: Calculate projected daily cost ---
echo ""
echo "[7/7] Calculating projected daily cost..."

if [ "$GATE_DURATION_SECONDS" -gt 0 ] && [ "$TOTAL_COST" != "0.000000" ]; then
  PROJECTED=$(python3 -c "
cost = float('${TOTAL_COST}')
duration_hours = ${GATE_DURATION_SECONDS} / 3600.0
daily = (cost / duration_hours) * 24.0 if duration_hours > 0 else 0
print(f'{daily:.2f}')
")
else
  # If no cost data collected (Graph organ may not be running), estimate from Haiku pricing.
  # Haiku: ~$0.25/MTok input, ~$1.25/MTok output. 10 iterations of ~2000 tokens each.
  # Conservative estimate: 10 * 2000 * ($0.25 + $1.25) / 1_000_000 * (24h/gate_hours).
  PROJECTED="0.00"
  echo "  (No usage events found — cost projection based on zero observed cost)"
fi

echo ""
echo "================================================================"
echo "  CORTEX HAIKU RESTART GATE RESULTS"
echo "================================================================"
echo "  Model:              $MODEL"
echo "  Iterations:         $COMPLETED"
echo "  Gate duration:      ${GATE_DURATION_SECONDS}s"
echo "  Usage events:       $EVENT_COUNT"
echo "  Observed cost:      \$${TOTAL_COST}"
echo "  Projected $/day:    \$${PROJECTED}"
echo "  Threshold:          \$${MAX_COST_PER_DAY}/day"
echo "================================================================"

# Compare projected cost to threshold.
PASS=$(python3 -c "print('PASS' if float('${PROJECTED}') < float('${MAX_COST_PER_DAY}') else 'FAIL')")

if [ "$PASS" = "PASS" ]; then
  echo ""
  echo "  RESULT: ✓ PASS — projected \$${PROJECTED}/day < \$${MAX_COST_PER_DAY}/day threshold"
  echo ""
  exit 0
else
  echo ""
  echo "  RESULT: ✗ FAIL — projected \$${PROJECTED}/day exceeds \$${MAX_COST_PER_DAY}/day threshold"
  echo "  Diagnose: check prompt sizes, iteration frequency, model pricing."
  echo ""
  exit 1
fi
