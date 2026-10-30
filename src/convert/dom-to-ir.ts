import { Platform } from 'obsidian';
import type {
	Block,
	Border,
	Borders,
	DocumentModel,
	Footnote,
	Inline,
	PageSetup,
	ParaBlock,
	ParaProps,
	RunFormat,
	StyleDef,
	TableBlock,
	TableCell,
	TableRow,
} from '../ir';
import {
	blendHex,
	bordersOf,
	colorHex,
	hasBorder,
	naturalLineHeight,
	paddingOf,
	parsePx,
	pt,
	resolveFont,
	spaceRatio,
	splitFamilies,
} from '../render/css';
import { wordFontMetrics } from '../render/font-metrics';
import { DISPLAY_ATTR, LATEX_ATTR } from '../render/render-note';
import { pageFurniture } from './furniture';
import { NumberingRegistry, levelFormat } from './lists';
import { trimRuns } from './runs';
import { mathToOmml } from './math';
import { imgElementToImage, svgElementToImage } from './media';

// Walks a note rendered by Obsidian and describes it as IR, reading every
// visual decision (fonts, colors, spacing, indents, widths) from computed
// styles and layout so the document matches what PDF export prints.

export interface WalkOptions {
	page: PageSetup;
	/** Elements whose fixed pseudo-elements repeat on every page. */
	pageElements?: HTMLElement[];
	/** Overrides for the body and code fonts; empty means use the theme's. */
	bodyFont?: string;
	monoFont?: string;
	title?: string;
	/** Reads a local image by absolute path; null if it can't. */
	readLocalFile?: (path: string) => Promise<Uint8Array | null>;
}

/** The content box blocks are positioned against: the page, a table cell, or a column. */
interface Frame {
	left: number;
	right: number;
}

interface ListState {
	reference: string;
	level: number;
	/** The item's first paragraph still needs the number. */
	pending: boolean;
}

interface Ctx {
	frame: Frame;
	/** Background behind the content, for flattening translucent colors. */
	backdrop: string;
	list?: ListState;
	/** Inside a table cell, callout or column: Word sections can't start here. */
	nested: boolean;
	/**
	 * Blend modes of enclosing elements, innermost first, each with the color
	 * behind it. Callouts use `mix-blend-mode: darken` in some themes.
	 */
	blends?: { mode: string; backdrop: string }[];
	/** Run formatting inherited from the block (decorations, which CSS doesn't inherit). */
	underline?: boolean;
	strike?: boolean;
}

const SKIP_SELECTOR = [
	'.frontmatter',
	'.frontmatter-container',
	'.metadata-container',
	'.copy-code-button',
	'.markdown-embed-link',
	'.file-embed-link',
	'.collapse-indicator',
	'.heading-collapse-indicator',
	'.list-collapse-indicator',
	'.callout-fold',
	'.edit-block-button',
	'.markdown-preview-pusher',
	'.mod-header',
	'.mod-footer',
	'.footnote-backref',
	'.embed-actions',
	'.cm-embed-block-actions',
	'script',
	'style',
	'template',
	'button',
].join(',');

const BLOCK_DISPLAYS = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'flow-root', 'table-row-group']);

const HEADING_TAGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

const WHITE = 'FFFFFF';

const isElement = (n: Node): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE;

function bookmarkName(text: string, index: number): string {
	const slug = text
		.normalize('NFKD')
		.replace(/[^\w]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 28);
	return `h${index}_${slug}`.slice(0, 40);
}

function alignment(textAlign: string): ParaProps['alignment'] {
	switch (textAlign) {
		case 'center':
		case '-webkit-center':
			return 'center';
		case 'right':
		case 'end':
		case '-webkit-right':
			return 'right';
		case 'justify':
			return 'justify';
		default:
			return undefined;
	}
}

export class Walker {
	private numbering = new NumberingRegistry();
	private footnotes: Footnote[] = [];
	private footnoteSources = new Map<string, HTMLElement>();
	private nextFootnoteId = 1;
	private headingAnchors = new Map<string, string>();
	private styles = new Map<string, StyleDef>();
	private fontLineHeights: Record<string, number> = {};
	private fontCenters: Record<string, number> = {};

	/** Top of the rendered note in CSS pixels; block positions are relative to it. */
	private rootTop = 0;
	private baseFamily = '';
	private bodyFont = 'Arial';
	private monoFont = 'Courier New';
	private baseSize = 12;
	private baseColor = '222222';
	private baseLineRatio = 1.5;

	constructor(
		private readonly root: HTMLElement,
		private readonly opts: WalkOptions,
	) {}

	async walk(): Promise<DocumentModel> {
		this.prepareColumns();
		this.indexFootnotes();
		this.indexHeadings();
		this.resolveBase();

		// The print view's padding sits inside the page margins on every page
		// (left/right) or once at the start (top).
		const rect = this.root.getBoundingClientRect();
		this.rootTop = rect.top;
		const rs = getComputedStyle(this.root);
		const pad = paddingOf(rs);
		const ctx: Ctx = {
			frame: { left: rect.left + parsePx(rs.paddingLeft), right: rect.right - parsePx(rs.paddingRight) },
			backdrop: WHITE,
			nested: false,
		};
		const blocks = await this.blocks(this.root, ctx);
		const first = blocks[0];
		if (first) first.extraTop = (first.extraTop ?? 0) + pad.top;
		const m = this.opts.page.margins;
		const page = { ...this.opts.page, margins: { ...m, left: m.left + pad.left, right: m.right + pad.right } };

		for (const font of new Set([this.bodyFont, this.monoFont, ...this.usedFonts(blocks)])) {
			// Word's own metrics when the font file can be read, else the browser's.
			const metrics = wordFontMetrics(font);
			const natural = metrics?.lineHeight ?? naturalLineHeight(font);
			this.fontLineHeights[font] = natural;
			this.fontCenters[font] = metrics?.center ?? natural;
		}

		const area = this.opts.pageElements?.[0]?.getBoundingClientRect();
		// Positions come relative to the printable area; make them page positions,
		// since the Word margins also hold the print view's padding.
		const furniture = (
			area ? await pageFurniture(this.opts.pageElements!, { width: area.width, height: area.height }, this.bodyFont) : []
		).map((f) => ({ ...f, x: f.x + m.left, y: f.y + m.top }));

		return {
			page,
			furniture,
			blocks,
			footnotes: this.footnotes,
			numbering: this.numbering.definitions(),
			base: {
				font: this.bodyFont,
				size: this.baseSize,
				color: this.baseColor,
				lineRatio: this.baseLineRatio,
			},
			styles: [...this.styles.values()],
			title: this.opts.title,
			fontLineHeights: this.fontLineHeights,
			fontCenters: this.fontCenters,
		};
	}

	// ---- Setup -------------------------------------------------------------

	private resolveBase() {
		const s = getComputedStyle(this.root);
		this.baseFamily = s.fontFamily;
		// Print swaps the text font for --font-print (Arial unless overridden).
		const printFamily = s.getPropertyValue('--font-print').trim();
		this.bodyFont = this.opts.bodyFont || resolveFont(printFamily || s.fontFamily, 'Arial');
		this.monoFont =
			this.opts.monoFont ||
			resolveFont(s.getPropertyValue('--font-monospace').trim(), Platform.isMacOS ? 'Menlo' : 'Consolas');
		this.baseSize = pt(parsePx(s.fontSize));
		this.baseColor = colorHex(s.color) ?? '222222';
		const lh = parsePx(s.lineHeight);
		this.baseLineRatio = lh > 0 ? lh / parsePx(s.fontSize) : 1.5;
	}

	/**
	 * Lays out Basic Columns callouts side by side the way the plugin does, so
	 * measurements match even when the plugin isn't installed.
	 */
	private prepareColumns() {
		for (const callout of Array.from(this.root.querySelectorAll<HTMLElement>('.callout[data-callout="columns"]'))) {
			const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
			if (!content || content.querySelector(':scope > .bc-columns')) continue;
			const container = createDiv({ cls: 'bc-columns word-exporter-columns' });
			let current = container.createDiv({ cls: 'bc-column' });
			const columns = [current];
			for (const child of Array.from(content.children)) {
				if (child.matches('.callout[data-callout="column-break"]')) {
					child.remove();
					current = container.createDiv({ cls: 'bc-column' });
					columns.push(current);
				} else {
					current.appendChild(child);
				}
			}
			const widths = (callout.dataset.calloutMetadata ?? '')
				.trim()
				.split(/[\s,/]+/)
				.map(Number)
				.filter((n) => Number.isFinite(n) && n > 0);
			const useWidths = widths.length === columns.length;
			columns.forEach((col, i) => {
				col.setCssStyles({ flexGrow: String(useWidths ? widths[i] : 1), flexBasis: '0', minWidth: '0' });
			});
			content.empty();
			content.appendChild(container);
		}
	}

	private indexFootnotes() {
		for (const li of Array.from(this.root.querySelectorAll<HTMLElement>('section.footnotes li[id], .footnotes li[id]'))) {
			this.footnoteSources.set(li.id, li);
		}
	}

	private indexHeadings() {
		let i = 0;
		for (const h of Array.from(this.root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
			const text = h.dataset.heading ?? h.textContent?.trim() ?? '';
			if (!text || this.headingAnchors.has(text)) continue;
			this.headingAnchors.set(text, bookmarkName(text, ++i));
		}
	}

	private usedFonts(blocks: Block[]): string[] {
		const fonts = new Set<string>();
		const visitRuns = (runs: Inline[]) => {
			for (const r of runs) {
				if ('format' in r && r.format.font) fonts.add(r.format.font);
				if (r.kind === 'link' || r.kind === 'internal-link') visitRuns(r.children);
			}
		};
		const visit = (bs: Block[]) => {
			for (const b of bs) {
				if (b.kind === 'para') visitRuns(b.runs);
				else b.rows.forEach((r) => r.cells.forEach((c) => visit(c.blocks)));
			}
		};
		visit(blocks);
		this.footnotes.forEach((f) => visit(f.blocks));
		return [...fonts];
	}

	// ---- Color -------------------------------------------------------------

	/** A color as it ends up on the page, after the blend modes around it. */
	private paint(hex: string | undefined, ctx: Ctx): string | undefined {
		if (!hex) return hex;
		for (const layer of ctx.blends ?? []) hex = blendHex(hex, layer.backdrop, layer.mode);
		return hex;
	}

	private paintBorders(b: Borders, ctx: Ctx): Borders {
		if (!ctx.blends?.length) return b;
		const side = (x: Border | undefined) => (x ? { ...x, color: this.paint(x.color, ctx)! } : x);
		return { top: side(b.top), right: side(b.right), bottom: side(b.bottom), left: side(b.left) };
	}

	/** Context for an element's content, adding the element's blend mode if it has one. */
	private blendCtx(style: CSSStyleDeclaration, ctx: Ctx): Ctx {
		const mode = style.mixBlendMode;
		if (!mode || mode === 'normal') return ctx;
		return { ...ctx, blends: [{ mode, backdrop: ctx.backdrop }, ...(ctx.blends ?? [])] };
	}

	// ---- Geometry ----------------------------------------------------------

	/** A vertical position in the rendered note, in points from its top. */
	private y(px: number): number {
		return pt(px - this.rootTop);
	}

	/** Records where an element was rendered on a block made from it. */
	private place<T extends Block>(block: T, el: Element): T {
		const r = el.getBoundingClientRect();
		block.top = this.y(r.top);
		block.bottom = this.y(r.bottom);
		return block;
	}

	/** Where an element's content really ends (its children's margin boxes), in points. */
	private naturalBottom(el: HTMLElement): number | undefined {
		let bottom: number | undefined;
		for (const child of Array.from(el.children) as HTMLElement[]) {
			const cs = getComputedStyle(child);
			if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
			const b = this.y(child.getBoundingClientRect().bottom + parsePx(cs.marginBottom));
			bottom = bottom === undefined ? b : Math.max(bottom, b);
		}
		return bottom;
	}

	/** Content box of an element, vertically, in points. */
	private contentBox(el: Element): { top: number; bottom: number } {
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		return {
			top: this.y(r.top + parsePx(s.borderTopWidth) + parsePx(s.paddingTop)),
			bottom: this.y(r.bottom - parsePx(s.borderBottomWidth) - parsePx(s.paddingBottom)),
		};
	}

	/** Text line boxes in a range: their count and the first line's vertical center (px). */
	private lineBoxes(range: Range): { count: number; firstCenter: number } | null {
		const rects = Array.from(range.getClientRects())
			.filter((r) => r.width > 0 && r.height > 0)
			.sort((a, b) => a.top - b.top);
		if (rects.length === 0) return null;
		let count = 1;
		let bottom = rects[0]!.bottom;
		for (const r of rects.slice(1)) {
			if (r.top >= bottom - 2) {
				count++;
				bottom = r.bottom;
			} else {
				bottom = Math.max(bottom, r.bottom);
			}
		}
		const first = rects[0]!;
		return { count, firstCenter: (first.top + first.bottom) / 2 };
	}

	/**
	 * Sets the height Word will give a text paragraph: its line count times
	 * the line height. Superscripts and the like can make CSS lines taller,
	 * which Word doesn't do; measuring gaps from Word's height keeps what
	 * follows where the note has it. Paragraphs with images or equations
	 * keep their rendered height.
	 */
	private wordHeight(block: ParaBlock, range: Range) {
		const lh = block.props.lineRatio !== undefined && block.props.fontSize !== undefined ? block.props.lineRatio * block.props.fontSize : 0;
		if (!lh || block.runs.some((r) => r.kind === 'image' || r.kind === 'math')) return;
		const lines = this.lineBoxes(range);
		if (lines) block.height = lines.count * lh;
	}

	private textBlock(block: ParaBlock, el: HTMLElement): ParaBlock {
		this.place(block, el);
		const range = document.createRange();
		range.selectNodeContents(el);
		this.wordHeight(block, range);
		return block;
	}

	// ---- Classification ----------------------------------------------------

	private skipped(el: HTMLElement, style: CSSStyleDeclaration): boolean {
		if (el.matches(SKIP_SELECTOR)) return true;
		if (el.matches('section.footnotes, .footnotes')) return true;
		// Print shows collapsed callout content; keep it even though it's hidden on screen.
		if (el.matches('.callout-content')) return false;
		return style.display === 'none' || style.visibility === 'hidden';
	}

	private isBlock(el: HTMLElement, style: CSSStyleDeclaration): boolean {
		if (el.matches('.math-block, div.math, .mermaid, .callout-content')) return true;
		return BLOCK_DISPLAYS.has(style.display);
	}

	/** Containers drawn with a background or border become single-cell tables. */
	private isDecorated(el: HTMLElement, style: CSSStyleDeclaration): boolean {
		if (el.matches('.callout[data-callout="columns"]')) return false;
		if (['P', 'LI', 'UL', 'OL', 'TABLE', 'PRE', 'HR', 'IMG'].includes(el.tagName) || HEADING_TAGS[el.tagName]) {
			return false;
		}
		const bg = colorHex(style.backgroundColor);
		return (!!bg && bg !== WHITE) || hasBorder(bordersOf(style));
	}

	// ---- Formatting --------------------------------------------------------

	private fontFor(style: CSSStyleDeclaration): string {
		if (style.fontFamily === this.baseFamily) return this.bodyFont;
		const families = splitFamilies(style.fontFamily).map((f) => f.toLowerCase());
		if (families.some((f) => f.includes('mono') || f === 'menlo' || f === 'consolas' || f === 'courier new')) {
			return this.monoFont;
		}
		return resolveFont(style.fontFamily, this.bodyFont);
	}

	private format(el: HTMLElement, parent: RunFormat, ctx: Ctx): RunFormat {
		const s = getComputedStyle(el);
		const weight = parseInt(s.fontWeight, 10);
		const deco = s.textDecorationLine;
		const va = s.verticalAlign;
		const superScript = va === 'super' || (el.tagName === 'SUP' && va !== 'baseline');
		const subScript = va === 'sub' || (el.tagName === 'SUB' && va !== 'baseline');
		const ownBg = colorHex(s.backgroundColor, ctx.backdrop);
		const letterSpacing = parsePx(s.letterSpacing);
		// Inline boxes (tags, inline code) can have a border; Word boxes the run.
		const box = s.display.startsWith('inline') ? this.paintBorders(bordersOf(s, ctx.backdrop), ctx) : {};
		const ownBorder = box.top && box.bottom && box.left && box.right ? box.top : undefined;

		return {
			font: this.fontFor(s),
			// Word shrinks super/subscript itself; keep the surrounding size.
			size: superScript || subScript ? parent.size : pt(parsePx(s.fontSize)),
			bold: weight >= 600,
			italic: s.fontStyle === 'italic' || s.fontStyle.startsWith('oblique'),
			underline: parent.underline || deco.includes('underline'),
			strike: parent.strike || deco.includes('line-through'),
			color: this.paint(colorHex(s.color, ctx.backdrop), ctx),
			background: ownBg && ownBg !== ctx.backdrop ? this.paint(ownBg, ctx) : parent.background,
			superScript: superScript || parent.superScript,
			subScript: subScript || parent.subScript,
			smallCaps: s.fontVariantCaps === 'small-caps' || undefined,
			allCaps: s.textTransform === 'uppercase' || undefined,
			letterSpacing: letterSpacing ? pt(letterSpacing) : undefined,
			border: ownBorder ?? parent.border,
		};
	}

	private blockFormat(el: HTMLElement, ctx: Ctx): RunFormat {
		const f = this.format(el, {}, ctx);
		// A block's own background is drawn as paragraph shading or a cell, not run shading.
		return { ...f, background: undefined, underline: f.underline || ctx.underline, strike: f.strike || ctx.strike };
	}

	private paraProps(el: HTMLElement, ctx: Ctx): { props: ParaProps; marginTop: number; marginBottom: number } {
		const s = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		const fontSize = parsePx(s.fontSize);
		const lh = parsePx(s.lineHeight);
		const contentLeft = rect.left + parsePx(s.borderLeftWidth) + parsePx(s.paddingLeft);
		const contentRight = rect.right - parsePx(s.borderRightWidth) - parsePx(s.paddingRight);
		const indentLeft = pt(contentLeft - ctx.frame.left);
		const indentRight = pt(ctx.frame.right - contentRight);
		return {
			props: {
				spaceBefore: 0,
				spaceAfter: 0,
				alignment: alignment(s.textAlign),
				lineRatio: lh > 0 && fontSize > 0 ? lh / fontSize : undefined,
				fontSize: pt(fontSize),
				font: this.fontFor(s),
				indentLeft: indentLeft > 0.5 ? indentLeft : undefined,
				indentRight: indentRight > 0.5 ? indentRight : undefined,
				firstLine: parsePx(s.textIndent) > 0 ? pt(parsePx(s.textIndent)) : undefined,
			},
			marginTop: pt(parsePx(s.marginTop)),
			marginBottom: pt(parsePx(s.marginBottom)),
		};
	}

	private noteStyle(id: string, name: string, el: HTMLElement, props: ParaProps, ctx: Ctx, headingLevel?: number) {
		if (this.styles.has(id)) return;
		const run = this.blockFormat(el, ctx);
		this.styles.set(id, {
			id,
			name,
			run: { font: run.font, size: run.size, bold: run.bold, italic: run.italic, color: run.color },
			para: { lineRatio: props.lineRatio, keepNext: !!headingLevel, headingLevel },
		});
	}

	// ---- Blocks ------------------------------------------------------------

	private async blocks(container: HTMLElement, ctx: Ctx, inlineSource: HTMLElement = container): Promise<Block[]> {
		const out: Block[] = [];
		let pending: Node[] = [];

		const flush = async () => {
			if (pending.length === 0) return;
			const nodes = pending;
			pending = [];
			const para = await this.paragraphFrom(inlineSource, nodes, ctx);
			if (para) out.push(para);
		};

		for (const node of Array.from(container.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) {
				pending.push(node);
				continue;
			}
			if (!isElement(node)) continue;
			const style = getComputedStyle(node);
			if (this.skipped(node, style)) continue;
			if (!this.isBlock(node, style)) {
				pending.push(node);
				continue;
			}
			await flush();
			const blocks = await this.block(node, style, ctx);
			out.push(...blocks);
		}
		await flush();
		return out;
	}

	private async block(el: HTMLElement, style: CSSStyleDeclaration, ctx: Ctx): Promise<Block[]> {
		const heading = HEADING_TAGS[el.tagName];
		if (heading) return this.heading(el, heading, ctx);
		if (el.matches('.inline-title')) return this.titleBlock(el, ctx);
		if (el.matches('.callout[data-callout="columns"]')) return this.columns(el, ctx);
		if (el.matches('.math-block, div.math')) return this.displayMath(el, ctx);
		if (el.matches('.mermaid')) return this.figure(el, ctx);

		switch (el.tagName) {
			case 'P':
				return this.paragraphBlock(el, ctx);
			case 'UL':
			case 'OL':
				return this.list(el, ctx);
			case 'PRE':
				return this.codeBlock(el, ctx);
			case 'TABLE':
				return this.table(el, ctx);
			case 'HR':
				return [this.rule(el, ctx)];
		}

		if (el.matches('.callout-title')) return this.calloutTitle(el, ctx);
		if (this.isDecorated(el, style)) return this.container(el, style, ctx);

		return this.wrapper(el, style, ctx);
	}

	/**
	 * A plain wrapper: its content flows as if it weren't there, and its
	 * margins collapse with its first and last children's.
	 */
	private async wrapper(el: HTMLElement, style: CSSStyleDeclaration, ctx: Ctx): Promise<Block[]> {
		const inner = await this.blocks(el, ctx);
		const first = inner[0];
		const last = inner[inner.length - 1];
		if (first) {
			first.marginTop = Math.max(first.marginTop, pt(parsePx(style.marginTop)));
			first.extraTop = (first.extraTop ?? 0) + pt(parsePx(style.paddingTop));
		}
		if (last) {
			last.marginBottom = Math.max(last.marginBottom, pt(parsePx(style.marginBottom)));
			last.extraBottom = (last.extraBottom ?? 0) + pt(parsePx(style.paddingBottom));
		}
		return inner;
	}

	private async paragraphFrom(source: HTMLElement, nodes: Node[], ctx: Ctx): Promise<ParaBlock | null> {
		const base = this.blockFormat(source, ctx);
		const runs: Inline[] = [];
		for (const n of nodes) runs.push(...(await this.inline(n, base, ctx, false)));
		const trimmed = trimRuns(runs);
		if (trimmed.length === 0 && !ctx.list?.pending) return null;
		const { props } = this.paraProps(source, ctx);
		const block: ParaBlock = { kind: 'para', props, runs: trimmed, marginTop: 0, marginBottom: 0 };
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		if (first && last && props.lineRatio !== undefined && props.fontSize !== undefined) {
			const range = document.createRange();
			range.setStartBefore(first);
			range.setEndAfter(last);
			const lines = this.lineBoxes(range);
			if (lines) {
				// Line boxes are centered on the text, so step up half a line.
				const lhPx = (props.lineRatio * props.fontSize * 96) / 72 / this.scale();
				block.top = this.y(lines.firstCenter - lhPx / 2);
				block.bottom = block.top + lines.count * props.lineRatio * props.fontSize;
				this.wordHeight(block, range);
			}
		}
		this.applyList(block, ctx);
		return block;
	}

	/** The downscale factor in effect, from how pt() converts. */
	private scale(): number {
		return pt(96) / 72;
	}

	/** Inline markup like an embed span can still lay out as a block. */
	private hasBlockChild(el: HTMLElement): boolean {
		return Array.from(el.children).some((c) => {
			const cs = getComputedStyle(c);
			return !this.skipped(c as HTMLElement, cs) && this.isBlock(c as HTMLElement, cs);
		});
	}

	private async paragraphBlock(el: HTMLElement, ctx: Ctx): Promise<Block[]> {
		if (this.hasBlockChild(el)) return this.wrapper(el, getComputedStyle(el), ctx);
		const base = this.blockFormat(el, ctx);
		const runs = trimRuns(await this.inlineChildren(el, base, ctx, false));
		const { props, marginTop, marginBottom } = this.paraProps(el, ctx);
		// A paragraph that is only an image or embed holds a block-level figure.
		const block: ParaBlock = { kind: 'para', props, runs, marginTop, marginBottom };
		if (runs.length === 0 && !ctx.list?.pending) return [];
		this.textBlock(block, el);
		this.applyList(block, ctx);
		return [block];
	}

	private async heading(el: HTMLElement, level: number, ctx: Ctx): Promise<Block[]> {
		if (this.hasBlockChild(el)) return this.wrapper(el, getComputedStyle(el), ctx);
		const base = this.blockFormat(el, ctx);
		const runs = trimRuns(await this.inlineChildren(el, base, ctx, false));
		const { props, marginTop, marginBottom } = this.paraProps(el, ctx);
		props.headingLevel = level;
		props.keepNext = true;
		const text = el.dataset.heading ?? el.textContent?.trim() ?? '';
		props.bookmark = this.headingAnchors.get(text);
		this.noteStyle(`Heading${level}`, `heading ${level}`, el, props, ctx, level);
		const block: ParaBlock = { kind: 'para', props, runs, marginTop, marginBottom };
		this.textBlock(block, el);
		this.applyList(block, ctx);
		return [block];
	}

	private async titleBlock(el: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const base = this.blockFormat(el, ctx);
		const runs = trimRuns(await this.inlineChildren(el, base, ctx, false));
		const { props, marginTop, marginBottom } = this.paraProps(el, ctx);
		props.style = 'Title';
		props.keepNext = true;
		this.noteStyle('Title', 'Title', el, props, ctx);
		return [this.textBlock({ kind: 'para', props, runs, marginTop, marginBottom }, el)];
	}

	/** Gives the first paragraph of a list item its number or bullet. */
	private applyList(block: ParaBlock, ctx: Ctx) {
		const list = ctx.list;
		if (!list?.pending) return;
		list.pending = false;
		block.props.numbering = { reference: list.reference, level: list.level, instance: 0 };
		// The numbering level carries the indents.
		block.props.indentLeft = undefined;
		block.props.hanging = undefined;
		block.props.firstLine = undefined;
	}

	private async list(el: HTMLElement, ctx: Ctx, root?: string, depth = 0): Promise<Block[]> {
		const s = getComputedStyle(el);
		const out: Block[] = [];
		const rootKey = root ?? this.numbering.newRoot();
		const start = el.tagName === 'OL' ? parseInt(el.getAttribute('start') ?? '1', 10) || 1 : 1;

		const items = Array.from(el.children).filter(
			(c): c is HTMLElement => c.tagName === 'LI' && getComputedStyle(c).display !== 'none',
		);
		for (const li of items) {
			const liStyle = getComputedStyle(li);
			const isTask = li.classList.contains('task-list-item') || !!li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
			const liRect = li.getBoundingClientRect();
			const contentLeft = liRect.left + parsePx(liStyle.paddingLeft) + parsePx(liStyle.borderLeftWidth);
			const indentLeft = pt(contentLeft - ctx.frame.left);

			let state: ListState;
			const box = isTask
				? li.querySelector<HTMLInputElement>(':scope > input[type=checkbox], :scope > p > input[type=checkbox]')
				: null;
			if (isTask) {
				// The checkbox becomes the item's marker, drawn in its colors.
				const bs = box ? getComputedStyle(box) : liStyle;
				const boxRect = box?.getBoundingClientRect();
				const checked = !!box?.checked;
				const width = boxRect?.width || parsePx(liStyle.fontSize);
				const color = this.paint(
					checked
						? (colorHex(bs.backgroundColor, ctx.backdrop) ?? colorHex(bs.borderTopColor, ctx.backdrop))
						: (colorHex(bs.borderTopColor, ctx.backdrop) ?? colorHex(bs.color, ctx.backdrop)),
					ctx,
				);
				const ref = this.numbering.reference(rootKey, depth, {
					listStyleType: checked ? 'task-done' : 'task-open',
					start: 1,
					indentLeft,
					hanging: boxRect ? Math.max(6, indentLeft - pt(boxRect.left - ctx.frame.left)) : pt(width * 1.5),
					color,
					// The box glyph is about 0.8em wide.
					size: pt(width / 0.8),
				});
				state = { reference: ref, level: depth, pending: true };
			} else {
				const marker = getComputedStyle(li, '::marker');
				const markerSize = parsePx(marker.fontSize) || parsePx(liStyle.fontSize);
				const type = liStyle.listStyleType || s.listStyleType;
				// Chromium ends numbers a space before the text, and draws bullets
				// about 1.2em before it.
				const hanging = levelFormat(type).ordered ? markerSize * 0.3 : markerSize * 1.2;
				const ref = this.numbering.reference(rootKey, depth, {
					listStyleType: type,
					start,
					indentLeft,
					hanging: pt(hanging),
					font: this.bodyFont,
					color: this.paint(colorHex(marker.color, ctx.backdrop), ctx),
					size: pt(markerSize),
				});
				state = { reference: ref, level: depth, pending: true };
			}

			const itemCtx: Ctx = { ...ctx, list: state };
			const decorations = this.blockFormat(li, ctx);
			itemCtx.underline = decorations.underline;
			itemCtx.strike = decorations.strike;

			const blocks: Block[] = [];
			let pendingNodes: Node[] = [];
			const flush = async () => {
				if (pendingNodes.length === 0) return;
				const p = await this.paragraphFrom(li, pendingNodes, itemCtx);
				pendingNodes = [];
				if (p) blocks.push(p);
			};
			for (const node of Array.from(li.childNodes)) {
				if (!isElement(node)) {
					pendingNodes.push(node);
					continue;
				}
				const cs = getComputedStyle(node);
				if (this.skipped(node, cs)) continue;
				if (node.tagName === 'UL' || node.tagName === 'OL') {
					await flush();
					if (state.pending) blocks.push(...this.emptyItem(li, itemCtx));
					blocks.push(...(await this.list(node, { ...ctx, list: undefined }, rootKey, depth + 1)));
					continue;
				}
				if (!this.isBlock(node, cs)) {
					pendingNodes.push(node);
					continue;
				}
				await flush();
				if (state.pending && node.tagName !== 'P' && !HEADING_TAGS[node.tagName]) {
					blocks.push(...this.emptyItem(li, itemCtx));
				}
				blocks.push(...(await this.block(node, cs, itemCtx)));
			}
			await flush();
			if (state.pending) blocks.push(...this.emptyItem(li, itemCtx));
			if (box) this.checkboxAlone(li, box, blocks);

			const first = blocks[0];
			if (first) {
				first.marginTop = Math.max(first.marginTop, pt(parsePx(liStyle.marginTop)));
				first.extraTop = (first.extraTop ?? 0) + pt(parsePx(liStyle.paddingTop));
			}
			const last = blocks[blocks.length - 1];
			if (last) {
				last.marginBottom = Math.max(last.marginBottom, pt(parsePx(liStyle.marginBottom)));
				last.extraBottom = (last.extraBottom ?? 0) + pt(parsePx(liStyle.paddingBottom));
			}
			out.push(...blocks);
		}

		const first = out[0];
		if (first) first.marginTop = Math.max(first.marginTop, pt(parsePx(s.marginTop)));
		const last = out[out.length - 1];
		if (last) last.marginBottom = Math.max(last.marginBottom, pt(parsePx(s.marginBottom)));
		return out;
	}

	/**
	 * When a task's first word doesn't fit beside its checkbox, the browser
	 * leaves the checkbox alone on the first line. Word would keep them
	 * together, so start the text on a new line.
	 */
	private checkboxAlone(li: HTMLElement, box: HTMLElement, blocks: Block[]) {
		const first = blocks[0];
		if (first?.kind !== 'para' || first.runs.length === 0) return;
		const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
		});
		const text = walker.nextNode();
		if (!text) return;
		const range = document.createRange();
		range.selectNodeContents(text);
		const firstRect = Array.from(range.getClientRects()).find((r) => r.width > 0);
		if (firstRect && firstRect.top >= box.getBoundingClientRect().bottom - 1) {
			first.runs.unshift({ kind: 'break', format: {} });
		}
	}

	private emptyItem(li: HTMLElement, ctx: Ctx): Block[] {
		const { props } = this.paraProps(li, ctx);
		const block: ParaBlock = { kind: 'para', props, runs: [], marginTop: 0, marginBottom: 0 };
		const box = this.contentBox(li);
		block.top = box.top;
		block.height = (props.lineRatio ?? 1.5) * (props.fontSize ?? this.baseSize);
		block.bottom = block.top + block.height;
		this.applyList(block, ctx);
		return [block];
	}

	private async codeBlock(pre: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(pre);
		const code = pre.querySelector<HTMLElement>(':scope > code') ?? pre;
		const bg = colorHex(s.backgroundColor, ctx.backdrop);
		const innerCtx: Ctx = { ...ctx, backdrop: bg ?? ctx.backdrop };
		const base = this.blockFormat(code, innerCtx);
		const runs = await this.inlineChildren(code, base, innerCtx, true);
		// The final newline of a fence isn't a visible line.
		while (runs.length && runs[runs.length - 1]!.kind === 'break') runs.pop();

		const rect = pre.getBoundingClientRect();
		const pad = paddingOf(s);
		const borders = this.paintBorders(bordersOf(s, ctx.backdrop), ctx);
		const codeStyle = getComputedStyle(code);
		const fontSize = parsePx(codeStyle.fontSize);
		const lh = parsePx(codeStyle.lineHeight);

		// Word draws paragraph borders outside the text indents, with the
		// padding as border spacing, so a same-color border makes the box.
		const edge = (b: (typeof borders)['top']) =>
			b ?? (bg ? { width: 0.25, color: this.paint(bg, ctx)!, style: 'single' as const } : undefined);
		const props: ParaProps = {
			spaceBefore: 0,
			spaceAfter: 0,
			style: 'Code',
			font: this.monoFont,
			fontSize: pt(fontSize),
			lineRatio: lh > 0 ? lh / fontSize : undefined,
			shading: this.paint(bg, ctx),
			borders: { top: edge(borders.top), bottom: edge(borders.bottom), left: edge(borders.left), right: edge(borders.right) },
			borderSpace: pad,
			indentLeft: pt(rect.left - ctx.frame.left) + pad.left + (borders.left?.width ?? 0.25),
			indentRight: pt(ctx.frame.right - rect.right) + pad.right + (borders.right?.width ?? 0.25),
			alignment: 'left',
		};
		this.noteStyle('Code', 'Code', code, props, innerCtx);
		const block: ParaBlock = this.place({
			kind: 'para',
			props,
			runs,
			marginTop: pt(parsePx(s.marginTop)),
			marginBottom: pt(parsePx(s.marginBottom)),
		}, pre);
		if (ctx.list?.pending) {
			const blocks = this.emptyItem(pre.parentElement ?? pre, ctx);
			return [...blocks, block];
		}
		return [block];
	}

	private rule(hr: HTMLElement, ctx: Ctx): ParaBlock {
		const s = getComputedStyle(hr);
		const b = this.paintBorders(bordersOf(s, ctx.backdrop), ctx);
		const line = b.top ?? b.bottom ?? { width: 1.5, color: 'E0E0E0', style: 'single' as const };
		const { props } = this.paraProps(hr, ctx);
		const rect = hr.getBoundingClientRect();
		return this.place({
			kind: 'para',
			props: {
				...props,
				indentLeft: pt(rect.left - ctx.frame.left) || undefined,
				indentRight: pt(ctx.frame.right - rect.right) || undefined,
				borders: { bottom: line },
				borderSpace: { bottom: 0 },
				exactLine: 1,
				fontSize: 1,
			},
			runs: [],
			marginTop: pt(parsePx(s.marginTop)),
			marginBottom: pt(parsePx(s.marginBottom)),
		}, hr);
	}

	private async displayMath(el: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(el);
		const runs = await this.mathInline(el, this.blockFormat(el, ctx), true);
		const { props } = this.paraProps(el, ctx);
		props.alignment = 'center';
		return [this.place({ kind: 'para', props, runs, marginTop: pt(parsePx(s.marginTop)), marginBottom: pt(parsePx(s.marginBottom)) }, el)];
	}

	private async figure(el: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(el);
		const svg = el.querySelector('svg');
		if (!svg) return [];
		const image = await svgElementToImage(svg);
		if (!image) return [];
		const { props } = this.paraProps(el, ctx);
		const rect = el.getBoundingClientRect();
		const svgRect = svg.getBoundingClientRect();
		const centered = Math.abs(svgRect.left - rect.left - (rect.right - svgRect.right)) < 2;
		props.alignment = centered ? 'center' : props.alignment;
		props.lineRatio = undefined;
		return [
			this.place(
				{
					kind: 'para',
					props,
					runs: [{ kind: 'image', image, format: {} }],
					marginTop: pt(parsePx(s.marginTop)),
					marginBottom: pt(parsePx(s.marginBottom)),
				},
				el,
			),
		];
	}

	private async calloutTitle(el: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(el);
		const base = this.blockFormat(el, ctx);
		const runs: Inline[] = [];
		const gap = parsePx(s.columnGap) || parsePx(s.gap);
		for (const child of Array.from(el.children) as HTMLElement[]) {
			const cs = getComputedStyle(child);
			if (this.skipped(child, cs)) continue;
			const childRuns = trimRuns(await this.inline(child, base, ctx, false));
			if (childRuns.length === 0) continue;
			if (runs.length && gap > 0) runs.push({ kind: 'text', text: ' ', format: { ...base, size: pt(gap * 2) } });
			runs.push(...childRuns);
		}
		const { props, marginTop, marginBottom } = this.paraProps(el, ctx);
		props.keepNext = true;
		return [this.textBlock({ kind: 'para', props, runs, marginTop, marginBottom }, el)];
	}

	/** A decorated container (callout, blockquote, embed) as a one-cell table. */
	private async container(el: HTMLElement, style: CSSStyleDeclaration, ctx: Ctx): Promise<Block[]> {
		const rect = el.getBoundingClientRect();
		const bg = colorHex(style.backgroundColor, ctx.backdrop);
		const padding = paddingOf(style);
		// The element's own paint blends with what's behind it, like its content.
		const blended = this.blendCtx(style, ctx);
		const borders = this.paintBorders(bordersOf(style, ctx.backdrop), blended);
		const contentLeft = rect.left + parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft);
		const contentRight = rect.right - parsePx(style.borderRightWidth) - parsePx(style.paddingRight);
		const innerCtx: Ctx = {
			frame: { left: contentLeft, right: contentRight },
			backdrop: bg ?? ctx.backdrop,
			blends: blended.blends,
			nested: true,
			underline: ctx.underline,
			strike: ctx.strike,
		};
		const inner = await this.blocks(el, innerCtx);
		if (inner.length === 0) return [];

		// Word measures cell padding inside the border; CSS padding sits inside too.
		const box = this.contentBox(el);
		const cell: TableCell = {
			blocks: inner,
			width: pt(rect.width),
			shading: bg && bg !== ctx.backdrop ? this.paint(bg, blended) : undefined,
			borders,
			padding,
			contentTop: box.top,
			contentBottom: box.bottom,
		};
		const table: TableBlock = {
			kind: 'table',
			rows: [{ cells: [cell] }],
			columnWidths: [pt(rect.width)],
			indentLeft: pt(rect.left - ctx.frame.left),
			marginTop: pt(parsePx(style.marginTop)),
			marginBottom: pt(parsePx(style.marginBottom)),
		};
		this.place(table, el);
		if (ctx.list?.pending) return [...this.emptyItem(el.parentElement ?? el, ctx), table];
		return [table];
	}

	/**
	 * Basic Columns sections become a borderless table, one cell per column:
	 * like the PDF, columns sit side by side and don't flow into each other.
	 */
	private async columns(callout: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(callout);
		const cols = Array.from(callout.querySelectorAll<HTMLElement>(':scope > .callout-content > .bc-columns > .bc-column'));
		if (cols.length === 0) return this.wrapper(callout, s, ctx);
		const rects = cols.map((c) => c.getBoundingClientRect());
		const cells: TableCell[] = [];
		for (let i = 0; i < cols.length; i++) {
			const col = cols[i]!;
			const r = rects[i]!;
			const next = rects[i + 1];
			const cs = getComputedStyle(col);
			const bg = colorHex(cs.backgroundColor, ctx.backdrop);
			const backdrop = bg ?? ctx.backdrop;
			// The gap to the next column becomes extra right padding.
			const gap = next ? pt(next.left - r.right) : 0;
			const padding = paddingOf(cs);
			padding.right += gap;
			const frame = {
				left: r.left + parsePx(cs.borderLeftWidth) + parsePx(cs.paddingLeft),
				right: r.right - parsePx(cs.borderRightWidth) - parsePx(cs.paddingRight),
			};
			const box = this.contentBox(col);
			const colCtx = this.blendCtx(cs, ctx);
			cells.push({
				blocks: await this.blocks(col, { frame, backdrop, blends: colCtx.blends, nested: true }),
				contentTop: box.top,
				// Columns stretch to the tallest one, which Word's row does by
				// itself; only the column's own content (and its margins) counts.
				contentBottom: this.naturalBottom(col),
				width: pt(r.width) + gap,
				shading: bg && bg !== ctx.backdrop ? this.paint(bg, colCtx) : undefined,
				borders: this.paintBorders(bordersOf(cs, ctx.backdrop), colCtx),
				padding,
			});
		}
		const table: TableBlock = {
			kind: 'table',
			rows: [{ cells }],
			columnWidths: cells.map((c) => c.width),
			indentLeft: pt(rects[0]!.left - ctx.frame.left),
			marginTop: pt(parsePx(s.marginTop)),
			marginBottom: pt(parsePx(s.marginBottom)),
		};
		// Columns are as tall as the tallest one.
		table.top = Math.min(...rects.map((r) => this.y(r.top)));
		table.bottom = Math.max(...rects.map((r) => this.y(r.bottom)));
		return [table];
	}

	private async table(table: HTMLElement, ctx: Ctx): Promise<Block[]> {
		const s = getComputedStyle(table);
		const tableRect = table.getBoundingClientRect();
		const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr'));
		if (rows.length === 0) return [];

		// Column boundaries from where cells actually sit, which handles spans.
		const edges = new Set<number>();
		for (const row of rows) {
			for (const cell of Array.from(row.cells)) {
				const r = cell.getBoundingClientRect();
				edges.add(Math.round(r.left * 4) / 4);
				edges.add(Math.round(r.right * 4) / 4);
			}
		}
		const xs = [...edges].sort((a, b) => a - b);
		const merged: number[] = [];
		for (const x of xs) if (!merged.length || x - merged[merged.length - 1]! > 1) merged.push(x);
		const colIndex = (x: number) => {
			let best = 0;
			merged.forEach((m, i) => {
				if (Math.abs(m - x) < Math.abs(merged[best]! - x)) best = i;
			});
			return best;
		};
		let columnWidths = merged.slice(1).map((x, i) => pt(x - merged[i]!));
		// Wide tables scroll on screen; on paper they have to fit the frame.
		const available = pt(ctx.frame.right - Math.max(ctx.frame.left, tableRect.left));
		const total = columnWidths.reduce((a, b) => a + b, 0);
		const scale = total > available && available > 0 ? available / total : 1;
		columnWidths = columnWidths.map((w) => w * scale);

		const tableBg = colorHex(s.backgroundColor, ctx.backdrop);
		const out: TableRow[] = [];
		const carry: { col: number; span: number; rowsLeft: number; cell: TableCell }[] = [];

		for (const row of rows) {
			const rowStyle = getComputedStyle(row);
			const rowBg = colorHex(rowStyle.backgroundColor, tableBg ?? ctx.backdrop);
			const cells: { col: number; cell: TableCell }[] = [];

			for (const c of carry) {
				if (c.rowsLeft > 0) {
					cells.push({ col: c.col, cell: { ...c.cell, blocks: [], continueMerge: true, rowSpan: undefined } });
					c.rowsLeft--;
				}
			}

			for (const td of Array.from(row.cells)) {
				const cs = getComputedStyle(td);
				if (cs.display === 'none') continue;
				const r = td.getBoundingClientRect();
				const start = colIndex(r.left);
				const end = Math.max(start + 1, colIndex(r.right));
				const bg = colorHex(cs.backgroundColor, rowBg ?? tableBg ?? ctx.backdrop) ?? rowBg ?? tableBg;
				const backdrop = bg ?? ctx.backdrop;
				const frame = {
					left: r.left + parsePx(cs.borderLeftWidth) + parsePx(cs.paddingLeft),
					right: r.right - parsePx(cs.borderRightWidth) - parsePx(cs.paddingRight),
				};
				const blocks = await this.blocks(td, { frame, backdrop, blends: ctx.blends, nested: true });
				const va = cs.verticalAlign;
				const box = this.contentBox(td);
				const cell: TableCell = {
					blocks,
					contentTop: box.top,
					// Cells stretch to the row's height; Word does that itself, so
					// the space under shorter content isn't part of the cell.
					contentBottom: undefined,
					width: columnWidths.slice(start, end).reduce((a, b) => a + b, 0),
					shading: bg && bg !== WHITE ? this.paint(bg, ctx) : undefined,
					borders: this.paintBorders(bordersOf(cs, backdrop), ctx),
					padding: paddingOf(cs),
					verticalAlign: va === 'middle' ? 'center' : va === 'bottom' ? 'bottom' : 'top',
					colSpan: end - start > 1 ? end - start : undefined,
					rowSpan: td.rowSpan > 1 ? td.rowSpan : undefined,
				};
				cells.push({ col: start, cell });
				if (td.rowSpan > 1) carry.push({ col: start, span: end - start, rowsLeft: td.rowSpan - 1, cell });
			}

			cells.sort((a, b) => a.col - b.col);
			out.push({
				cells: cells.map((c) => c.cell),
				header: row.parentElement?.tagName === 'THEAD',
				cantSplit: true,
			});
		}

		const block: TableBlock = this.place({
			kind: 'table',
			rows: out,
			columnWidths,
			indentLeft: pt(tableRect.left - ctx.frame.left),
			marginTop: pt(parsePx(s.marginTop)),
			marginBottom: pt(parsePx(s.marginBottom)),
		}, table);
		if (ctx.list?.pending) return [...this.emptyItem(table.parentElement ?? table, ctx), block];
		return [block];
	}

	// ---- Inlines -----------------------------------------------------------

	private async inlineChildren(el: HTMLElement, fmt: RunFormat, ctx: Ctx, pre: boolean): Promise<Inline[]> {
		const out: Inline[] = [];
		for (const child of Array.from(el.childNodes)) out.push(...(await this.inline(child, fmt, ctx, pre)));
		return out;
	}

	private async inline(node: Node, parent: RunFormat, ctx: Ctx, pre: boolean): Promise<Inline[]> {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			if (!text) return [];
			const ws = node.parentElement ? getComputedStyle(node.parentElement).whiteSpace : 'normal';
			const preserve = pre || ws.startsWith('pre') || ws === 'break-spaces';
			if (!preserve) return [{ kind: 'text', text: text.replace(/[ \t\n\r\f]+/g, ' '), format: parent }];
			const out: Inline[] = [];
			text.split('\n').forEach((line, i) => {
				if (i > 0) out.push({ kind: 'break', format: parent });
				line.split('\t').forEach((part, j) => {
					if (j > 0) out.push({ kind: 'tab', format: parent });
					if (part) out.push({ kind: 'text', text: part, format: parent });
				});
			});
			return out;
		}
		if (!isElement(node)) return [];
		const el = node;
		const style = getComputedStyle(el);
		if (this.skipped(el, style)) return [];

		if (el.tagName === 'BR') return [{ kind: 'break', format: parent }];
		if (el.tagName === 'IMG') {
			const image = await imgElementToImage(el as HTMLImageElement, this.opts.readLocalFile);
			return image ? [{ kind: 'image', image, format: parent }] : [];
		}
		if (el.tagName === 'svg' || el.instanceOf(SVGSVGElement)) {
			const image = await svgElementToImage(el as unknown as SVGSVGElement);
			return image ? [{ kind: 'image', image, format: parent }] : [];
		}
		// Task checkboxes are drawn as the list item's marker.
		if (el.matches('.task-list-item-checkbox, li.task-list-item > input, li.task-list-item > p > input')) return [];
		if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') {
			return [{ kind: 'checkbox', checked: (el as HTMLInputElement).checked, format: parent }];
		}
		if (el.matches('.math')) return this.mathInline(el, parent, el.matches('.math-block'));
		if (el.matches('.footnote-ref, sup[data-footnote-id]')) return this.footnoteRef(el, parent, ctx);

		const fmt = this.format(el, parent, ctx);
		let children = await this.inlineChildren(el, fmt, ctx, pre);
		if (((fmt.background && fmt.background !== parent.background) || (fmt.border && fmt.border !== parent.border)) && children.length) {
			children = this.padded(children, fmt, style);
		}
		if (el.tagName === 'A') return this.link(el as HTMLAnchorElement, children);
		return children;
	}

	/**
	 * Word can't pad a run's shading, so tags and inline code get shaded
	 * no-break spaces stretched to the CSS padding on each side.
	 */
	private padded(children: Inline[], fmt: RunFormat, style: CSSStyleDeclaration): Inline[] {
		const pad = (px: number): Inline | null => {
			const want = pt(px);
			if (want < 0.75 || !fmt.font || !fmt.size) return null;
			const space = spaceRatio(fmt.font) * fmt.size;
			return {
				kind: 'text',
				text: '\u00a0',
				format: { ...fmt, underline: false, strike: false, letterSpacing: want - space },
			};
		};
		const left = pad(parsePx(style.paddingLeft));
		const right = pad(parsePx(style.paddingRight));
		return [...(left ? [left] : []), ...children, ...(right ? [right] : [])];
	}

	private link(a: HTMLAnchorElement, children: Inline[]): Inline[] {
		if (children.length === 0) return [];
		if (a.matches('.internal-link')) {
			const target = a.dataset.href ?? a.getAttribute('href') ?? '';
			const hash = target.indexOf('#');
			const notePart = hash >= 0 ? target.slice(0, hash) : target;
			const headingPart = hash >= 0 ? target.slice(hash + 1) : '';
			const self = !notePart || notePart === this.opts.title;
			if (self && headingPart && !headingPart.startsWith('^')) {
				const heading = headingPart.split('#').pop()!;
				const anchor = this.headingAnchors.get(heading);
				if (anchor) return [{ kind: 'internal-link', anchor, children }];
			}
			return children;
		}
		const href = a.getAttribute('href') ?? '';
		if (/^(https?:|mailto:|tel:|obsidian:|file:)/i.test(href)) return [{ kind: 'link', href, children }];
		return children;
	}

	private async mathInline(el: HTMLElement, fmt: RunFormat, display: boolean): Promise<Inline[]> {
		const tagged = el.matches(`[${LATEX_ATTR}]`) ? el : el.querySelector<HTMLElement>(`[${LATEX_ATTR}]`);
		const latex = tagged?.getAttribute(LATEX_ATTR) ?? null;
		const isDisplay = display || tagged?.getAttribute(DISPLAY_ATTR) === '1';
		const omml = mathToOmml(el, latex, isDisplay);
		if (omml) return [{ kind: 'math', omml }];
		// Last resort: show the TeX source rather than drop the equation.
		const text = latex ?? el.textContent ?? '';
		return text ? [{ kind: 'text', text, format: { ...fmt, italic: true } }] : [];
	}

	private async footnoteRef(el: HTMLElement, fmt: RunFormat, ctx: Ctx): Promise<Inline[]> {
		const link = el.matches('a') ? el : el.querySelector('a');
		const targetId = (link?.getAttribute('href') ?? '').replace(/^#/, '');
		const source = this.footnoteSources.get(targetId);
		if (!source) {
			return [{ kind: 'text', text: el.textContent ?? '', format: { ...fmt, superScript: true } }];
		}
		const id = this.nextFootnoteId++;
		const rect = source.getBoundingClientRect();
		const s = getComputedStyle(source);
		const frame = {
			left: rect.left + parsePx(s.paddingLeft),
			right: rect.right - parsePx(s.paddingRight),
		};
		const blocks = await this.blocks(source, { frame, backdrop: ctx.backdrop, nested: true });
		const paras = blocks.filter((b): b is ParaBlock => b.kind === 'para');
		// docx puts Word's footnote number first; separate it from the text.
		const first = paras[0];
		if (first) {
			const textFmt = first.runs.find((r): r is Extract<Inline, { format: RunFormat }> => 'format' in r)?.format ?? {};
			first.runs.unshift({ kind: 'text', text: ' ', format: textFmt });
		}
		this.footnotes.push({ id, blocks: paras });
		return [{ kind: 'footnote-ref', id }];
	}
}
