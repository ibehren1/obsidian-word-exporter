import type { Inline } from '../ir';

/** Drops whitespace CSS wouldn't render: at the start and end of lines. */
export function trimRuns(runs: Inline[]): Inline[] {
	const out = runs.map((r) => (r.kind === 'text' ? { ...r } : r));
	// Spaces at a line start are dropped, as is a space right after another.
	let dropSpace = true;
	for (const r of out) {
		if (r.kind === 'break') {
			dropSpace = true;
		} else if (r.kind === 'text') {
			if (dropSpace) r.text = r.text.replace(/^ +/, '');
			if (r.text) dropSpace = r.text.endsWith(' ');
		} else if (r.kind !== 'footnote-ref') {
			dropSpace = false;
		}
	}
	let atLineEnd = true;
	for (let i = out.length - 1; i >= 0; i--) {
		const r = out[i]!;
		if (r.kind === 'break') {
			atLineEnd = true;
			continue;
		}
		if (r.kind !== 'text') {
			atLineEnd = false;
			continue;
		}
		if (atLineEnd) r.text = r.text.replace(/ +$/, '');
		if (r.text) atLineEnd = false;
	}
	return out.filter((r) => r.kind !== 'text' || r.text.length > 0);
}
