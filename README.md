# Word Exporter

Export Obsidian notes to Word (`.docx`) that look like Obsidian's own PDF
export: same fonts, sizes, colors, spacing, callouts, code highlighting and
page setup, as editable Word content.

## Using it

- **Command palette:** *Export current note to Word (.docx)*
- **File menu:** right-click a note → *Export to Word (.docx)*

By default the export uses the page size, margins, title and scale last chosen
in Obsidian's *Export to PDF* dialog, so the two exports match. You can set them
separately in the plugin settings instead.

## What carries over

| Note content | In Word |
| --- | --- |
| Text formatting, highlights, tags, inline code | Runs with the same font, size, color, shading and borders |
| Headings | Word heading styles (navigation pane, table of contents) with bookmarks |
| Bullet, numbered and task lists | Word numbering; task checkboxes drawn in their theme colors |
| Callouts, blockquotes, embedded notes | Boxes with the same background, borders and padding |
| Code blocks | Shaded boxes with syntax colors |
| Tables | Word tables with the same column widths, alignment and header row (repeats across pages) |
| Math (`$…$`, `$$…$$`) | Native, editable Word equations |
| Mermaid diagrams, images, icons | High-resolution pictures |
| Footnotes | Native Word footnotes |
| [Basic Columns](https://github.com/ibehren1/obsidian-basic-columns) sections | Side-by-side columns |
| Links | Clickable external links; `[[#Heading]]` links jump to the heading |
| Watermarks, logos and footers from CSS snippets (`position: fixed` in print) | Repeated on every page through the header |

Styling comes from your theme and CSS snippets the way PDF export applies them,
including their `@media print` and `@page` rules.

## How it works

1. **Render** the note offscreen with Obsidian's own renderer, in the same DOM
   shape and stylesheet environment as PDF export's print window: light theme,
   print rules, the print window's root font size, laid out at the page's text
   width.
2. **Walk** the rendered DOM and read computed styles and layout positions into
   an intermediate model (`src/ir.ts`). Vertical spacing is measured from the
   layout itself, so collapsed margins and theme quirks come out right.
3. **Emit** the model as `.docx` with [docx](https://docx.js.org), translating
   CSS line boxes into Word's line spacing using each font's own metrics, read
   from the installed font files.

## Known differences from PDF export

- Footnotes are Word footnotes at the bottom of each page rather than a list at
  the end, so page breaks can fall differently.
- Word can't round corners of boxes or draw custom checkbox shapes; checkboxes
  use box glyphs in the theme's colors.
- Text inside Mermaid diagrams is part of a picture.
- Where the browser splits a callout across pages, Word may move it whole to the
  next page.

## Development

```bash
npm install
npm run dev     # rebuild main.js on change
npm run build   # typecheck and production build
npm test        # unit tests
npm run lint
```

`test-vault/` is a vault for trying the plugin: its `.obsidian/plugins/word-exporter`
links to the build output.

### Comparing against PDF export (macOS)

The scripts in `scripts/` drive a running Obsidian over the Chrome DevTools
Protocol, export a note both ways, convert the `.docx` with Microsoft Word, and
compare the results:

```bash
# Start Obsidian with DevTools listening on localhost only:
open -a Obsidian --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

scripts/cycle.sh "Kitchen Sink.md"            # side-by-side page images in test-output/
python3 scripts/linediff.py "test-output/Kitchen Sink"   # per-line position deltas
python3 scripts/steps.py "test-output/Kitchen Sink" --worst 10
scripts/regress.sh                            # every fixture, default and custom theme
```

Needs Microsoft Word and `pdftoppm`/`pdftotext` (poppler).
