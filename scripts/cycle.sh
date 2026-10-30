#!/bin/bash
# Build, export a note to .docx and to Obsidian's PDF, convert the .docx with
# Word, and write side-by-side page images. Usage: scripts/cycle.sh "Note.md"
set -e
cd "$(dirname "$0")/.."
npm run build >/dev/null
scripts/run-export.sh "$1"
code="const NOTE = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1");
$(cat scripts/obsidian-pdf.js)"
node scripts/cdp.mjs --title "test-vault - Obsidian" -e "$code" >/dev/null
name="$(basename "${1%.md}")"
scripts/docx2pdf.sh "test-output/$name.docx" >/dev/null
python3 scripts/compare.py "test-output/$name"
