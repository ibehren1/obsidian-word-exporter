#!/bin/bash
# Exports every fixture under both appearances and prints line-position
# deltas (Word vs Obsidian PDF, in points) per page-aligned line.
cd "$(dirname "$0")/.."
for mode in default user; do
	node scripts/cdp.mjs --title "test-vault - Obsidian" -e "const MODE = '$mode';
$(cat scripts/appearance.js)" >/dev/null
	for n in "Kitchen Sink.md" "No Footnotes.md" "Edge Cases.md" "Reference/2026-10-29 - {External} AWSVerafin Database Cadence.md"; do
		scripts/cycle.sh "$n" >/dev/null 2>&1 || { echo "$mode $n FAILED"; continue; }
		b="test-output/$(basename "${n%.md}")"
		mkdir -p "test-output/$mode"; cp "$b".cmp-*.png "test-output/$mode/" 2>/dev/null
		pages="$(pdfinfo "$b.obsidian.pdf" | awk '/Pages/{print $2}')/$(pdfinfo "$b.word.pdf" | awk '/Pages/{print $2}')"
		stats=$(python3 scripts/steps.py "$b")
		echo "$mode | $(basename "$n") | pages obs/word $pages | $stats"
	done
done
