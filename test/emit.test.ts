import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toDocxBytes } from '../src/docx/emit';
import type { DocumentModel, ParaBlock } from '../src/ir';

const model = (blocks: DocumentModel['blocks'], over: Partial<DocumentModel> = {}): DocumentModel => ({
	page: { width: 612, height: 792, landscape: false, margins: { top: 36, right: 36, bottom: 36, left: 36 } },
	furniture: [],
	blocks,
	footnotes: [],
	numbering: [],
	base: { font: 'Arial', size: 12, color: '000000', lineRatio: 1.5 },
	styles: [],
	fontLineHeights: { Arial: 1.15 },
	fontCenters: { Arial: 1.1176 },
	...over,
});

const para = (text: string, over: Partial<ParaBlock['props']> = {}, block: Partial<ParaBlock> = {}): ParaBlock => ({
	kind: 'para',
	props: { spaceBefore: 0, spaceAfter: 0, lineRatio: 1.5, fontSize: 12, font: 'Arial', ...over },
	runs: [{ kind: 'text', text, format: { font: 'Arial', size: 12 } }],
	marginTop: 0,
	marginBottom: 0,
	...block,
});

async function documentXml(m: DocumentModel, part = 'word/document.xml'): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'wex-'));
	const file = join(dir, 'out.docx');
	writeFileSync(file, await toDocxBytes(m));
	return execFileSync('unzip', ['-p', file, part]).toString('utf8');
}

describe('emitter', () => {
	it('writes text with CSS line height as an at-least line rule', async () => {
		const xml = await documentXml(model([para('Hello')]));
		expect(xml).toContain('Hello');
		// 1.5 × 12pt = 18pt = 360 twips.
		expect(xml).toMatch(/w:line="360" w:lineRule="atLeast"/);
	});

	it("raises text by half its extra leading and hands the space to the next paragraph", async () => {
		const xml = await documentXml(model([para('A', {}, { top: 20, bottom: 38 }), para('B', {}, { top: 50, bottom: 68 })]));
		const spacings = [...xml.matchAll(/<w:spacing ([^>]*)\/>/g)].map((m) => m[1]!);
		const before = spacings.map((s) => Number(/w:before="(\d+)"/.exec(s)?.[1] ?? 0));
		// (1.5 - 1.1176) / 2 × 12pt ≈ 2.3pt ≈ 46 twips: A rises by that much,
		// and B gets it back before rising by the same amount itself.
		expect(before[0]).toBe(400 - 46);
		expect(before[1]).toBe(240);
	});

	it('uses an exact height for text lines tighter than the font', async () => {
		const xml = await documentXml(model([para('Tight', { lineRatio: 1.0 })]));
		expect(xml).toMatch(/w:lineRule="exact"/);
	});

	it('writes native footnotes', async () => {
		const m = model([{ ...para('Body'), runs: [{ kind: 'text', text: 'Body', format: {} }, { kind: 'footnote-ref', id: 1 }] }], {
			footnotes: [{ id: 1, blocks: [para('Note text')] }],
		});
		expect(await documentXml(m)).toContain('w:footnoteReference');
		expect(await documentXml(m, 'word/footnotes.xml')).toContain('Note text');
	});

	it('embeds OMML equations', async () => {
		const omml =
			'<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>';
		const xml = await documentXml(model([{ ...para(''), runs: [{ kind: 'math', omml }] }]));
		expect(xml).toContain('<m:oMath');
	});

	it('moves a cell’s trailing space into its bottom padding', async () => {
		const cellPara = para('In cell', {}, { top: 10, bottom: 28 });
		const xml = await documentXml(
			model([
				{
					kind: 'table',
					columnWidths: [200],
					indentLeft: 0,
					marginTop: 0,
					marginBottom: 0,
					rows: [
						{
							cells: [
								{
									blocks: [cellPara],
									width: 200,
									borders: {},
									padding: { top: 6, right: 6, bottom: 6, left: 6 },
									contentTop: 10,
									contentBottom: 40,
								},
							],
						},
					],
				},
			]),
		);
		// 12pt of trailing space plus the leading shift, on top of 6pt padding.
		const bottom = Number(/<w:tcMar>.*?<w:bottom w:type="dxa" w:w="(\d+)"/s.exec(xml)?.[1]);
		expect(bottom).toBeGreaterThan(120 + 240);
	});
});
