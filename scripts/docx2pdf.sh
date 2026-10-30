#!/bin/bash
# Converts a .docx to PDF with Microsoft Word, then renders pages to PNG.
# Usage: scripts/docx2pdf.sh path/to/file.docx
set -e
in="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
pdf="${in%.docx}.word.pdf"
rm -f "$pdf"
osascript <<OSA
tell application "Microsoft Word"
	set d to open file name (POSIX file "$in" as text)
	save as d file name (POSIX file "$pdf" as text) file format format PDF
	close d saving no
end tell
OSA
rm -f "${in%.docx}".word-*.png
pdftoppm -r 70 -png "$pdf" "${in%.docx}.word"
ls "${in%.docx}".word*
