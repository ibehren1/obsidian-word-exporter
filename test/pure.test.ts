import { describe, expect, it } from 'vitest';
import { NumberingRegistry, levelFormat } from '../src/convert/lists';
import { trimRuns } from '../src/convert/runs';
import { cssContentText } from '../src/convert/furniture';
import { isHostLayout, mediaApplies, scopeSelector, splitList, targetsHost } from '../src/render/css-scope';
import type { Inline } from '../src/ir';

const text = (t: string): Inline => ({ kind: 'text', text: t, format: {} });

describe('trimRuns', () => {
	it('drops spaces at line starts and ends and collapses doubled spaces across runs', () => {
		const out = trimRuns([text(' a '), text(' b'), { kind: 'break', format: {} }, text('  c ')]);
		expect(out.map((r) => (r.kind === 'text' ? r.text : '|'))).toEqual(['a ', 'b', '|', 'c']);
	});

	it('removes runs that end up empty', () => {
		expect(trimRuns([text('  '), text('x')])).toHaveLength(1);
	});
});

describe('NumberingRegistry', () => {
	it('gives each top-level list its own definition so numbering restarts', () => {
		const reg = new NumberingRegistry();
		const req = { listStyleType: 'decimal', start: 1, indentLeft: 27, hanging: 4 };
		const a = reg.reference(reg.newRoot(), 0, req);
		const b = reg.reference(reg.newRoot(), 0, req);
		expect(a).not.toBe(b);
	});

	it('shares a definition across depths of one list and fills all nine levels', () => {
		const reg = new NumberingRegistry();
		const root = reg.newRoot();
		const a = reg.reference(root, 0, { listStyleType: 'disc', start: 1, indentLeft: 27, hanging: 14 });
		const b = reg.reference(root, 1, { listStyleType: 'circle', start: 1, indentLeft: 54, hanging: 14 });
		expect(a).toBe(b);
		const [def] = reg.definitions();
		expect(def!.levels).toHaveLength(9);
		expect(def!.levels[1]!.font).toBe('Courier New');
	});

	it('splits off a definition when a nested list clashes with its root at that depth', () => {
		const reg = new NumberingRegistry();
		const root = reg.newRoot();
		const a = reg.reference(root, 1, { listStyleType: 'decimal', start: 1, indentLeft: 54, hanging: 4 });
		const b = reg.reference(root, 1, { listStyleType: 'disc', start: 1, indentLeft: 54, hanging: 14 });
		expect(a).not.toBe(b);
	});

	it('maps CSS list styles to Word formats', () => {
		expect(levelFormat('lower-roman').format).toBe('lowerRoman');
		expect(levelFormat('task-done').font).toBe('Wingdings');
	});
});

describe('cssContentText', () => {
	it('decodes CSS string escapes', () => {
		expect(cssContentText('"AWS Confidential\\A Do Not Redistribute"')).toBe('AWS Confidential\nDo Not Redistribute');
		expect(cssContentText('"Copyright \\A9  2026"')).toBe('Copyright © 2026');
	});

	it('returns null for non-text content', () => {
		expect(cssContentText('none')).toBeNull();
	});
});

describe('scopeSelector', () => {
	const isBody = (c: string) => c === '.theme-light' || c === '.mod-macos';

	it('maps html and body selectors onto the stand-ins', () => {
		expect(scopeSelector('body', isBody)).toBe('#word-exporter-body');
		expect(scopeSelector('html::after', isBody)).toBe('#word-exporter-html::after');
		expect(scopeSelector('html body .x', isBody)).toBe('#word-exporter-body .x');
		expect(scopeSelector('body::before', isBody)).toBe('#word-exporter-body::before');
	});

	it('treats classes that sit on body as body', () => {
		expect(scopeSelector('.theme-light .callout', isBody)).toBe('#word-exporter-body.theme-light .callout');
	});

	it('nests everything else inside body', () => {
		expect(scopeSelector('.markdown-rendered p + h2', isBody)).toBe('#word-exporter-body .markdown-rendered p + h2');
	});

	it('tells rules on the stand-ins themselves from rules inside them', () => {
		expect(targetsHost('#word-exporter-body')).toBe(true);
		expect(targetsHost('#word-exporter-body.theme-light:not(.x)')).toBe(true);
		expect(targetsHost('#word-exporter-html')).toBe(true);
		expect(targetsHost('#word-exporter-html::after')).toBe(false);
		expect(targetsHost('#word-exporter-body .x')).toBe(false);
	});

	it('withholds only the stand-ins\' layout properties', () => {
		for (const p of ['position', 'top', 'width', 'height', 'overflow-y', 'padding-left', 'margin-top', 'transform']) {
			expect(isHostLayout(p)).toBe(true);
		}
		for (const p of ['font-size', 'color', 'background-color', '--font-text', 'max-width']) {
			expect(isHostLayout(p)).toBe(false);
		}
	});

	it('splits selector lists at top-level commas only', () => {
		expect(splitList('a, :is(b, c), d')).toEqual(['a', ':is(b, c)', 'd']);
	});
});

describe('mediaApplies', () => {
	it('evaluates queries as printing does', () => {
		expect(mediaApplies('print', 800)).toBe(true);
		expect(mediaApplies('screen', 800)).toBe(false);
		expect(mediaApplies('(hover: hover)', 800)).toBe(false);
		expect(mediaApplies('(max-width: 400px)', 800)).toBe(false);
		expect(mediaApplies('(min-width: 400px)', 800)).toBe(true);
		expect(mediaApplies('screen, print', 800)).toBe(true);
	});
});
