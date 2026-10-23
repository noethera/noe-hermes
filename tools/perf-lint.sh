#!/bin/sh
# perf-lint: fail when a Noethera desktop plugin keeps the Hermes app busy while it is idle.
#   1. infinite CSS animations -> Chromium + WindowServer composite a new frame every vsync, forever
#   2. refetchIntervalInBackground: true -> polls the backend while the window is hidden
#   3. syntax errors (node --check)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
count=0
tmp="${TMPDIR:-/tmp}/perf-lint-$$.mjs"
for f in $(find "$ROOT/plugins" "$ROOT/desktop-only-plugins" -name plugin.js | sort); do
  count=$((count + 1))
  rel="${f#"$ROOT"/}"
  if grep -nE 'animation[^;]*infinite' "$f"; then
    echo "FAIL $rel: infinite CSS animation"; fail=1
  fi
  if grep -nE 'refetchIntervalInBackground:[[:space:]]*true' "$f"; then
    echo "FAIL $rel: polls while the window is hidden"; fail=1
  fi
  cp "$f" "$tmp"
  if ! node --check "$tmp" >/dev/null 2>&1; then
    echo "FAIL $rel: syntax error"; node --check "$tmp"; fail=1
  fi
done
rm -f "$tmp"
[ "$fail" -eq 0 ] && echo "perf-lint: OK ($count plugins)"
exit "$fail"
