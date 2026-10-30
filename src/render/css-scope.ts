// Rewrites the app's CSS so it applies inside the export host as it would in
// PDF export's print window. Pure string logic, kept apart for testing.

export const HTML_ID = 'word-exporter-html';
export const BODY_ID = 'word-exporter-body';

/** Splits a selector at its first top-level combinator. */
function firstCompound(selector: string): [string, string] {
	let depth = 0;
	for (let i = 0; i < selector.length; i++) {
		const c = selector[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
			return [selector.slice(0, i), selector.slice(i)];
		}
	}
	return [selector, ''];
}

/** Splits a selector list at top-level commas. */
export function splitList(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (c === ',' && depth === 0) {
			out.push(list.slice(start, i));
			start = i + 1;
		}
	}
	out.push(list.slice(start));
	return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Rewrites a selector so it applies inside the export host, whose two outer
 * elements stand in for the print window's <html> and <body>. The ids
 * outrank the app's own rules, so the copy wins wherever both apply.
 */
export function scopeSelector(selector: string, isBody: (compound: string) => boolean): string {
	let [first, rest] = firstCompound(selector.trim());
	const root = /^(html|:root)/.exec(first);
	if (root) {
		first = first.slice(root[0].length);
		const [next, after] = firstCompound(rest.trimStart());
		if (/^\s+/.test(rest) && /^body\b/.test(next)) return `#${BODY_ID}${first}${next.slice(4)}${after}`;
		return `#${HTML_ID}${first}${rest}`;
	}
	const bodyless = first.replace(/^body\b/, '');
	if (first.startsWith('body') || (bodyless && isBody(bodyless))) return `#${BODY_ID}${bodyless}${rest}`;
	return `#${BODY_ID} ${selector.trim()}`;
}

/** Whether a scoped selector matches one of the stand-ins itself, not a descendant or pseudo-element. */
export function targetsHost(scoped: string): boolean {
	const [first, rest] = firstCompound(scoped);
	return !rest && !first.includes('::') && (first.startsWith(`#${HTML_ID}`) || first.startsWith(`#${BODY_ID}`));
}

/**
 * Properties that place and size the stand-ins offscreen (styles.css). The
 * app's html and body rules keep everything else, so the copy can't move or
 * clip the render, even with !important.
 */
const HOST_LAYOUT = /^(position|top|right|bottom|left|inset(-.+)?|width|height|overflow(-.+)?|padding(-.+)?|margin(-.+)?|transform|translate)$/;

export function isHostLayout(property: string): boolean {
	return HOST_LAYOUT.test(property);
}

/** Whether a media query holds when printing a page of the given width. */
export function mediaApplies(media: string, widthPx: number): boolean {
	const text = media.trim().toLowerCase();
	if (!text || text === 'all') return true;
	return splitList(text).some((query) => {
		const negate = query.startsWith('not ');
		const q = negate ? query.slice(4) : query;
		let ok = true;
		if (/\bscreen\b|\bspeech\b/.test(q)) ok = false;
		for (const [, feature, value] of q.matchAll(/\(\s*([\w-]+)\s*(?::\s*([^)]+))?\)/g)) {
			const v = (value ?? '').trim();
			const px = parseFloat(v);
			switch (feature) {
				case 'min-width':
					ok &&= widthPx >= px;
					break;
				case 'max-width':
					ok &&= widthPx <= px;
					break;
				case 'hover':
				case 'any-hover':
					ok &&= v === 'none';
					break;
				case 'pointer':
				case 'any-pointer':
					ok &&= v === 'none';
					break;
				case 'prefers-color-scheme':
					ok &&= v === 'light';
					break;
				default:
					ok &&= window.matchMedia(`(${feature}${value ? `: ${v}` : ''})`).matches;
			}
		}
		return negate ? !ok : ok;
	});
}

