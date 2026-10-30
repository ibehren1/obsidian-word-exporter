import {
	AlignmentType,
	BorderStyle,
	CheckBox,
	Document,
	ExternalHyperlink,
	FootnoteReferenceRun,
	ImageRun,
	ImportedXmlComponent,
	InternalHyperlink,
	Bookmark,
	LevelFormat,
	LineRuleType,
	Packer,
	Paragraph,
	ParagraphChild,
	PageOrientation,
	ShadingType,
	Header,
	HorizontalPositionRelativeFrom,
	Tab,
	Table,
	TextWrappingType,
	VerticalPositionRelativeFrom,
	TableCell,
	TableLayoutType,
	TableRow,
	TextRun,
	VerticalAlignTable,
	VerticalMergeType,
	WidthType,
	XmlComponent,
	type IBorderOptions,
	type IParagraphOptions,
	type IRunOptions,
	type ISectionOptions,
	type IStylesOptions,
	type ILevelsOptions,
} from 'docx';
import { ShapeRun } from 'docx/shapes';
import type {
	Block,
	Border,
	DocumentModel,
	Inline,
	NumberingLevel,
	ParaBlock,
	RunFormat,
	TableBlock,
} from '../ir';
import { layoutFlow } from '../layout';

const twip = (pt: number) => Math.round(pt * 20);
const halfPt = (pt: number) => Math.round(pt * 2);
/** Points to CSS pixels, which is what docx uses for image sizes. */
const px = (pt: number) => Math.round((pt * 96) / 72);

/** Word's default single line height for fonts we couldn't measure. */
const DEFAULT_LINE_HEIGHT = 1.15;

const BORDER_STYLE = {
	single: BorderStyle.SINGLE,
	dashed: BorderStyle.DASHED,
	dotted: BorderStyle.DOTTED,
	double: BorderStyle.DOUBLE,
} as const;

const ALIGN = {
	left: AlignmentType.LEFT,
	center: AlignmentType.CENTER,
	right: AlignmentType.RIGHT,
	justify: AlignmentType.JUSTIFIED,
} as const;

const LEVEL_FORMAT = {
	bullet: LevelFormat.BULLET,
	decimal: LevelFormat.DECIMAL,
	lowerLetter: LevelFormat.LOWER_LETTER,
	upperLetter: LevelFormat.UPPER_LETTER,
	lowerRoman: LevelFormat.LOWER_ROMAN,
	upperRoman: LevelFormat.UPPER_ROMAN,
	none: LevelFormat.NONE,
} as const;

function border(b: Border | undefined, space = 0): IBorderOptions {
	if (!b || b.width <= 0) return { style: BorderStyle.NONE, size: 0, color: 'auto' };
	return {
		style: BORDER_STYLE[b.style],
		// Eighths of a point; Word accepts 2..96.
		size: Math.min(96, Math.max(2, Math.round(b.width * 8))),
		color: b.color,
		space: Math.min(31, Math.round(space)),
	};
}

/** Parses an OMML string into a component docx can embed as a paragraph child. */
export function ommlComponent(omml: string): XmlComponent {
	const doc = ImportedXmlComponent.fromXmlString(omml) as unknown as {
		root: XmlComponent[];
	};
	// fromXmlString wraps the parsed root element in a nameless document node.
	return doc.root[0]!;
}

class Emitter {
	constructor(private readonly model: DocumentModel) {}

	lineHeightOf(font: string | undefined): number {
		return (font && this.model.fontLineHeights[font]) || DEFAULT_LINE_HEIGHT;
	}

	runOptions(f: RunFormat): IRunOptions {
		return {
			style: f.style,
			font: f.font,
			size: f.size !== undefined ? halfPt(f.size) : undefined,
			bold: f.bold,
			italics: f.italic,
			underline: f.underline ? {} : undefined,
			strike: f.strike,
			color: f.color,
			shading: f.background
				? { type: ShadingType.CLEAR, color: 'auto', fill: f.background }
				: undefined,
			superScript: f.superScript,
			subScript: f.subScript,
			smallCaps: f.smallCaps,
			allCaps: f.allCaps,
			characterSpacing:
				f.letterSpacing !== undefined ? twip(f.letterSpacing) : undefined,
			border: f.border ? border(f.border) : undefined,
		};
	}

	inlines(runs: Inline[]): ParagraphChild[] {
		const out: ParagraphChild[] = [];
		for (const r of runs) {
			switch (r.kind) {
				case 'text':
					out.push(new TextRun({ ...this.runOptions(r.format), text: r.text }));
					break;
				case 'break':
					out.push(new TextRun({ ...this.runOptions(r.format), break: 1 }));
					break;
				case 'tab':
					out.push(new TextRun({ ...this.runOptions(r.format), children: [new Tab()] }));
					break;
				case 'image':
					out.push(
						new ImageRun({
							type: r.image.type,
							data: r.image.data,
							transformation: { width: px(r.image.width), height: px(r.image.height) },
							altText: r.image.alt
								? { name: r.image.alt, description: r.image.alt, title: r.image.alt }
								: undefined,
						}),
					);
					break;
				case 'math':
					out.push(ommlComponent(r.omml) as unknown as ParagraphChild);
					break;
				case 'link':
					out.push(
						new ExternalHyperlink({
							link: r.href,
							children: this.inlines(r.children),
						}),
					);
					break;
				case 'internal-link':
					out.push(
						new InternalHyperlink({
							anchor: r.anchor,
							children: this.inlines(r.children),
						}),
					);
					break;
				case 'footnote-ref':
					out.push(new FootnoteReferenceRun(r.id));
					break;
				case 'checkbox':
					out.push(
						new CheckBox({
							checked: r.checked,
							checkedState: { value: '2611', font: 'Segoe UI Symbol' },
							uncheckedState: { value: '2610', font: 'Segoe UI Symbol' },
						}),
					);
					break;
			}
		}
		return out;
	}

	paragraph(block: ParaBlock): Paragraph {
		return new Paragraph(this.paragraphOptions(block));
	}

	paragraphOptions(block: ParaBlock): IParagraphOptions {
		const p = block.props;
		const firstFont = block.runs.find(
			(r): r is Extract<Inline, { format: RunFormat }> => 'format' in r && !!r.format.font,
		)?.format.font;
		const font = p.font ?? firstFont ?? this.model.base.font;

		let line: IParagraphOptions['spacing'] = {
			before: twip(p.spaceBefore),
			after: twip(p.spaceAfter),
		};
		if (p.exactLine !== undefined) {
			line = { ...line, line: twip(p.exactLine), lineRule: LineRuleType.EXACT };
		} else if (p.lineRatio !== undefined && p.fontSize !== undefined) {
			// "At least" the CSS line height: plain text lines match the note,
			// and lines holding images or equations still grow. Only when CSS
			// sets lines tighter than Word's own line height for the font
			// would that stretch them, so plain text then gets an exact height.
			const tight = p.lineRatio < this.lineHeightOf(font) - 0.005 && this.textOnly(block);
			line = {
				...line,
				line: twip(p.lineRatio * p.fontSize),
				lineRule: tight ? LineRuleType.EXACT : LineRuleType.AT_LEAST,
			};
		} else if (p.lineRatio !== undefined) {
			const multiple = p.lineRatio / this.lineHeightOf(font);
			line = { ...line, line: Math.round(240 * multiple), lineRule: LineRuleType.AUTO };
		}

		let children = this.inlines(block.runs);
		if (p.bookmark) children = [new Bookmark({ id: p.bookmark, children })];

		const space = p.borderSpace ?? {};
		const borders = p.borders
			? {
					top: border(p.borders.top, space.top),
					bottom: border(p.borders.bottom, space.bottom),
					left: border(p.borders.left, space.left),
					right: border(p.borders.right, space.right),
				}
			: undefined;

		// Empty paragraphs take their height from the paragraph mark's run
		// properties, so give spacers and blank lines the intended size.
		const markSize = p.fontSize !== undefined ? halfPt(p.fontSize) : undefined;

		return {
			style: p.style ?? (p.headingLevel ? `Heading${p.headingLevel}` : undefined),
			alignment: p.alignment ? ALIGN[p.alignment] : undefined,
			spacing: line,
			indent: {
				left: p.indentLeft ? twip(p.indentLeft) : undefined,
				right: p.indentRight ? twip(p.indentRight) : undefined,
				hanging: p.hanging ? twip(p.hanging) : undefined,
				firstLine: p.firstLine ? twip(p.firstLine) : undefined,
			},
			numbering: p.numbering
				? {
						reference: p.numbering.reference,
						level: p.numbering.level,
						instance: p.numbering.instance,
					}
				: undefined,
			shading: p.shading
				? { type: ShadingType.CLEAR, color: 'auto', fill: p.shading }
				: undefined,
			border: borders,
			keepNext: p.keepNext,
			keepLines: p.keepLines,
			pageBreakBefore: p.pageBreakBefore,
			outlineLevel: p.headingLevel ? p.headingLevel - 1 : undefined,
			run: markSize !== undefined ? { size: markSize, font: p.font } : undefined,
			children,
		};
	}

	/**
	 * Lets a cell's first paragraph rise into the cell's top padding, as
	 * leadingShift needs room above the text that a cell's start lacks.
	 */
	private liftIntoPadding(cell: TableBlock['rows'][number]['cells'][number]) {
		const first = cell.blocks[0];
		if (first?.kind !== 'para') return cell;
		const font = first.props.font ?? this.model.base.font;
		const need = this.leadingShift(first, font) - first.props.spaceBefore;
		const lift = Math.min(Math.max(0, need), cell.padding.top);
		if (lift <= 0) return cell;
		return {
			...cell,
			padding: { ...cell.padding, top: cell.padding.top - lift },
			blocks: [{ ...first, props: { ...first.props, spaceBefore: first.props.spaceBefore + lift } }, ...cell.blocks.slice(1)],
		};
	}

	table(block: TableBlock): Table {
		block = {
			...block,
			rows: block.rows.map((r) => ({
				...r,
				cells: r.cells.map((c) => this.liftIntoPadding(c)),
			})),
		};
		return new Table({
			layout: TableLayoutType.FIXED,
			columnWidths: block.columnWidths.map(twip),
			width: {
				size: twip(block.columnWidths.reduce((a, b) => a + b, 0)),
				type: WidthType.DXA,
			},
			indent: block.indentLeft ? { size: twip(block.indentLeft), type: WidthType.DXA } : undefined,
			alignment: block.alignment ? ALIGN[block.alignment] : undefined,
			borders: {
				top: border(undefined),
				bottom: border(undefined),
				left: border(undefined),
				right: border(undefined),
				insideHorizontal: border(undefined),
				insideVertical: border(undefined),
			},
			rows: block.rows.map(
				(row) =>
					new TableRow({
						tableHeader: row.header,
						cantSplit: row.cantSplit,
						children: row.cells.map((cell) => {
							const content = this.flow(cell.blocks, true);
							return new TableCell({
									width: { size: twip(cell.width), type: WidthType.DXA },
									columnSpan: cell.colSpan,
									verticalMerge: cell.continueMerge
										? VerticalMergeType.CONTINUE
										: cell.rowSpan && cell.rowSpan > 1
											? VerticalMergeType.RESTART
											: undefined,
									verticalAlign: cell.verticalAlign
										? {
												top: VerticalAlignTable.TOP,
												center: VerticalAlignTable.CENTER,
												bottom: VerticalAlignTable.BOTTOM,
											}[cell.verticalAlign]
										: undefined,
									shading: cell.shading
										? { type: ShadingType.CLEAR, color: 'auto', fill: cell.shading }
										: undefined,
									margins: {
										top: twip(cell.padding.top),
										bottom: twip(cell.padding.bottom + content.trailing),
										left: twip(cell.padding.left),
										right: twip(cell.padding.right),
									},
									borders: {
										top: border(cell.borders.top),
										bottom: border(cell.borders.bottom),
										left: border(cell.borders.left),
										right: border(cell.borders.right),
									},
									children: content.children,
								});
						}),
					}),
			),
		});
	}

	/** Whether a paragraph holds only text, so an exact line height can't clip anything. */
	private textOnly(block: ParaBlock): boolean {
		const size = block.props.fontSize ?? 0;
		const check = (runs: Inline[]): boolean =>
			runs.every((r) => {
				if (r.kind === 'image' || r.kind === 'math' || r.kind === 'checkbox') return false;
				if (r.kind === 'link' || r.kind === 'internal-link') return check(r.children);
				if ('format' in r && r.format.size !== undefined && r.format.size > size + 0.5) return false;
				return true;
			});
		return check(block.runs);
	}

	/** Half the extra leading of a paragraph's lines, which Word puts all above the text. */
	private leadingShift(b: ParaBlock, font: string): number {
		const p = b.props;
		if (p.exactLine !== undefined || p.lineRatio === undefined || p.fontSize === undefined) return 0;
		const center = this.model.fontCenters[font] ?? this.lineHeightOf(font);
		return Math.max(0, ((p.lineRatio - center) * p.fontSize) / 2);
	}

	blocks(blocks: Block[]): (Paragraph | Table)[] {
		return this.flow(blocks, false).children;
	}

	/**
	 * Converts a flow of blocks. With `sinkTrailing`, the last paragraph's
	 * space after is returned instead of applied, since Word drops it at the
	 * end of a table cell; the cell's bottom padding carries it there.
	 */
	flow(blocks: Block[], sinkTrailing: boolean): { children: (Paragraph | Table)[]; trailing: number } {
		let trailing = 0;
		// CSS centers text in its line; Word sets it at the bottom. Raise each
		// paragraph by half its extra leading and give that space back to
		// whatever follows. Word uses the larger of one paragraph's space
		// after and the next one's space before, so it goes into the latter.
		// In a table cell, "keep with next" would chain the whole row to what
		// follows the table, pushing callouts to the next page needlessly.
		const adjusted: Block[] = blocks.map((b) =>
			b.kind === 'para' ? { ...b, props: { ...b.props, keepNext: sinkTrailing ? false : b.props.keepNext } } : b,
		);
		let carry = 0;
		adjusted.forEach((b, i) => {
			if (b.kind !== 'para') {
				carry = 0;
				return;
			}
			const p = b.props;
			const want = this.leadingShift(b, p.font ?? this.model.base.font);
			const before = p.spaceBefore + carry;
			let shift = Math.min(want, before);
			p.spaceBefore = before - shift;
			// Not enough space above (say, right after a spacer between two
			// boxes): take the rest from the spacer.
			const prev = adjusted[i - 1];
			if (shift < want && prev?.kind === 'para' && prev.props.exactLine !== undefined && prev.runs.length === 0) {
				const take = Math.min(want - shift, prev.props.exactLine - 1);
				if (take > 0) {
					prev.props.exactLine -= take;
					shift += take;
				}
			}
			carry = shift;
			// The last paragraph of a flow has no successor to hand it to.
			if (i === adjusted.length - 1) {
				p.spaceAfter += shift;
				if (sinkTrailing) {
					trailing = p.spaceAfter;
					p.spaceAfter = 0;
				}
			}
		});
		const children = adjusted.map((b) => (b.kind === 'para' ? this.paragraph(b) : this.table(b)));
		return { children, trailing };
	}

	/**
	 * Page furniture lives in the header so it repeats on every page:
	 * pictures float behind the text and text sits in frames, both placed
	 * against the page.
	 */
	header(): Header | undefined {
		const furniture = this.model.furniture;
		if (!furniture.length) return undefined;
		const emu = (v: number) => Math.round(v * 12700);
		const images = furniture
			.filter((f) => f.kind === 'image')
			.map(
				(f) =>
					new ImageRun({
						type: f.image.type,
						data: f.image.data,
						transformation: { width: px(f.image.width), height: px(f.image.height) },
						floating: {
							horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(f.x) },
							verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(f.y) },
							behindDocument: f.behindText,
							allowOverlap: true,
							wrap: { type: TextWrappingType.NONE },
						},
					}),
			);
		// Text goes in borderless floating text boxes: unlike frames, they
		// never push the note's content around, just as CSS fixed elements.
		const boxes = furniture
			.filter((f) => f.kind === 'text')
			.map(
				(f) =>
					new ShapeRun({
						type: 'rectangle',
						transformation: { width: px(f.width), height: px(f.height) },
						fill: 'none',
						line: 'none',
						textOptions: { margins: { top: 0, right: 0, bottom: 0, left: 0 }, verticalAlignment: 'top' },
						children: [this.paragraph(f.para)],
						floating: {
							horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(f.x) },
							verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(f.y) },
							allowOverlap: true,
							wrap: { type: TextWrappingType.NONE },
						},
					}),
			);
		// The anchor paragraph is a hairline so the header never pushes the body down.
		const anchor = new Paragraph({
			spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
			run: { size: 2 },
			children: [...images, ...boxes],
		});
		return new Header({ children: [anchor] });
	}

	section(blocks: Block[]): ISectionOptions {
		const { page } = this.model;
		const header = this.header();
		return {
			headers: header ? { default: header } : undefined,
			properties: {
				page: {
					size: {
						width: twip(page.landscape ? page.height : page.width),
						height: twip(page.landscape ? page.width : page.height),
						orientation: page.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
					},
					margin: {
						top: twip(page.margins.top),
						right: twip(page.margins.right),
						bottom: twip(page.margins.bottom),
						left: twip(page.margins.left),
						header: twip(Math.min(page.margins.top / 2, 36)),
						footer: twip(Math.min(page.margins.bottom / 2, 36)),
					},
				},
			},
			children: blocks.length ? this.blocks(blocks) : [new Paragraph({})],
		};
	}

	numbering() {
		return {
			config: this.model.numbering.map((def) => ({
				reference: def.reference,
				levels: def.levels.map((l) => this.level(l)),
			})),
		};
	}

	level(l: NumberingLevel): ILevelsOptions {
		return {
			level: l.level,
			format: LEVEL_FORMAT[l.format],
			text: l.text,
			start: l.start,
			alignment: l.alignment === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
			style: {
				paragraph: {
					indent: { left: twip(l.indentLeft), hanging: twip(l.hanging) },
				},
				run: {
					font: l.font,
					color: l.color,
					size: l.size !== undefined ? halfPt(l.size) : undefined,
				},
			},
		};
	}

	styles(): IStylesOptions {
		const { base } = this.model;
		const baseMultiple = base.lineRatio / this.lineHeightOf(base.font);
		return {
			default: {
				document: {
					run: { font: base.font, size: halfPt(base.size), color: base.color },
					paragraph: {
						spacing: {
							before: 0,
							after: 0,
							line: Math.round(240 * baseMultiple),
							lineRule: LineRuleType.AUTO,
						},
					},
				},
			},
			paragraphStyles: this.model.styles.map((s) => ({
				id: s.id,
				name: s.name,
				basedOn: s.basedOn ?? 'Normal',
				next: s.next ?? 'Normal',
				quickFormat: true,
				run: this.runOptions(s.run),
				paragraph: {
					keepNext: s.para?.keepNext,
					outlineLevel: s.para?.headingLevel ? s.para.headingLevel - 1 : undefined,
					spacing:
						s.para?.lineRatio !== undefined
							? {
									line: Math.round(
										(240 * s.para.lineRatio) / this.lineHeightOf(s.run.font ?? base.font),
									),
									lineRule: LineRuleType.AUTO,
								}
							: undefined,
				},
			})),
		};
	}

	document(): Document {
		const blocks = layoutFlow(this.model.blocks, { top: 0, edgeMargins: true });
		const footnotes: Record<number, { children: Paragraph[] }> = {};
		for (const fn of this.model.footnotes) {
			footnotes[fn.id] = {
				children: this.blocks(layoutFlow(fn.blocks)) as Paragraph[],
			};
		}
		return new Document({
			title: this.model.title,
			styles: this.styles(),
			numbering: this.numbering(),
			footnotes,
			features: { updateFields: false },
			sections: [this.section(blocks)],
		});
	}
}

export function buildDocument(model: DocumentModel): Document {
	return new Emitter(model).document();
}

export async function toDocxBytes(model: DocumentModel): Promise<Uint8Array> {
	const buf = await Packer.toArrayBuffer(buildDocument(model));
	return new Uint8Array(buf);
}
