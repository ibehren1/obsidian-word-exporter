#!/bin/bash
# Usage: scripts/run-export.sh "Note.md" ["Other.md" ...]
cd "$(dirname "$0")/.."
notes=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))')
code="const NOTES = $notes;
$(cat scripts/export.js)"
node scripts/cdp.mjs --title "test-vault - Obsidian" -e "$code"
