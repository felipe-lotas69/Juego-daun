#!/usr/bin/env bash
# Files are written by many agents at once, so a file can be caught halfway
# through a write. Anything that does not parse is mid-write, not broken:
# report it so it can be left out of a commit rather than committed truncated.
cd "$(dirname "$0")/.."
bad=0
for f in js/*.js tools/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "MID-WRITE: $f"
    bad=1
  fi
done
exit $bad
