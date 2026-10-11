#!/usr/bin/env bash
# dsh-console 全部检查。
#
# 设 MP_SRC=/path/to/dsh-mobile-plus 会额外跑跨端比对：直接读它的
# lib/constants.js，确认 24 个 RPC 方法名与顺序没漂。没有就跳过那 4 项。
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
