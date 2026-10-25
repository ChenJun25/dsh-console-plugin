#!/usr/bin/env bash
# Full check suite for dsh-console.
#
# Set MP_SRC=/path/to/dsh-mobile-plus to also run the cross-repo comparison:
# it reads lib/constants.js there and verifies the 24 RPC method names and
# their order have not drifted. If unset, those 4 checks are skipped.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail=0
run() {
  local name="$1"; shift
  echo ""
  echo "### $name"
  if "$@"; then :; else
    echo "!!! $name FAILED"
    fail=1
  fi
}

run "plugin selftest (existing)"  node "$HERE/test/selftest.mjs"
run "mp contract"                  node "$HERE/test/mp-contract.spec.mjs"
run "mp dispatcher"                 node "$HERE/test/mp-dispatch.spec.mjs"
run "mp routes (integration)"       node "$HERE/test/mp-routes.spec.mjs"
run "mp end to end"                 node "$HERE/test/mp-e2e.spec.mjs"

echo ""
if [ "$fail" -eq 0 ]; then
  echo "all suites passed"
else
  echo "some suites failed"
fi
exit "$fail"
