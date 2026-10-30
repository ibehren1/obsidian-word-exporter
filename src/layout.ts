import type { Block, ParaBlock } from './ir';

// Turns the rendered note's vertical layout into Word spacing. When blocks
// carry their rendered positions, the gap between two blocks is measured
// directly, which accounts for collapsed margins, padding and CSS quirks
// alike. Otherwise CSS margins are collapsed the way the browser would.
// Word gives tables no spacing of their own, so spacer paragraphs carry the
// gaps around them.

/** Smallest gap worth a spacer paragraph between two tables. */
const MIN_SPACER = 1;

export function spacer(height: number): ParaBlock {
	return {
		kind: 'para',
		props: {
			spaceBefore: 0,
			spaceAfter: 0,
			exactLine: Math.max(height, MIN_SPACER),
			fontSize: 1,
		},
		runs: [],
		marginTop: 0,
		marginBottom: 0,
	};
}

/** Word draws consecutive paragraphs with the same borders as one box. */
const boxed = (b: Block) => b.kind === 'para' && (!!b.props.borders || !!b.props.shading);

/** Where a block ends in Word: its rendered top plus the height Word gives it. */
function bottomOf(b: Block): number | undefined {
	if (b.top === undefined) return undefined;
	if (b.height !== undefined) return b.top + b.height;
	return b.bottom;
}

export interface FlowEdges {
	/** Top of the content box the flow starts in, in points. */
	top?: number;
	/** Bottom of the content box, when trailing space should be kept. */
	bottom?: number;
	/** Without geometry: keep the first block's top and last block's bottom margins. */
	edgeMargins?: boolean;
}

export function layoutFlow(blocks: Block[], edges: FlowEdges = {}): Block[] {
	const out: Block[] = [];
	let prev: Block | null = null;

	for (const block of blocks) {
		if (block.kind === 'table') {
			block.rows.forEach((row) =>
				row.cells.forEach((cell) => {
					cell.blocks = layoutCell(cell.blocks, cell.contentTop, cell.contentBottom);
				}),
			);
		}

		let gap: number;
		const prevBottom = prev ? bottomOf(prev) : edges.top;
		if (block.top !== undefined && prevBottom !== undefined) {
			gap = Math.max(0, block.top - prevBottom);
		} else if (prev) {
			gap = Math.max(prev.marginBottom, block.marginTop) + (prev.extraBottom ?? 0) + (block.extraTop ?? 0);
		} else {
			gap = (edges.edgeMargins ? block.marginTop : 0) + (block.extraTop ?? 0);
		}

		if (block.kind === 'para' && !(prev && boxed(prev) && boxed(block))) {
			block.props.spaceBefore = gap;
			block.props.spaceAfter = 0;
		} else if (block.kind === 'para') {
			// Keep two boxes (such as code blocks) from merging into one.
			out.push(spacer(gap));
			block.props.spaceBefore = 0;
		} else if (prev || gap >= MIN_SPACER) {
			// Word ignores space after a paragraph that a table follows, and
			// merges two adjacent tables, so a spacer paragraph carries the gap.
			out.push(spacer(gap));
		}

		out.push(block);
		prev = block;
	}

	if (prev) {
		const end = bottomOf(prev);
		const trailing =
			edges.bottom !== undefined && end !== undefined
				? Math.max(0, edges.bottom - end)
				: edges.edgeMargins
					? prev.marginBottom + (prev.extraBottom ?? 0)
					: 0;
		if (prev.kind === 'para') prev.props.spaceAfter = trailing;
		else if (trailing >= MIN_SPACER) out.push(spacer(trailing));
	}
	return out;
}

/** Lays out a table cell's content; Word requires a cell to end in a paragraph. */
export function layoutCell(blocks: Block[], top?: number, bottom?: number): Block[] {
	const out = layoutFlow(blocks, { top, bottom, edgeMargins: true });
	const last = out[out.length - 1];
	if (!last || last.kind !== 'para') out.push(spacer(MIN_SPACER));
	return out;
}
