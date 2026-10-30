import { requestUrl } from 'obsidian';
import type { ImageData } from '../ir';
import { pt } from '../render/css';

// Turns rendered images and SVGs into bytes Word can show. Word reads PNG,
// JPEG, GIF and BMP; everything else (SVG, WebP, AVIF) is rasterized.

/** Rasterize at print resolution so diagrams and icons stay crisp. */
const RASTER_SCALE = 300 / 96;

type Format = ImageData['type'];

function sniff(bytes: Uint8Array): Format | 'svg' | null {
	const b = bytes;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
	if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
	if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
	const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
	if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
	return null;
}

function decodeDataUrl(url: string): Uint8Array | null {
	const comma = url.indexOf(',');
	if (comma < 0) return null;
	const meta = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	if (meta.endsWith(';base64')) {
		const bin = atob(payload);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	return new TextEncoder().encode(decodeURIComponent(payload));
}

type ReadLocal = (path: string) => Promise<Uint8Array | null>;

async function fetchBytes(src: string, readLocal?: ReadLocal): Promise<Uint8Array | null> {
	try {
		if (/^https?:/i.test(src)) {
			const res = await requestUrl({ url: src, throw: false });
			if (res.status >= 400) return null;
			return new Uint8Array(res.arrayBuffer);
		}
		if (src.startsWith('data:')) return decodeDataUrl(src);
		if (src.startsWith('app://') && readLocal) {
			// Obsidian serves local files as app://<id>/<absolute path>?<mtime>.
			const path = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, '$1');
			return await readLocal(path);
		}
		return null;
	} catch {
		return null;
	}
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		try {
			canvas.toBlob((blob) => {
				if (!blob) return resolve(null);
				blob.arrayBuffer().then(
					(buf) => resolve(new Uint8Array(buf)),
					() => resolve(null),
				);
			}, 'image/png');
		} catch {
			// A tainted canvas (cross-origin image) can't be read back.
			resolve(null);
		}
	});
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = src;
	});
}

/** Draws an image source onto a canvas at the given CSS size times the raster scale. */
async function rasterize(
	source: CanvasImageSource,
	widthPx: number,
	heightPx: number,
	radiusPx = 0,
): Promise<Uint8Array | null> {
	const canvas = createEl('canvas');
	canvas.width = Math.max(1, Math.round(widthPx * RASTER_SCALE));
	canvas.height = Math.max(1, Math.round(heightPx * RASTER_SCALE));
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	if (radiusPx > 0) {
		ctx.beginPath();
		ctx.roundRect(0, 0, canvas.width, canvas.height, radiusPx * RASTER_SCALE);
		ctx.clip();
	}
	ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
	return canvasToPng(canvas);
}

async function rasterizeSvgText(svg: string, widthPx: number, heightPx: number): Promise<Uint8Array | null> {
	const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	const img = await loadImage(url);
	if (!img) return null;
	return rasterize(img, widthPx, heightPx);
}

/** Replaces CSS variables and currentColor with their values so the SVG renders standalone. */
function resolveSvgStyles(svg: string, el: Element): string {
	const style = getComputedStyle(el);
	return svg
		.replace(/currentColor/g, style.color)
		.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_m, name: string, fallback?: string) => {
			const v = style.getPropertyValue(name).trim();
			return v || fallback?.trim() || 'initial';
		});
}

/** Converts an inline SVG element (icons, Mermaid diagrams) to a PNG at its rendered size. */
export async function svgElementToImage(svg: SVGSVGElement): Promise<ImageData | null> {
	const rect = svg.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
	clone.setAttribute('width', String(rect.width));
	clone.setAttribute('height', String(rect.height));
	// Lucide icons inherit stroke and color from CSS, which a standalone image lacks.
	const computed = getComputedStyle(svg);
	if (!clone.getAttribute('stroke') && computed.stroke && computed.stroke !== 'none') {
		clone.setAttribute('stroke', computed.stroke);
	}
	clone.setCssStyles({
		maxWidth: 'none',
		color: computed.color,
		fontFamily: clone.style.fontFamily || computed.fontFamily,
	});

	const text = resolveSvgStyles(new XMLSerializer().serializeToString(clone), svg);
	const data = await rasterizeSvgText(text, rect.width, rect.height);
	if (!data) return null;
	return { data, type: 'png', width: pt(rect.width), height: pt(rect.height) };
}

/** Loads an <img> element's bytes at its rendered size. */
export async function imgElementToImage(img: HTMLImageElement, readLocal?: ReadLocal): Promise<ImageData | null> {
	const rect = img.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const size = { width: pt(rect.width), height: pt(rect.height), alt: img.alt || undefined };

	const bytes = await fetchBytes(img.currentSrc || img.src, readLocal);
	const kind = bytes ? sniff(bytes) : null;
	const radius = parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0;
	if (bytes && kind && kind !== 'svg' && radius <= 0) return { data: bytes, type: kind, ...size };
	if (radius > 0 && img.complete && img.naturalWidth > 0) {
		// Word can't round image corners, so bake them in.
		const scale = Math.min(RASTER_SCALE, img.naturalWidth / rect.width) / RASTER_SCALE;
		const rounded = await rasterize(img, rect.width * scale, rect.height * scale, radius * scale);
		if (rounded) return { data: rounded, type: 'png', ...size };
		if (bytes && kind && kind !== 'svg') return { data: bytes, type: kind, ...size };
	}

	let data: Uint8Array | null = null;
	if (bytes && kind === 'svg') {
		data = await rasterizeSvgText(new TextDecoder().decode(bytes), rect.width, rect.height);
	}
	if (!data && img.complete && img.naturalWidth > 0) {
		// WebP, AVIF and friends: let the browser decode and re-encode as PNG.
		const scale = Math.min(1, img.naturalWidth / (rect.width * RASTER_SCALE));
		data = await rasterize(img, rect.width * scale, rect.height * scale);
		if (!data && bytes) {
			const bitmap = await createImageBitmap(new Blob([bytes as BlobPart])).catch(() => null);
			if (bitmap) data = await rasterize(bitmap, rect.width * scale, rect.height * scale);
		}
	}
	return data ? { data, type: 'png', ...size } : null;
}
