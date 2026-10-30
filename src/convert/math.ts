import { mml2omml } from 'mathml2omml';

// LaTeX -> MathML (Obsidian's MathJax) -> OMML, Word's native equation format,
// so equations stay editable in Word.

interface MathJaxMml {
	tex2mml?: (src: string, opts?: { display?: boolean }) => string;
}

const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function mathJax(): MathJaxMml | undefined {
	return (window as unknown as { MathJax?: MathJaxMml }).MathJax;
}

/** MathJax's assistive MathML, present when its accessibility extension ran. */
function assistiveMml(el: Element): string | null {
	const math = el.querySelector('mjx-assistive-mml math, math');
	return math ? math.outerHTML : null;
}

/**
 * Returns OMML for a rendered math element. Display math is wrapped in an
 * oMathPara so Word centers it on its own line.
 */
export function mathToOmml(el: Element, latex: string | null, display: boolean): string | null {
	let mml: string | null = null;
	const mj = mathJax();
	if (latex !== null && mj?.tex2mml) {
		try {
			mml = mj.tex2mml(latex, { display });
		} catch {
			mml = null;
		}
	}
	mml ??= assistiveMml(el);
	if (!mml) return null;

	let omml: string;
	try {
		omml = fixOmml(mmlToOmml(mml));
	} catch {
		return null;
	}
	if (!display) return omml;
	const inner = omml.replace(/^<m:oMath\b[^>]*>/, '<m:oMath>');
	return `<m:oMathPara xmlns:m="${OMML_NS}" xmlns:w="${W_NS}"><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${inner}</m:oMathPara>`;
}

const RELATIONS = /[=<>≤≥≠≈≡∼≃≅∝→←↔⇒⇐⇔∈∉⊂⊃⊆⊇]/;

const local = (n: Node) => (n as Element).localName;

function text(el: Element): string {
	return Array.from(el.getElementsByTagNameNS(OMML_NS, 't'))
		.map((t) => t.textContent ?? '')
		.join('');
}

/**
 * Repairs mathml2omml output for Word:
 * - n-ary operators (∫, ∑, ∏) get an empty body with the integrand placed
 *   after them; move what follows, up to a relation like "=", into the body.
 * - drops `m:sty="undefined"`, which Word rejects.
 * - empty runs from `\,` and friends become thin spaces.
 */
export function fixOmml(omml: string): string {
	const doc = new DOMParser().parseFromString(omml, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length) return omml;

	for (const sty of Array.from(doc.getElementsByTagNameNS(OMML_NS, 'sty'))) {
		if (!/^(p|b|i|bi)$/.test(sty.getAttributeNS(OMML_NS, 'val') ?? sty.getAttribute('m:val') ?? '')) sty.remove();
	}
	for (const t of Array.from(doc.getElementsByTagNameNS(OMML_NS, 't'))) {
		if (!t.textContent) t.textContent = '\u2009';
	}

	for (const nary of Array.from(doc.getElementsByTagNameNS(OMML_NS, 'nary'))) {
		const body = Array.from(nary.children).find((c) => local(c) === 'e');
		if (!body || body.childNodes.length > 0) continue;
		let next = nary.nextSibling;
		while (next) {
			const after: ChildNode | null = next.nextSibling;
			if (next.nodeType === Node.ELEMENT_NODE) {
				const el = next as Element;
				const content = text(el);
				const rel = RELATIONS.exec(content);
				if (local(el) === 'nary') break;
				if (rel && local(el) === 'r') {
					// Split "dx=" into "dx" (in the body) and "=" (after it).
					const t = el.getElementsByTagNameNS(OMML_NS, 't')[0];
					if (t && rel.index > 0) {
						const head = el.cloneNode(true) as Element;
						head.getElementsByTagNameNS(OMML_NS, 't')[0]!.textContent = content.slice(0, rel.index);
						t.textContent = content.slice(rel.index);
						body.appendChild(head);
					}
					break;
				}
				if (rel) break;
			}
			body.appendChild(next);
			next = after;
		}
	}
	return new XMLSerializer().serializeToString(doc.documentElement);
}

const MML_NS = 'http://www.w3.org/1998/Math/MathML';
const PLACEHOLDER = (n: number) => `\uE000${n}\uE001`;

/** OMML for a list of MathML nodes, without the oMath wrapper. */
function convertNodes(nodes: Element[]): string {
	const math = document.createElementNS(MML_NS, 'math');
	const row = document.createElementNS(MML_NS, 'mrow');
	nodes.forEach((n) => row.appendChild(n.cloneNode(true)));
	math.appendChild(row);
	return innerOmml(convertElement(math));
}

function innerOmml(omml: string): string {
	return omml.replace(/^<m:oMath\b[^>]*>/, '').replace(/<\/m:oMath>\s*$/, '');
}

const isMo = (el: Element | null | undefined, cls: string) =>
	!!el && el.localName === 'mo' && (el.getAttribute('data-mjx-texclass') === cls || el.getAttribute('fence') === 'true');

/** `\left( … \right)` and matrix environments: a row between opening and closing fences. */
function asFence(el: Element): { open: string; close: string; inner: Element[] } | null {
	if (el.localName !== 'mrow') return null;
	const kids = Array.from(el.children);
	const first = kids[0];
	const last = kids[kids.length - 1];
	if (kids.length < 2 || !isMo(first, 'OPEN')) return null;
	const closes = isMo(last, 'CLOSE');
	return {
		open: first!.textContent ?? '',
		close: closes ? (last!.textContent ?? '') : '',
		inner: kids.slice(1, closes ? -1 : undefined),
	};
}

/** Tables from aligned, align, split, gathered and the like, which Word writes as equation arrays. */
function isAlignedTable(el: Element): boolean {
	if (el.localName !== 'mtable') return false;
	const latex = el.getAttribute('data-latex') ?? '';
	if (/\{(aligned|align\*?|split|gathered|gather\*?|alignat\*?|alignedat|eqnarray\*?)\}/.test(latex)) return true;
	return /^(right left ?)+$/.test((el.getAttribute('columnalign') ?? '').trim());
}

/** Marks the start of a cell as an alignment point (where `&` was). */
function withAlignment(omml: string): string {
	return omml.replace(/<m:r>(<m:rPr>)?/, (_m, rpr?: string) => (rpr ? '<m:r><m:rPr><m:aln/>' : '<m:r><m:rPr><m:aln/></m:rPr>'));
}

function eqArr(table: Element): string {
	const rows = Array.from(table.children).filter((r) => r.localName === 'mtr' || r.localName === 'mlabeledtr');
	const parts = rows.map((row) => {
		const cells = Array.from(row.children).filter((c) => c.localName === 'mtd');
		return cells.map((cell, i) => (i > 0 ? withAlignment(convertNodes(Array.from(cell.children))) : convertNodes(Array.from(cell.children)))).join('');
	});
	return `<m:eqArr>${parts.map((p) => `<m:e>${p}</m:e>`).join('')}</m:eqArr>`;
}

const xmlAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * MathML to OMML. mathml2omml handles most of it; stretchy fences and
 * aligned equations are built here as Word's delimiter and equation-array
 * objects, through placeholders swapped in after conversion.
 */
function convertElement(math: Element): string {
	const clone = math.cloneNode(true) as Element;
	const parts: string[] = [];
	const walk = (el: Element) => {
		for (const child of Array.from(el.children)) {
			const fence = asFence(child);
			let built: string | null = null;
			if (fence) {
				built =
					`<m:d><m:dPr><m:begChr m:val="${xmlAttr(fence.open)}"/><m:endChr m:val="${xmlAttr(fence.close)}"/></m:dPr>` +
					`<m:e>${convertNodes(fence.inner)}</m:e></m:d>`;
			} else if (isAlignedTable(child)) {
				built = eqArr(child);
			}
			if (built !== null) {
				const mark = document.createElementNS(MML_NS, 'mi');
				mark.textContent = PLACEHOLDER(parts.length);
				parts.push(built);
				child.replaceWith(mark);
			} else {
				walk(child);
			}
		}
	};
	walk(clone);
	const omml = mml2omml(new XMLSerializer().serializeToString(clone));
	if (!parts.length) return omml;
	// Adjacent placeholders can share a run; split runs around them.
	return omml.replace(/<m:r>((?:(?!<\/m:r>).)*?)<m:t([^>]*)>([^<]*\uE000[^<]*)<\/m:t>((?:(?!<\/m:r>).)*?)<\/m:r>/gs, (_m, pre: string, tAttrs: string, text: string, post: string) =>
		text
			.split(/(\uE000\d+\uE001)/)
			.filter(Boolean)
			.map((seg) => {
				const ph = /^\uE000(\d+)\uE001$/.exec(seg);
				return ph ? (parts[Number(ph[1])] ?? '') : `<m:r>${pre}<m:t${tAttrs}>${seg}</m:t>${post}</m:r>`;
			})
			.join(''),
	);
}

/** Converts a MathML string to OMML. */
export function mmlToOmml(mml: string): string {
	const doc = new DOMParser().parseFromString(mml, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length) return mml2omml(mml);
	return convertElement(doc.documentElement);
}
