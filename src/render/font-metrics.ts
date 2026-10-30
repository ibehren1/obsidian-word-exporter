import { Platform } from 'obsidian';
import { nodeFs, processEnv, type NodeFs } from '../node';

// Word lays out lines with a font's Windows metrics (OS/2 winAscent and
// winDescent plus external leading), which can differ from the metrics the
// browser uses. Reading them from the installed font files lets the export
// predict Word's line heights. Desktop only; any failure falls back to the
// browser's measurement.

function fontDirs(): string[] {
	const env = processEnv();
	const home = env.HOME ?? env.USERPROFILE ?? '';
	if (Platform.isMacOS) {
		return [
			`${home}/Library/Fonts`,
			'/Library/Fonts',
			'/System/Library/Fonts',
			'/System/Library/Fonts/Supplemental',
			'/Applications/Microsoft Word.app/Contents/Resources/DFonts',
		];
	}
	if (Platform.isWin) {
		return [`${env.WINDIR ?? 'C:\\Windows'}\\Fonts`, `${env.LOCALAPPDATA ?? ''}\\Microsoft\\Windows\\Fonts`];
	}
	return ['/usr/share/fonts', '/usr/local/share/fonts', `${home}/.fonts`, `${home}/.local/share/fonts`];
}

class FontFile {
	private fd: number;
	constructor(
		private readonly fs: NodeFs,
		path: string,
	) {
		this.fd = fs.openSync(path, 'r');
	}
	read(position: number, length: number): DataView {
		const buf = new Uint8Array(length);
		this.fs.readSync(this.fd, buf, 0, length, position);
		return new DataView(buf.buffer);
	}
	close() {
		this.fs.closeSync(this.fd);
	}
}

type Tables = Map<string, { offset: number; length: number }>;

function tables(file: FontFile, base: number): Tables {
	const head = file.read(base, 12);
	const count = head.getUint16(4);
	const dir = file.read(base + 12, count * 16);
	const out: Tables = new Map();
	for (let i = 0; i < count; i++) {
		const tag = String.fromCharCode(dir.getUint8(i * 16), dir.getUint8(i * 16 + 1), dir.getUint8(i * 16 + 2), dir.getUint8(i * 16 + 3));
		out.set(tag, { offset: dir.getUint32(i * 16 + 8), length: dir.getUint32(i * 16 + 12) });
	}
	return out;
}

/** Family and subfamily names from the name table, preferring typographic names. */
function names(file: FontFile, t: Tables): { family: string; sub: string } | null {
	const entry = t.get('name');
	if (!entry) return null;
	const v = file.read(entry.offset, Math.min(entry.length, 65536));
	const count = v.getUint16(2);
	const strings = v.getUint16(4);
	const found: Record<number, string> = {};
	for (let i = 0; i < count; i++) {
		const r = 6 + i * 12;
		if (r + 12 > v.byteLength) break;
		const platform = v.getUint16(r);
		const lang = v.getUint16(r + 4);
		const id = v.getUint16(r + 6);
		const len = v.getUint16(r + 8);
		const off = strings + v.getUint16(r + 10);
		if (![1, 2, 16, 17].includes(id) || off + len > v.byteLength) continue;
		let s = '';
		if (platform === 3 || platform === 0) {
			if (platform === 3 && lang !== 0x409 && found[id]) continue;
			for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(v.getUint16(off + j));
		} else if (platform === 1 && !found[id]) {
			for (let j = 0; j < len; j++) s += String.fromCharCode(v.getUint8(off + j));
		} else continue;
		found[id] = s;
	}
	const family = found[16] ?? found[1];
	return family ? { family, sub: found[17] ?? found[2] ?? '' } : null;
}

export interface WordFontMetrics {
	/** Word's single line height as a multiple of the font size. */
	lineHeight: number;
	/**
	 * Where text sits in a line, as a reference height: in a line of height
	 * L (in ems), Word sets the text (L - center) / 2 lower than CSS, which
	 * centers it on the font's ascent and descent.
	 */
	center: number;
}

function metricsOf(file: FontFile, t: Tables): WordFontMetrics | null {
	const head = t.get('head');
	const hhea = t.get('hhea');
	const os2 = t.get('OS/2');
	if (!head || !hhea || !os2) return null;
	const upm = file.read(head.offset + 18, 2).getUint16(0);
	const h = file.read(hhea.offset + 4, 6);
	const ascender = h.getInt16(0);
	const descender = h.getInt16(2);
	const lineGap = h.getInt16(4);
	const o = file.read(os2.offset + 74, 4);
	const winAscent = o.getUint16(0);
	const winDescent = o.getUint16(2);
	if (!upm) return null;
	// Windows' external leading: what the line gap adds beyond the win metrics.
	const external = Math.max(0, lineGap - (winAscent + winDescent - (ascender - descender)));
	const lineHeight = (winAscent + winDescent + external) / upm;
	// Word puts a line's extra space and the external leading above the win
	// ascent; CSS splits the extra space around the ascent and descent.
	const center = 2 * (lineHeight - (external + winAscent - ascender) / upm) - (ascender - descender) / upm;
	return { lineHeight, center };
}

let index: Map<string, WordFontMetrics> | null = null;

function walk(fs: NodeFs, dir: string, out: string[], depth = 0) {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = `${dir}/${name}`;
		if (/\.(ttf|otf|ttc)$/i.test(name)) out.push(path);
		else if (depth < 3 && !name.includes('.')) {
			try {
				if (fs.statSync(path).isDirectory()) walk(fs, path, out, depth + 1);
			} catch {
				// Unreadable entries are skipped.
			}
		}
	}
}

/** Builds family → line height from installed fonts, regular faces preferred. */
function buildIndex(): Map<string, WordFontMetrics> {
	const out = new Map<string, WordFontMetrics>();
	const regular = new Set<string>();
	const fs = nodeFs();
	if (!fs) return out;
	const files: string[] = [];
	for (const dir of fontDirs()) walk(fs, dir, files);
	for (const path of files) {
		let file: FontFile | null = null;
		try {
			file = new FontFile(fs, path);
			const sig = file.read(0, 12);
			// A collection: read its first font.
			const base = sig.getUint32(0) === 0x74746366 ? sig.getUint32(12) : 0;
			const t = tables(file, base);
			const n = names(file, t);
			if (!n) continue;
			const key = n.family.toLowerCase();
			const isRegular = /^(regular|book|roman|normal)$/i.test(n.sub);
			if (out.has(key) && (regular.has(key) || !isRegular)) continue;
			const metrics = metricsOf(file, t);
			if (metrics) {
				out.set(key, metrics);
				if (isRegular) regular.add(key);
			}
		} catch {
			// Not a font we can read.
		} finally {
			file?.close();
		}
	}
	return out;
}

/** Word's line metrics for a font family, or null if its file can't be found. */
export function wordFontMetrics(family: string): WordFontMetrics | null {
	index ??= buildIndex();
	return index.get(family.toLowerCase()) ?? null;
}
