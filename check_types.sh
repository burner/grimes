#!/usr/bin/env bash
set -euo pipefail

FILE="grimes_mcp.py"
PASS=0
FAIL=0
RESULTS=()

run_check() {
    local name="$1"
    shift
    if command -v "$name" >/dev/null 2>&1; then
        echo "=== $name ==="
        if "$@" "$FILE"; then
            RESULTS+=("PASS: $name")
            ((PASS++)) || true
        else
            RESULTS+=("FAIL: $name")
            ((FAIL++)) || true
        fi
    else
        RESULTS+=("SKIP: $name (not installed)")
    fi
}

run_check ruff       ruff check
run_check flake8     flake8
run_check pylint     pylint --errors-only
run_check pyflakes   pyflakes
run_check mypy       mypy --ignore-missing-imports
run_check pyright    pyright
run_check basedpyright basedpyright

echo ""

echo "=== eslint ==="
if npx eslint .; then
    RESULTS+=("PASS: eslint")
    ((PASS++)) || true
else
    RESULTS+=("FAIL: eslint")
    ((FAIL++)) || true
fi

echo "=== tsc ==="
if npx tsc --noEmit; then
    RESULTS+=("PASS: tsc")
    ((PASS++)) || true
else
    RESULTS+=("FAIL: tsc")
    ((FAIL++)) || true
fi

echo "=== bun test ==="
if bun test; then
    RESULTS+=("PASS: bun test")
    ((PASS++)) || true
else
    RESULTS+=("FAIL: bun test")
    ((FAIL++)) || true
fi
