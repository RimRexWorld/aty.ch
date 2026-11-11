#!/usr/bin/env bash
# Build dist/. Pass --serve to preview on :8080, --strict to fail on
# placeholders (what CI does).
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/build.mjs "$@"
