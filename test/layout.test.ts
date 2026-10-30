import { describe, expect, it } from 'vitest';
import type { Block, ParaBlock, TableBlock } from '../src/ir';
import { layoutCell, layoutFlow } from '../src/layout';

const para = (over: Partial<ParaBlock> = {}): ParaBlock => ({
	kind: 'para',
	props: { spaceBefore: 0, spaceAfter: 0 },
	runs: [{ kind: 'text', text: 'x', format: {} }],
	marginTop: 0,
	marginBottom: 0,
	...over,
});

const table = (over: Partial<TableBlock> = {}): TableBlock => ({
	kind: 'table',
	rows: [{ cells: [{ blocks: [para()], width: 100, borders: {}, padding: { top: 0, right: 0, bottom: 0, left: 0 } }] }],
	columnWidths: [100],
	indentLeft: 0,
	marginTop: 0,
	marginBottom: 0,
	...over,
});

const isSpacer = (b: Block | undefined) => b?.kind === 'para' && b.runs.length === 0 && b.props.exactLine !== undefined;

describe('layoutFlow', () => {
	it('collapses margins to the larger one without geometry', () => {
		const [a, b] = layoutFlow([para({ marginBottom: 12 }), para({ marginTop: 30 })]) as ParaBlock[];
		expect(a!.props.spaceAfter).toBe(0);
		expect(b!.props.spaceBefore).toBe(30);
	});

	it('measures gaps from rendered positions when blocks have them', () => {
		const out = layoutFlow([para({ top: 0, bottom: 18, marginBottom: 99 }), para({ top: 40, bottom: 58 })]) as ParaBlock[];
		expect(out[1]!.props.spaceBefore).toBe(22);
	});

	it("uses Word's height for a paragraph whose CSS lines were taller", () => {
		// The CSS box is 26pt tall (a superscript grew a line) but Word gives it 18.
		const out = layoutFlow([para({ top: 0, bottom: 26, height: 18 }), para({ top: 40 })]) as ParaBlock[];
		expect(out[1]!.props.spaceBefore).toBe(22);
	});

	it('keeps the top-of-flow gap when the flow edge is known', () => {
		const out = layoutFlow([para({ top: 24, bottom: 42 })], { top: 0 }) as ParaBlock[];
		expect(out[0]!.props.spaceBefore).toBe(24);
	});

	it('puts a spacer before a table, since Word ignores space after a paragraph there', () => {
		const out = layoutFlow([para({ top: 0, bottom: 18 }), table({ top: 30, bottom: 60 })]);
		expect(out.map((b) => b.kind)).toEqual(['para', 'para', 'table']);
		expect(isSpacer(out[1])).toBe(true);
		expect((out[1] as ParaBlock).props.exactLine).toBe(12);
	});

	it('separates adjacent tables so Word does not merge them', () => {
		const out = layoutFlow([table({ top: 0, bottom: 20 }), table({ top: 20, bottom: 40 })]);
		expect(out.map((b) => b.kind)).toEqual(['table', 'para', 'table']);
	});

	it('separates adjacent boxed paragraphs (code blocks) so Word does not draw one box', () => {
		const code = (top: number) => para({ top, bottom: top + 30, props: { spaceBefore: 0, spaceAfter: 0, shading: 'EEEEEE' } });
		const out = layoutFlow([code(0), code(40)]);
		expect(out).toHaveLength(3);
		expect(isSpacer(out[1])).toBe(true);
		expect((out[2] as ParaBlock).props.spaceBefore).toBe(0);
	});

	it('gives trailing space up to the flow bottom to the last paragraph', () => {
		const out = layoutFlow([para({ top: 0, bottom: 18 })], { top: 0, bottom: 30 }) as ParaBlock[];
		expect(out[0]!.props.spaceAfter).toBe(12);
	});
});

describe('layoutCell', () => {
	it('ends every cell with a paragraph, as Word requires', () => {
		const out = layoutCell([table()]);
		expect(out[out.length - 1]!.kind).toBe('para');
	});
});
