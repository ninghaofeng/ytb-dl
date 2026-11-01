#!/bin/bash
set -euo pipefail

cd -- "$(dirname -- "$0")"
if [[ "$#" -gt 1 ]]; then
  printf 'Usage: build-mac.command [x64|arm64|all]\n' >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22+ is required. Install it from https://nodejs.org/ and retry.\n' >&2
  exit 1
fi

node scripts/build-platform.mjs mac "${1:-}"
