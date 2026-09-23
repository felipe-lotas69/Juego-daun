#!/usr/bin/env bash
# Every check the project has, in one go.
set -e
cd "$(dirname "$0")/.."
for f in js/*.js tools/*.js; do node --check "$f"; done
node tools/verify-defs.js
node tools/verify-api.js
node tools/verify-sim.js
node tools/verify-levels.js
node tools/verify-prison.js
node tools/verify-client.js
