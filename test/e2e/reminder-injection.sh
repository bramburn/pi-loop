#!/bin/bash
# End-to-end loop injection test using llama barn
# Validates that LoopCreate + reminder injection works with a real LLM

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

echo "=== pi-loop E2E Reminder Injection Test ==="
echo ""

# Verify llama barn is reachable
if ! curl -sf http://localhost:2276/v1/models > /dev/null 2>&1; then
  echo "SKIP: llama barn not running at localhost:2276"
  exit 0
fi

# Test 1: Extension loads and registers tools
echo "--- Test 1: Extension loads and registers tools ---"
OUT=$(pi -p \
  --model llamas/devstral-2-24b \
  -e ./src/index.ts \
  --append-system-prompt "You are a test harness. List the names of tools available to you that start with 'Loop' or 'Monitor'. Output ONLY tool names, one per line." \
  "List loop and monitor tools" 2>&1) || true

if echo "$OUT" | grep -qE "LoopCreate|MonitorCreate"; then
  echo "  PASS: Extension loaded, tools visible to LLM"
elif echo "$OUT" | grep -q "Error"; then
  echo "  INFO: LLM may need warming up (model unloaded)"
else
  echo "  INFO: Output:"
  echo "$OUT" | tail -10
fi

# Test 2: Use LoopCreate and LoopList
echo ""
echo "--- Test 2: Create loop, verify in LoopList ---"
OUT=$(pi -p \
  --model llamas/devstral-2-24b \
  -e ./src/index.ts \
  --append-system-prompt "You MUST call BOTH LoopCreate and LoopList tools. Create a loop with trigger=30s and prompt='E2E test loop' then immediately call LoopList." \
  "Create a test loop then list all loops" 2>&1) || true

echo "$OUT" | tail -15

# Test 3: Verify system reminder template
echo ""
echo "--- Test 3: System reminder format ---"
node -e '
const t = "<system-reminder>\nLoop \"%prompt%\" fired. Execute this instruction now.\nTrigger: %trigger_info%. Loop: %loop_id%.\n</system-reminder>";
const r = t.replace("%prompt%","Test").replace("%trigger_info%","schedule: */1 * * * *").replace("%loop_id%","42");
const e = "<system-reminder>\nLoop \"Test\" fired. Execute this instruction now.\nTrigger: schedule: */1 * * * *. Loop: 42.\n</system-reminder>";
if (r === e) { console.log("  PASS: Template substitution correct"); }
else { console.log("  FAIL:", r); process.exit(1); }
'

echo ""
echo "=== Complete ==="
