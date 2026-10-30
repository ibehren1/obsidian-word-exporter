import type { Furniture, ImageData, ParaBlock, RunFormat } from '../ir';
import { bordersOf, colorHex, paddingOf, parseColor, parsePx, pt, resolveFont } from '../render/css';

// Page furniture: what CSS snippets draw on every printed page with
// `position: fixed` pseudo-elements on <html> or <body>, such as
// watermarks, logos and footers. The render lays these out against a box the
// size of the page's printable area, so their computed positions are page
// positions. Plain text becomes a Word text frame; rotated text and
// background images become pictures.

const RASTER_SCALE = 300 / 96;

/** Decodes a computed `content` value into text, or null if it isn't text. */
export function cssContentText(content: string): string | null {
	const strings = content.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g);
	if (!strings) return null;
	return strings
		.map((s) =>
			s
				.slice(1, -1)
				.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
				.replace(/\\(.)/g, '$1'),
		)
		.join('');
}

function backgroundUrl(value: string): string | null {
	const m = /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value);
	return m ? m[2]! : null;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = src;
	});
}

function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => {
			if (!blob) return resolve(null);
			blob.arrayBuffer().then(
				(buf) => resolve(new Uint8Array(buf)),
				() => resolve(null),
			);
		}, 'image/png');
	});
}

/** Rotation angle (radians) and translation (px) of a computed transform. */
function transformOf(value: string): { angle: number; tx: number; ty: number } {
	const m = /matrix\(([^)]+)\)/.exec(value);
	if (!m) return { angle: 0, tx: 0, ty: 0 };
	const [a, b, , , e, f] = m[1]!.split(',').map(Number);
	return { angle: Math.atan2(b ?? 0, a ?? 1), tx: e ?? 0, ty: f ?? 0 };
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The pseudo-element's box in the page area, in CSS pixels. */
function boxOf(cs: CSSStyleDeclaration, area: { width: number; height: number }): Box {
	const width = parsePx(cs.width);
	const height = parsePx(cs.height);
	const left = cs.left !== 'auto' ? parsePx(cs.left) : area.width - parsePx(cs.right) - width;
	const top = cs.top !== 'auto' ? parsePx(cs.top) : area.height - parsePx(cs.bottom) - height;
	return { left, top, width, height };
}

/** Draws (possibly rotated) text as a transparent PNG, the way the browser would paint it. */
async function textImage(text: string, cs: CSSStyleDeclaration, box: Box, angle: number): Promise<{ image: ImageData; w: number; h: number } | null> {
	const size = parsePx(cs.fontSize);
	const lines = text.split('\n');
	const lineHeight = parsePx(cs.lineHeight) || size * 1.2;
	const measure = createEl('canvas').getContext('2d');
	if (!measure) return null;
	const font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
	measure.font = font;
	measure.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
	const textWidth = Math.max(...lines.map((l) => measure.measureText(l).width));
	const w = Math.max(box.width, textWidth);
	const h = Math.max(box.height, lines.length * lineHeight);
	const cos = Math.abs(Math.cos(angle));
	const sin = Math.abs(Math.sin(angle));
	const bw = w * cos + h * sin;
	const bh = w * sin + h * cos;

	const canvas = createEl('canvas');
	canvas.width = Math.ceil(bw * RASTER_SCALE);
	canvas.height = Math.ceil(bh * RASTER_SCALE);
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(RASTER_SCALE, RASTER_SCALE);
	ctx.translate(bw / 2, bh / 2);
	ctx.rotate(angle);
	ctx.font = font;
	ctx.letterSpacing = measure.letterSpacing;
	ctx.textBaseline = 'middle';
	const c = parseColor(cs.color);
	ctx.fillStyle = c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a * (parseFloat(cs.opacity) || 1)})` : '#000';
	const align = cs.textAlign;
	lines.forEach((line, i) => {
		const lw = ctx.measureText(line).width;
		const x = align === 'left' || align === 'start' ? -w / 2 : align === 'right' || align === 'end' ? w / 2 - lw : -lw / 2;
		ctx.fillText(line, x, -h / 2 + lineHeight * (i + 0.5));
	});
	const data = await toPng(canvas);
	return data ? { image: { data, type: 'png', width: pt(bw), height: pt(bh) }, w: bw, h: bh } : null;
}

/** A background image drawn the way background-size and -position place it in the box. */
async function backgroundImage(url: string, cs: CSSStyleDeclaration, box: Box): Promise<{ image: ImageData; dx: number; dy: number } | null> {
	const img = await loadImage(url);
	if (!img || !img.naturalWidth) return null;
	const nw = img.naturalWidth;
	const nh = img.naturalHeight;
	let dw = nw;
	let dh = nh;
	const sizeValue = cs.backgroundSize;
	if (sizeValue === 'contain' || sizeValue === 'cover') {
		const s = sizeValue === 'contain' ? Math.min(box.width / nw, box.height / nh) : Math.max(box.width / nw, box.height / nh);
		dw = nw * s;
		dh = nh * s;
	} else if (sizeValue !== 'auto' && sizeValue !== 'auto auto') {
		const [sw, sh] = sizeValue.split(/\s+/);
		dw = sw?.endsWith('%') ? (box.width * parseFloat(sw)) / 100 : parsePx(sw) || nw;
		dh = sh && sh !== 'auto' ? (sh.endsWith('%') ? (box.height * parseFloat(sh)) / 100 : parsePx(sh)) : (dw / nw) * nh;
	}
	const [px = '0%', py = '0%'] = cs.backgroundPosition.split(/\s+/);
	const offset = (v: string, free: number) => (v.endsWith('%') ? (free * parseFloat(v)) / 100 : parsePx(v));
	const dx = offset(px, box.width - dw);
	const dy = offset(py, box.height - dh);

	const canvas = createEl('canvas');
	canvas.width = Math.max(1, Math.round(dw * RASTER_SCALE));
	canvas.height = Math.max(1, Math.round(dh * RASTER_SCALE));
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.globalAlpha = parseFloat(cs.opacity) || 1;
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	const data = await toPng(canvas);
	return data ? { image: { data, type: 'png', width: pt(dw), height: pt(dh) }, dx, dy } : null;
}

/** Plain text furniture as a paragraph laid out in a Word text frame. */
function textFrame(text: string, cs: CSSStyleDeclaration, box: Box, bodyFont: string): Furniture {
	const format: RunFormat = {
		font: resolveFont(cs.fontFamily, bodyFont),
		size: pt(parsePx(cs.fontSize)),
		bold: parseInt(cs.fontWeight, 10) >= 600,
		italic: cs.fontStyle === 'italic',
		color: colorHex(cs.color),
	};
	const pad = paddingOf(cs);
	const borders = bordersOf(cs);
	const lh = parsePx(cs.lineHeight);
	const runs: ParaBlock['runs'] = [];
	text.split('\n').forEach((line, i) => {
		if (i > 0) runs.push({ kind: 'break', format });
		if (line) runs.push({ kind: 'text', text: line, format });
	});
	const align = cs.textAlign;
	const para: ParaBlock = {
		kind: 'para',
		runs,
		marginTop: 0,
		marginBottom: 0,
		props: {
			spaceBefore: 0,
			spaceAfter: 0,
			fontSize: format.size,
			font: format.font,
			lineRatio: lh > 0 ? lh / parsePx(cs.fontSize) : undefined,
			alignment: align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'right' : undefined,
			borders,
			borderSpace: pad,
		},
	};
	return { kind: 'text', para, x: pt(box.left), y: pt(box.top), width: pt(box.width), height: pt(box.height) };
}

export async function pageFurniture(
	elements: HTMLElement[],
	area: { width: number; height: number },
	bodyFont: string,
): Promise<Furniture[]> {
	const out: Furniture[] = [];
	for (const el of elements) {
		for (const pseudo of ['::before', '::after']) {
			const cs = getComputedStyle(el, pseudo);
			if (cs.position !== 'fixed' || cs.display === 'none') continue;
			if (cs.content === 'none' || cs.content === 'normal') continue;
			const box = boxOf(cs, area);
			const { angle, tx, ty } = transformOf(cs.transform);
			// Transforms apply around the box's center by default.
			const cx = box.left + box.width / 2 + tx;
			const cy = box.top + box.height / 2 + ty;

			const url = backgroundUrl(cs.backgroundImage);
			if (url && box.width > 0 && box.height > 0) {
				const bg = await backgroundImage(url, cs, box);
				if (bg) {
					out.push({
						kind: 'image',
						image: bg.image,
						x: pt(cx - box.width / 2 + bg.dx),
						y: pt(cy - box.height / 2 + bg.dy),
						behindText: true,
					});
				}
			}

			const text = cssContentText(cs.content);
			if (!text?.trim()) continue;
			if (Math.abs(angle) > 0.001) {
				const drawn = await textImage(text, cs, box, angle);
				if (drawn) {
					out.push({ kind: 'image', image: drawn.image, x: pt(cx - drawn.w / 2), y: pt(cy - drawn.h / 2), behindText: true });
				}
			} else {
				out.push(textFrame(text, cs, box, bodyFont));
			}
		}
	}
	return out;
}
