#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# `npm ci` rather than `npm install`: it installs strictly from the lockfile and
# never writes to it. The container's npm is older than the one that generated
# package-lock.json, so `npm install` silently stripped the `libc` fields from
# the optional rollup/esbuild entries on every resume — 39 lines of churn that
# had to be reverted by hand each time, and that would have landed as a silent
# lockfile downgrade if anyone had committed it.
#
# Falls back to `npm install` when the lockfile and package.json are genuinely
# out of sync, which is the one case `npm ci` refuses to handle.
npm ci || npm install
