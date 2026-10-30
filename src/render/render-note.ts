import { App, Component, MarkdownRenderer, TFile, loadMathJax } from 'obsidian';
import { BODY_ID, HTML_ID, mediaApplies, scopeSelector, splitList } from './css-scope';

// Renders a note the way PDF export does: Obsidian's own reading-view
// renderer, the same DOM shape as its print view, light theme and the
// stylesheets' print rules, laid out at the page's text width.

export interface RenderedNote {
	/** The `.markdown-preview-view` element holding the rendered note. */
	root: HTMLElement;
	/**
	 * Stand-ins for the print window's <html> and <body>. Their fixed-position
	 * pseudo-elements (watermarks, logos, footers) repeat on every page.
	 */
	html: HTMLElement;
	body: HTMLElement;
	dispose(): void;
}

export interface RenderOptions {
	/** Width of the page's printable area in CSS pixels. */
	widthPx: number;
	/** Height of the page's printable area in CSS pixels. */
	heightPx: number;
	includeTitle: boolean;
	/** How long to wait for asynchronous rendering (embeds, diagrams) to finish. */
	timeoutMs?: number;
}

interface MathJaxLike {
	tex2chtml: (src: string, opts?: { display?: boolean }) => HTMLElement;
}

export const LATEX_ATTR = 'data-word-latex';
export const DISPLAY_ATTR = 'data-word-display';

/**
 * Obsidian turns math into HTML through the global MathJax.tex2chtml and
 * keeps no trace of the TeX. Wrap it while rendering so each math node
 * carries its source, which later becomes a native Word equation.
 */
function captureMath(): () => void {
	const mj = (window as unknown as { MathJax?: MathJaxLike }).MathJax;
	if (!mj?.tex2chtml) return () => {};
	const original = mj.tex2chtml;
	mj.tex2chtml = function (this: unknown, src: string, opts?: { display?: boolean }) {
		const node = original.call(this, src, opts);
		node.setAttribute(LATEX_ATTR, src);
		node.setAttribute(DISPLAY_ATTR, opts?.display ? '1' : '0');
		return node;
	};
	return () => {
		mj.tex2chtml = original;
	};
}

/**
 * Margins set by @page rules (snippets use them to make room for footers),
 * in CSS pixels. PDF export honors them with its default margins.
 */
export function cssPageMargins(): Partial<Record<'top' | 'right' | 'bottom' | 'left', number>> {
	const out: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>> = {};
	const visit = (rules: CSSRuleList, inPrint: boolean) => {
		for (const rule of Array.from(rules)) {
			if (rule instanceof CSSMediaRule) {
				const media = rule.media.mediaText.toLowerCase();
				if (!media || media.includes('print') || media === 'all') visit(rule.cssRules, true);
			} else if (rule instanceof CSSPageRule && !rule.selectorText) {
				for (const side of ['top', 'right', 'bottom', 'left'] as const) {
					const v = rule.style.getPropertyValue(`margin-${side}`);
					const px = /^(-?[\d.]+)(px|pt|in|cm|mm)$/.exec(v.trim());
					if (!px) continue;
					const n = parseFloat(px[1]!);
					const factor = { px: 1, pt: 96 / 72, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[px[2] as 'px'];
					out[side] = n * factor;
				}
			}
		}
		void inPrint;
	};
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			visit(sheet.cssRules, false);
		} catch {
			// Cross-origin stylesheets can't be read.
		}
	}
	return out;
}

interface ScopeOptions {
	remPx: number;
	widthPx: number;
	isBody: (compound: string) => boolean;
}

function scopeRules(rules: CSSRuleList, opts: ScopeOptions, out: string[]) {
	for (const rule of Array.from(rules)) {
		if (rule instanceof CSSMediaRule) {
			if (mediaApplies(rule.media.mediaText, opts.widthPx)) scopeRules(rule.cssRules, opts, out);
		} else if (rule instanceof CSSSupportsRule) {
			if (CSS.supports(rule.conditionText)) scopeRules(rule.cssRules, opts, out);
		} else if (rule instanceof CSSLayerBlockRule) {
			scopeRules(rule.cssRules, opts, out);
		} else if (rule instanceof CSSStyleRule) {
			const selectors = splitList(rule.selectorText).map((s) => scopeSelector(s, opts.isBody));
			// The print window's root font size differs from the app's.
			const body = rule.style.cssText.replace(/(-?\d*\.?\d+)rem\b/g, (_m, n: string) => `${parseFloat(n) * opts.remPx}px`);
			if (body) out.push(`${selectors.join(', ')} { ${body} }`);
		}
	}
}

/**
 * Recreates the print window's styling around the export host: every
 * stylesheet in the app (Obsidian, theme, snippets, plugins) scoped to the
 * host, with print media rules applied, screen-only ones left out, and rem
 * resolved against the print window's root font size.
 */
function printStylesheet(widthPx: number, bodyClasses: string[]): CSSStyleSheet {
	const probe = createDiv({ cls: bodyClasses });
	const isBody = (compound: string) => {
		try {
			return probe.matches(compound);
		} catch {
			return false;
		}
	};
	const opts: ScopeOptions = { remPx: parseFloat(getComputedStyle(document.body).fontSize) || 16, widthPx, isBody };
	const out: string[] = [];
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			scopeRules(sheet.cssRules, opts, out);
		} catch {
			// Cross-origin stylesheets can't be read.
		}
	}
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(out.join('\n'));
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	return sheet;
}

/** Resolves once the element stops changing, or after the timeout. */
function settle(el: HTMLElement, quietMs: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let timer = window.setTimeout(done, quietMs);
		const hardStop = window.setTimeout(done, timeoutMs);
		const observer = new MutationObserver(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(done, quietMs);
		});
		observer.observe(el, { childList: true, subtree: true, characterData: true });
		function done() {
			observer.disconnect();
			window.clearTimeout(timer);
			window.clearTimeout(hardStop);
			resolve();
		}
	});
}

async function imagesLoaded(el: HTMLElement): Promise<void> {
	const images = Array.from(el.querySelectorAll('img'));
	await Promise.all(
		images.map((img) =>
			img.complete
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						img.addEventListener('load', () => resolve(), { once: true });
						img.addEventListener('error', () => resolve(), { once: true });
					}),
		),
	);
}

/**
 * Gives the rendered note the DOM shape of PDF export's print view, where
 * every top-level block except a horizontal rule sits in its own div, and a
 * table's div scrolls (which keeps margins from collapsing through it).
 * Spacing rules such as `p + h2 { margin-top: … }` depend on it.
 */
function matchPrintStructure(container: HTMLElement) {
	for (const node of Array.from(container.childNodes)) {
		if (node.nodeType !== Node.ELEMENT_NODE) {
			if (!node.textContent?.trim()) node.remove();
			continue;
		}
		const el = node as HTMLElement;
		if (el.tagName === 'HR') continue;
		const wrapper = createDiv();
		if (el.tagName === 'TABLE') wrapper.addClass('word-exporter-scroll');
		if (el.matches('pre.frontmatter')) wrapper.addClasses(['mod-frontmatter', 'mod-ui']);
		container.insertBefore(wrapper, el);
		wrapper.appendChild(el);
	}
}

function cssClasses(app: App, file: TFile): string[] {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const raw: unknown = fm?.cssclasses ?? fm?.cssclass;
	const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
	return list.map(String).filter(Boolean);
}

export async function renderNote(app: App, file: TFile, opts: RenderOptions): Promise<RenderedNote> {
	const markdown = await app.vault.cachedRead(file);
	await loadMathJax();

	// The print window's body: the app's classes in light mode.
	const bodyClasses = [...Array.from(document.body.classList).filter((c) => c !== 'theme-dark'), 'theme-light'];
	const style = printStylesheet(opts.widthPx, bodyClasses);
	// <html> is sized like the page's printable area and contains its fixed
	// descendants, so fixed page furniture lays out against the page.
	const host = document.body.createDiv({ cls: 'word-exporter-host', attr: { id: HTML_ID } });
	host.setCssProps({ '--word-exporter-page-width': `${opts.widthPx}px`, '--word-exporter-page-height': `${opts.heightPx}px` });
	const bodyEl = host.createDiv({ cls: bodyClasses, attr: { id: BODY_ID } });
	// Like the print window, take the app's settings that live inline on
	// <body> (text size, fonts, accent color) so stylesheet defaults don't
	// replace them.
	for (const name of Array.from(document.body.style)) {
		bodyEl.style.setProperty(name, document.body.style.getPropertyValue(name), document.body.style.getPropertyPriority(name));
	}
	const print = bodyEl.createDiv({ cls: 'print' });
	const root = print.createDiv({
		cls: ['markdown-preview-view', 'markdown-rendered', 'word-exporter-render', ...cssClasses(app, file)],
	});
	root.setCssProps({ '--word-exporter-width': `${opts.widthPx}px` });

	if (opts.includeTitle) root.createEl('h1', { text: file.basename });

	const component = new Component();
	component.load();
	const restoreMath = captureMath();
	try {
		// Render in place: diagrams size themselves from their attached parent.
		const body = root.createDiv();
		await MarkdownRenderer.render(app, markdown, body, file.path, component);
		matchPrintStructure(body);
		body.replaceWith(...Array.from(body.childNodes));
		await settle(root, 300, opts.timeoutMs ?? 15000);
		await imagesLoaded(root);
		// Print view links aren't clickable.
		root.findAll('a.internal-link').forEach((a) => a.removeAttribute('href'));
	} finally {
		restoreMath();
	}

	return {
		root,
		html: host,
		body: bodyEl,
		dispose() {
			component.unload();
			host.remove();
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== style);
		},
	};
}
