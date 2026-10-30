// Intermediate representation between the rendered DOM and the docx objects.
// The DOM walker produces it from computed styles; the emitter turns it into
// docx. Keeping it plain data makes layout passes (margin collapsing, column
// breaks) and tests simple. All lengths are in points, colors are 6-digit hex
// without '#'.

export interface Border {
	/** Line width in points. */
	width: number;
	color: string;
	style: 'single' | 'dashed' | 'dotted' | 'double';
}

export interface Borders {
	top?: Border;
	right?: Border;
	bottom?: Border;
	left?: Border;
}

export interface Box {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface RunFormat {
	font?: string;
	/** Font size in points. */
	size?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	color?: string;
	background?: string;
	superScript?: boolean;
	subScript?: boolean;
	smallCaps?: boolean;
	allCaps?: boolean;
	/** Letter spacing in points. */
	letterSpacing?: number;
	/** A box around the run, as Word draws it on all four sides. */
	border?: Border;
	style?: string;
}

export type Inline =
	| { kind: 'text'; text: string; format: RunFormat }
	| { kind: 'break'; format: RunFormat }
	| { kind: 'tab'; format: RunFormat }
	| { kind: 'image'; image: ImageData; format: RunFormat }
	| { kind: 'math'; omml: string }
	| { kind: 'link'; href: string; children: Inline[] }
	| { kind: 'internal-link'; anchor: string; children: Inline[] }
	| { kind: 'footnote-ref'; id: number }
	| { kind: 'checkbox'; checked: boolean; format: RunFormat };

export interface ImageData {
	data: Uint8Array;
	type: 'png' | 'jpg' | 'gif' | 'bmp';
	/** Display size in points. */
	width: number;
	height: number;
	alt?: string;
}

export interface ParaProps {
	style?: string;
	headingLevel?: number;
	alignment?: 'left' | 'center' | 'right' | 'justify';
	/** Space before/after in points, after margin collapsing. */
	spaceBefore: number;
	spaceAfter: number;
	/** CSS line-height divided by font size, e.g. 1.5. */
	lineRatio?: number;
	/** Font size used to resolve lineRatio when the paragraph has no runs. */
	fontSize?: number;
	font?: string;
	indentLeft?: number;
	indentRight?: number;
	hanging?: number;
	firstLine?: number;
	numbering?: { reference: string; level: number; instance: number };
	shading?: string;
	borders?: Borders;
	/** Gap between paragraph text and its borders, in points. */
	borderSpace?: Partial<Box>;
	keepNext?: boolean;
	keepLines?: boolean;
	pageBreakBefore?: boolean;
	bookmark?: string;
	/** Exact line height in points, for spacer paragraphs. */
	exactLine?: number;
}

export interface ParaBlock {
	kind: 'para';
	props: ParaProps;
	runs: Inline[];
	/** CSS margins before collapsing, in points. */
	marginTop: number;
	marginBottom: number;
	/** Space that doesn't collapse, from padding around the block. */
	extraTop?: number;
	extraBottom?: number;
	/** Where the block sits in the rendered note, in points from its top. */
	top?: number;
	bottom?: number;
	/** The height Word will give the paragraph, when it differs from the rendered one. */
	height?: number;
}

export interface TableCell {
	blocks: Block[];
	width: number;
	shading?: string;
	borders: Borders;
	padding: Box;
	verticalAlign?: 'top' | 'center' | 'bottom';
	colSpan?: number;
	rowSpan?: number;
	/** Set on cells covered by a row span from above. */
	continueMerge?: boolean;
	/** Rendered top and bottom of the cell's content box, in points. */
	contentTop?: number;
	contentBottom?: number;
}

export interface TableRow {
	cells: TableCell[];
	header?: boolean;
	cantSplit?: boolean;
}

export interface TableBlock {
	kind: 'table';
	rows: TableRow[];
	columnWidths: number[];
	indentLeft: number;
	alignment?: 'left' | 'center' | 'right';
	marginTop: number;
	marginBottom: number;
	extraTop?: number;
	extraBottom?: number;
	top?: number;
	bottom?: number;
	height?: number;
}

export type Block = ParaBlock | TableBlock;

export interface Footnote {
	id: number;
	blocks: ParaBlock[];
}

export interface PageSetup {
	/** Page size in points. */
	width: number;
	height: number;
	margins: Box;
	landscape: boolean;
}

/**
 * Something drawn on every page, positioned against the page's printable
 * area (inside the margins), like CSS `position: fixed` in print.
 */
export type Furniture =
	| {
			kind: 'image';
			image: ImageData;
			/** Top-left corner, in points from the page's top-left. */
			x: number;
			y: number;
			behindText: boolean;
	  }
	| {
			kind: 'text';
			para: ParaBlock;
			x: number;
			y: number;
			width: number;
			height: number;
	  };

export interface DocumentModel {
	page: PageSetup;
	furniture: Furniture[];
	blocks: Block[];
	footnotes: Footnote[];
	numbering: NumberingDef[];
	/** Base paragraph font/size/color, used for document defaults. */
	base: { font: string; size: number; color: string; lineRatio: number };
	styles: StyleDef[];
	title?: string;
	/** Word's single line height of each font as a multiple of its size. */
	fontLineHeights: Record<string, number>;
	/** Each font's reference height for placing text in a line; see WordFontMetrics.center. */
	fontCenters: Record<string, number>;
}

export interface StyleDef {
	id: string;
	name: string;
	basedOn?: string;
	next?: string;
	run: RunFormat;
	para?: Partial<ParaProps>;
}

export interface NumberingLevel {
	level: number;
	format: 'bullet' | 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman' | 'none';
	text: string;
	start: number;
	indentLeft: number;
	hanging: number;
	/** Right-aligned markers end just before the text, like CSS outside markers. */
	alignment: 'left' | 'right';
	font?: string;
	color?: string;
	size?: number;
}

export interface NumberingDef {
	reference: string;
	levels: NumberingLevel[];
}
