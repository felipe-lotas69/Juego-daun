#!/usr/bin/env bash
# Every check the project has, in one go.
set -e
cd "$(dirname "$0")/.."
node tools/verify-levels.js
node tools/verify-levels.js versus
node tools/check-respawns.js
