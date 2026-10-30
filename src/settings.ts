import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import type WordExporterPlugin from './main';
import type { Box, PageSetup } from './ir';

export type PageSize = 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A4' | 'A5';
export type MarginPreset = 'default' | 'minimal' | 'none' | 'word' | 'custom';
export type SaveLocation = 'ask' | 'next-to-note' | 'folder';

export interface WordExporterSettings {
	/** Take page size, margins, title and scale from Obsidian's PDF export dialog. */
	usePdfSettings: boolean;
	pageSize: PageSize;
	landscape: boolean;
	margins: MarginPreset;
	/** Custom margins in millimeters: top, right, bottom, left. */
	customMargins: [number, number, number, number];
	includeTitle: boolean;
	/** Percent, like PDF export's "Downscale percent". */
	scale: number;
	bodyFont: string;
	monoFont: string;
	saveLocation: SaveLocation;
	/** Vault folder for 'folder' save location. */
	folder: string;
	openAfterExport: boolean;
}

export const DEFAULT_SETTINGS: WordExporterSettings = {
	usePdfSettings: true,
	pageSize: 'Letter',
	landscape: false,
	margins: 'default',
	customMargins: [25.4, 25.4, 25.4, 25.4],
	includeTitle: false,
	scale: 100,
	bodyFont: '',
	monoFont: '',
	saveLocation: 'ask',
	folder: '',
	openAfterExport: true,
};

/** Page sizes in points. */
const PAGE_SIZES: Record<PageSize, [number, number]> = {
	Letter: [612, 792],
	Legal: [612, 1008],
	Tabloid: [792, 1224],
	A3: [841.89, 1190.55],
	A4: [595.28, 841.89],
	A5: [419.53, 595.28],
};

const MM = 72 / 25.4;

/** Margins matching Obsidian's PDF export presets (Chromium's print margins). */
function marginsFor(s: WordExporterSettings): Box {
	const all = (v: number) => ({ top: v, right: v, bottom: v, left: v });
	switch (s.margins) {
		case 'default':
			// Chromium's 1cm default, rounded down to whole pixels (37px).
			return all(27.75);
		case 'minimal':
		case 'none':
			return all(0);
		case 'word':
			return all(72);
		case 'custom': {
			const [t, r, b, l] = s.customMargins;
			return { top: t * MM, right: r * MM, bottom: b * MM, left: l * MM };
		}
	}
}

interface PdfExportSettings {
	includeName?: boolean;
	pageSize?: string;
	landscape?: boolean;
	/** "0" default, "1" none, "2" minimal. */
	margin?: string;
	downscalePercent?: number;
}

/** The settings in effect for an export, with PDF export's applied when enabled. */
export function effectiveSettings(app: App, s: WordExporterSettings): WordExporterSettings {
	if (!s.usePdfSettings) return s;
	const pdf = ((app.vault as unknown as { getConfig(key: string): unknown }).getConfig('pdfExportSettings') ??
		{}) as PdfExportSettings;
	return {
		...s,
		pageSize: pdf.pageSize && pdf.pageSize in PAGE_SIZES ? (pdf.pageSize as PageSize) : 'Letter',
		landscape: !!pdf.landscape,
		margins: pdf.margin === '1' ? 'none' : pdf.margin === '2' ? 'minimal' : 'default',
		includeTitle: !!pdf.includeName,
		scale: pdf.downscalePercent ?? 100,
	};
}

export function pageSetup(s: WordExporterSettings): PageSetup {
	const [w, h] = PAGE_SIZES[s.pageSize];
	return { width: w, height: h, landscape: s.landscape, margins: marginsFor(s) };
}

/** Width of the page's text area in CSS pixels, which the note is laid out at. */
export function textWidthPx(page: PageSetup): number {
	const width = page.landscape ? page.height : page.width;
	return ((width - page.margins.left - page.margins.right) * 96) / 72;
}

/** Height of the page's text area in CSS pixels. */
export function textHeightPx(page: PageSetup): number {
	const height = page.landscape ? page.width : page.height;
	return ((height - page.margins.top - page.margins.bottom) * 96) / 72;
}

type MarginKey = `margin-${0 | 1 | 2 | 3}`;
type SettingKey = keyof WordExporterSettings | MarginKey;

const MARGIN_SIDES = ['Top', 'Right', 'Bottom', 'Left'];

export class WordExporterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: WordExporterPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		const margin = /^margin-(\d)$/.exec(key);
		if (margin) return s.customMargins[Number(margin[1])];
		return s[key as keyof WordExporterSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		const margin = /^margin-(\d)$/.exec(key);
		if (margin) s.customMargins[Number(margin[1])] = value as number;
		else if (key === 'bodyFont' || key === 'monoFont') s[key] = (value as string).trim();
		else if (key === 'folder') s.folder = (value as string).trim().replace(/^\/+|\/+$/g, '');
		else Object.assign(s, { [key]: value });
		await this.plugin.saveSettings();
		// Other settings show or hide depending on this one.
		this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		const s = this.plugin.settings;
		const ownPage = () => !s.usePdfSettings;
		return [
			{
				type: 'group',
				heading: 'Page',
				items: [
					{
						name: 'Use PDF export settings',
						desc: "Use the page size, margins, title and scale last chosen in Obsidian's export to PDF dialog, so both exports match.",
						control: { type: 'toggle', key: 'usePdfSettings' },
					},
					{
						name: 'Page size',
						visible: ownPage,
						control: {
							type: 'dropdown',
							key: 'pageSize',
							options: Object.fromEntries(Object.keys(PAGE_SIZES).map((size) => [size, size])),
						},
					},
					{ name: 'Landscape', visible: ownPage, control: { type: 'toggle', key: 'landscape' } },
					{
						name: 'Margins',
						desc: 'Default matches PDF export. Word normal is 1 inch on every side.',
						visible: ownPage,
						control: {
							type: 'dropdown',
							key: 'margins',
							options: {
								default: 'Default (same as PDF)',
								minimal: 'Minimal',
								none: 'None',
								word: 'Word normal',
								custom: 'Custom',
							},
						},
					},
					...MARGIN_SIDES.map((side, i) => ({
						name: `${side} margin (mm)`,
						visible: () => ownPage() && s.margins === 'custom',
						control: {
							type: 'number' as const,
							key: `margin-${i}` as MarginKey,
							min: 0,
							step: 'any' as const,
							validate: (v: number) => (Number.isFinite(v) && v >= 0 ? undefined : 'Enter 0 or more.'),
						},
					})),
					{ name: 'Include file name as title', visible: ownPage, control: { type: 'toggle', key: 'includeTitle' } },
					{
						name: 'Scale (%)',
						desc: "Like PDF export's downscale percent: below 100 fits more on each page.",
						visible: ownPage,
						control: { type: 'slider', key: 'scale', min: 10, max: 100, step: 1 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Fonts',
				items: [
					{
						name: 'Text font',
						desc: 'Leave empty to use the font PDF export uses.',
						control: { type: 'text', key: 'bodyFont', placeholder: 'Arial' },
					},
					{
						name: 'Code font',
						desc: "Leave empty to use your theme's monospace font.",
						control: { type: 'text', key: 'monoFont', placeholder: 'Menlo' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Saving',
				items: [
					{
						name: 'Save to',
						control: {
							type: 'dropdown',
							key: 'saveLocation',
							options: { ask: 'Ask every time', 'next-to-note': 'Next to the note', folder: 'A vault folder' },
						},
					},
					{
						name: 'Folder',
						visible: () => s.saveLocation === 'folder',
						control: { type: 'folder', key: 'folder', placeholder: 'Exports' },
					},
					{ name: 'Open after export', control: { type: 'toggle', key: 'openAfterExport' } },
				],
			},
		];
	}
}
