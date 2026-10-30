import type { NumberingDef, NumberingLevel } from '../ir';

// Word numbering is defined up front per list, one level per nesting depth.
// Each top-level list gets its own definition so ordered lists restart and
// indents can follow where the list sits on the page. A nested list whose
// marker style clashes with what its root already uses at that depth gets a
// definition of its own.

/** Marker glyphs and the fonts that draw them like Chromium's list markers. */
const BULLETS: Record<string, { text: string; font: string }> = {
	disc: { text: '\uF0B7', font: 'Symbol' },
	circle: { text: 'o', font: 'Courier New' },
	square: { text: '\uF0A7', font: 'Wingdings' },
	// Task checkboxes: an empty box and a box with a check mark.
	'task-open': { text: '\uF0A8', font: 'Wingdings' },
	'task-done': { text: '\uF0FE', font: 'Wingdings' },
};

export function levelFormat(
	listStyleType: string,
): Pick<NumberingLevel, 'format' | 'text'> & { ordered: boolean; font?: string } {
	switch (listStyleType) {
		case 'decimal':
		case 'decimal-leading-zero':
			return { format: 'decimal', text: '', ordered: true };
		case 'lower-alpha':
		case 'lower-latin':
			return { format: 'lowerLetter', text: '', ordered: true };
		case 'upper-alpha':
		case 'upper-latin':
			return { format: 'upperLetter', text: '', ordered: true };
		case 'lower-roman':
			return { format: 'lowerRoman', text: '', ordered: true };
		case 'upper-roman':
			return { format: 'upperRoman', text: '', ordered: true };
		case 'none':
			return { format: 'none', text: '', ordered: false };
		default: {
			const b = BULLETS[listStyleType] ?? BULLETS.disc!;
			return { format: 'bullet', text: b.text, font: b.font, ordered: false };
		}
	}
}

export interface LevelRequest {
	listStyleType: string;
	start: number;
	indentLeft: number;
	hanging: number;
	font?: string;
	color?: string;
	size?: number;
}

const sameLevel = (a: NumberingLevel, b: NumberingLevel) =>
	a.format === b.format &&
	a.text === b.text &&
	a.start === b.start &&
	Math.abs(a.indentLeft - b.indentLeft) < 0.5 &&
	Math.abs(a.hanging - b.hanging) < 0.5 &&
	a.font === b.font &&
	a.color === b.color &&
	a.size === b.size;

export class NumberingRegistry {
	private defs: NumberingDef[] = [];
	private counter = 0;

	/** Starts a new top-level list and returns its key. */
	newRoot(): string {
		return `list-${++this.counter}`;
	}

	/**
	 * Returns the numbering reference for a list at `depth` under `root`.
	 * Definitions for one root share a reference prefix.
	 */
	reference(root: string, depth: number, req: LevelRequest): string {
		const fmt = levelFormat(req.listStyleType);
		const level: NumberingLevel = {
			level: depth,
			format: fmt.format,
			text: fmt.ordered ? `%${depth + 1}.` : fmt.text,
			start: req.start,
			indentLeft: req.indentLeft,
			hanging: req.hanging,
			alignment: fmt.ordered ? 'right' : 'left',
			font: fmt.ordered ? req.font : fmt.font,
			color: req.color,
			size: req.size,
		};

		for (const def of this.defs) {
			if (!def.reference.startsWith(root + ':')) continue;
			const existing = def.levels[depth];
			if (!existing) {
				def.levels[depth] = level;
				return def.reference;
			}
			if (sameLevel(existing, level)) return def.reference;
		}
		const def: NumberingDef = {
			reference: `${root}:${this.defs.filter((d) => d.reference.startsWith(root + ':')).length}`,
			levels: [],
		};
		def.levels[depth] = level;
		this.defs.push(def);
		return def.reference;
	}

	/** Definitions with every level from 0 to 8 filled, as Word expects. */
	definitions(): NumberingDef[] {
		return this.defs.map((def) => {
			const levels: NumberingLevel[] = [];
			for (let i = 0; i < 9; i++) {
				const known = def.levels[i];
				if (known) {
					levels.push(known);
					continue;
				}
				const prev = levels[i - 1];
				levels.push({
					level: i,
					format: 'bullet',
					text: BULLETS.disc!.text,
					font: BULLETS.disc!.font,
					alignment: 'left',
					start: 1,
					indentLeft: (prev?.indentLeft ?? 0) + 27,
					hanging: prev?.hanging ?? 13.5,
				});
			}
			return { reference: def.reference, levels };
		});
	}
}
