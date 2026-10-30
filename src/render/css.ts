import type { Border, Borders, Box } from '../ir';

// Helpers for turning computed CSS into Word units and values.

let scale = 1;

/** Sets the factor applied to every measurement, like PDF export's downscale percent. */
export function setScale(factor: number) {
	scale = factor;
}

/** CSS pixels to points, scaled onto the page. */
export const pt = (px: number) => ((px * 72) / 96) * scale;

export const parsePx = (v: string | null | undefined): number => {
	const n = parseFloat(v ?? '');
	return Number.isFinite(n) ? n : 0;
};

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const colorCache = new Map<string, Rgba | null>();
let colorCtx: CanvasRenderingContext2D | null = null;

/**
 * Resolves any CSS color (rgb, hsl, oklch, color-mix, named) to sRGB by
 * painting it, since computed values of modern color syntax stay unresolved.
 */
export function parseColor(value: string | null | undefined): Rgba | null {
	if (!value || value === 'transparent' || value === 'none') return null;
	const cached = colorCache.get(value);
	if (cached !== undefined) return cached;

	let result: Rgba | null = null;
	const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
	if (m) {
		const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		result = { r: +m[1]!, g: +m[2]!, b: +m[3]!, a };
	} else {
		if (!colorCtx) {
			const canvas = createEl('canvas');
			canvas.width = canvas.height = 1;
			colorCtx = canvas.getContext('2d', { willReadFrequently: true });
		}
		if (colorCtx) {
			colorCtx.clearRect(0, 0, 1, 1);
			colorCtx.fillStyle = '#000';
			colorCtx.fillStyle = value;
			colorCtx.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
			result = { r: r!, g: g!, b: b!, a: a! / 255 };
		}
	}
	if (result && result.a === 0) result = null;
	colorCache.set(value, result);
	return result;
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** Flattens a color over a backdrop (white paper by default) into hex. */
export function toHex(c: Rgba, backdrop: Rgba = { r: 255, g: 255, b: 255, a: 1 }): string {
	const mix = (fg: number, bg: number) => fg * c.a + bg * (1 - c.a);
	return (hex2(mix(c.r, backdrop.r)) + hex2(mix(c.g, backdrop.g)) + hex2(mix(c.b, backdrop.b))).toUpperCase();
}

/**
 * Blends a color with what's behind it as CSS mix-blend-mode does, per
 * channel. Unsupported modes leave the color as is.
 */
export function blendHex(src: string, backdrop: string, mode: string): string {
	const s = hexToRgba(src);
	const b = hexToRgba(backdrop);
	const f = (cs: number, cb: number): number => {
		switch (mode) {
			case 'darken':
				return Math.min(cs, cb);
			case 'lighten':
				return Math.max(cs, cb);
			case 'multiply':
				return (cs * cb) / 255;
			case 'screen':
				return cs + cb - (cs * cb) / 255;
			default:
				return cs;
		}
	};
	return toHex({ r: f(s.r, b.r), g: f(s.g, b.g), b: f(s.b, b.b), a: 1 });
}

export function hexToRgba(hex: string): Rgba {
	const n = parseInt(hex, 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

/** Converts a color to hex, or undefined when it's fully transparent. */
export function colorHex(value: string | null | undefined, backdrop?: string): string | undefined {
	const c = parseColor(value);
	if (!c) return undefined;
	return toHex(c, backdrop ? hexToRgba(backdrop) : undefined);
}

function side(style: CSSStyleDeclaration, name: 'Top' | 'Right' | 'Bottom' | 'Left', backdrop?: string): Border | undefined {
	const kind = style.getPropertyValue(`border-${name.toLowerCase()}-style`);
	const width = parsePx(style.getPropertyValue(`border-${name.toLowerCase()}-width`));
	if (!kind || kind === 'none' || kind === 'hidden' || width <= 0) return undefined;
	const color = colorHex(style.getPropertyValue(`border-${name.toLowerCase()}-color`), backdrop);
	if (!color) return undefined;
	return {
		width: pt(width),
		color,
		style: kind === 'dashed' ? 'dashed' : kind === 'dotted' ? 'dotted' : kind === 'double' ? 'double' : 'single',
	};
}

export function bordersOf(style: CSSStyleDeclaration, backdrop?: string): Borders {
	return {
		top: side(style, 'Top', backdrop),
		right: side(style, 'Right', backdrop),
		bottom: side(style, 'Bottom', backdrop),
		left: side(style, 'Left', backdrop),
	};
}

export const hasBorder = (b: Borders) => !!(b.top || b.right || b.bottom || b.left);

export function paddingOf(style: CSSStyleDeclaration): Box {
	return {
		top: pt(parsePx(style.paddingTop)),
		right: pt(parsePx(style.paddingRight)),
		bottom: pt(parsePx(style.paddingBottom)),
		left: pt(parsePx(style.paddingLeft)),
	};
}

const GENERIC = new Set([
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-serif',
	'ui-sans-serif',
	'ui-monospace',
	'ui-rounded',
	'-apple-system',
	'blinkmacsystemfont',
	'emoji',
	'math',
	'??',
]);

/** Fonts Word can't use or that only exist as browser aliases. */
const isConcrete = (family: string) => !GENERIC.has(family.toLowerCase()) && !family.includes('Emoji');

export function splitFamilies(value: string): string[] {
	return value
		.split(',')
		.map((f) => f.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

/** Picks the first installed, concrete font from a font-family list. */
export function resolveFont(value: string, fallback: string): string {
	for (const family of splitFamilies(value)) {
		if (!isConcrete(family)) continue;
		try {
			if (document.fonts.check(`12px "${family}"`) && isInstalled(family)) return family;
		} catch {
			// Invalid family names throw; skip them.
		}
	}
	return fallback;
}

const spaceCache = new Map<string, number>();

/** Width of a no-break space in a font, as a multiple of the font size. */
export function spaceRatio(family: string): number {
	const cached = spaceCache.get(family);
	if (cached !== undefined) return cached;
	const ctx = createEl('canvas').getContext('2d');
	let ratio = 0.278;
	if (ctx) {
		ctx.font = `100px "${family}"`;
		ratio = ctx.measureText('\u00a0').width / 100 || ratio;
	}
	spaceCache.set(family, ratio);
	return ratio;
}

const installedCache = new Map<string, boolean>();

/**
 * document.fonts.check() reports true for fonts that don't exist, so compare
 * glyph widths against two generic fallbacks to see whether the font renders.
 */
export function isInstalled(family: string): boolean {
	const cached = installedCache.get(family);
	if (cached !== undefined) return cached;
	const canvas = createEl('canvas');
	const ctx = canvas.getContext('2d');
	let found = false;
	if (ctx) {
		const sample = 'mmmmmmmmmmlliWWW0123';
		for (const generic of ['monospace', 'serif', 'sans-serif']) {
			ctx.font = `32px ${generic}`;
			const base = ctx.measureText(sample).width;
			ctx.font = `32px "${family}", ${generic}`;
			if (ctx.measureText(sample).width !== base) {
				found = true;
				break;
			}
		}
	}
	installedCache.set(family, found);
	return found;
}

/**
 * Measures a font's natural line height ("line-height: normal") as a multiple
 * of its size. Word's single spacing uses the same metrics, so CSS line
 * heights convert to Word line multiples by dividing by this.
 */
export function naturalLineHeight(family: string): number {
	// A block's height includes the font's line gap, as Word's does; an
	// inline span's would only cover ascent plus descent.
	const probe = document.body.createDiv();
	probe.setText('Hg');
	probe.setCssStyles({
		position: 'absolute',
		display: 'block',
		visibility: 'hidden',
		fontFamily: `"${family}"`,
		fontSize: '100px',
		lineHeight: 'normal',
		whiteSpace: 'nowrap',
	});
	const h = probe.getBoundingClientRect().height;
	probe.remove();
	return h > 0 ? h / 100 : 1.15;
}
