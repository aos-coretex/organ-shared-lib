#!/bin/bash
# grep-no-hardcoded-models.sh — MP-CONFIG-1 relay l9m-12 conformance scan.
#
# Asserts that no probabilistic organ source contains hardcoded model strings.
# All model references must come from YAML settings files via the shared-lib loader.
#
# Scans: all .js files in AOS-organ-<name>-src/ (excluding test/, docs/, fixtures/, node_modules/).
# Patterns: "claude-" | "Qwen" | "gpt-" | "mistral" (model-string fragments).
# Exit 0 = clean. Exit 1 = hardcoded strings found.

set -euo pipefail

AOS_DEV="${AOS_DEV:-/Library/AI/AI-AOS/AOS-organ-dev}"
ORGANS="arbiter nomos senate thalamus radiant minder hippocampus soul lobe cortex receptor"
EXIT=0

for organ in $ORGANS; do
  SRC_DIR="${AOS_DEV}/AOS-organ-${organ}/AOS-organ-${organ}-src"
  if [ ! -d "$SRC_DIR" ]; then
    echo "WARN: $SRC_DIR not found — skipping"
    continue
  fi
  MATCHES=$(grep -rn \
    -e "claude-" \
    -e "\"Qwen" \
    -e "'Qwen" \
    -e "\"gpt-" \
    -e "'gpt-" \
    -e "\"mistral" \
    -e "'mistral" \
    "$SRC_DIR" \
    --include='*.js' \
    --exclude-dir=test \
    --exclude-dir=docs \
    --exclude-dir=fixtures \
    --exclude-dir=node_modules \
    2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    echo "FAIL: $organ has hardcoded model strings:"
    echo "$MATCHES"
    EXIT=1
  else
    echo "  OK: $organ — no hardcoded model strings"
  fi
done

if [ "$EXIT" -eq 0 ]; then
  echo ""
  echo "Conformance scan PASSED: 0 hardcoded model strings across $ORGANS"
fi

exit $EXIT
