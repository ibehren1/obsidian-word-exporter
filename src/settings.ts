import { App, PluginSettingTab, Setting } from 'obsidian';
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

export class WordExporterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: WordExporterPlugin,
	) {
		super(app, plugin);
	}

	private save = () => this.plugin.saveSettings();

	private pageSettings(containerEl: HTMLElement) {
		const s = this.plugin.settings;

		new Setting(containerEl).setName('Page size').addDropdown((d) => {
			for (const size of Object.keys(PAGE_SIZES)) d.addOption(size, size);
			d.setValue(s.pageSize).onChange(async (v) => {
				s.pageSize = v as PageSize;
				await this.save();
			});
		});

		new Setting(containerEl).setName('Landscape').addToggle((t) =>
			t.setValue(s.landscape).onChange(async (v) => {
				s.landscape = v;
				await this.save();
			}),
		);

		new Setting(containerEl)
			.setName('Margins')
			.setDesc('Default matches PDF export. Word normal is 1 inch on every side.')
			.addDropdown((d) => {
				d.addOption('default', 'Default (same as PDF)')
					.addOption('minimal', 'Minimal')
					.addOption('none', 'None')
					.addOption('word', 'Word normal')
					.addOption('custom', 'Custom')
					.setValue(s.margins)
					.onChange(async (v) => {
						s.margins = v as MarginPreset;
						await this.save();
						this.display();
					});
			});

		if (s.margins === 'custom') {
			const labels = ['Top', 'Right', 'Bottom', 'Left'];
			labels.forEach((label, i) => {
				new Setting(containerEl).setName(`${label} margin (mm)`).addText((t) =>
					t.setValue(String(s.customMargins[i])).onChange(async (v) => {
						const n = parseFloat(v);
						if (!Number.isFinite(n) || n < 0) return;
						s.customMargins[i] = n;
						await this.save();
					}),
				);
			});
		}

		new Setting(containerEl).setName('Include file name as title').addToggle((t) =>
			t.setValue(s.includeTitle).onChange(async (v) => {
				s.includeTitle = v;
				await this.save();
			}),
		);

		new Setting(containerEl)
			.setName('Scale (%)')
			.setDesc("Like PDF export's downscale percent: below 100 fits more on each page.")
			.addSlider((sl) =>
				sl
					.setLimits(10, 100, 1)
					.setValue(s.scale)
					.onChange(async (v) => {
						s.scale = v;
						await this.save();
					}),
			);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = this.save;
		containerEl.empty();

		new Setting(containerEl).setName('Page').setHeading();

		new Setting(containerEl)
			.setName('Use PDF export settings')
			.setDesc(
				"Use the page size, margins, title and scale last chosen in Obsidian's export to PDF dialog, so both exports match.",
			)
			.addToggle((t) =>
				t.setValue(s.usePdfSettings).onChange(async (v) => {
					s.usePdfSettings = v;
					await save();
					this.display();
				}),
			);

		if (!s.usePdfSettings) this.pageSettings(containerEl);

		new Setting(containerEl).setName('Fonts').setHeading();

		new Setting(containerEl)
			.setName('Text font')
			.setDesc('Leave empty to use the font PDF export uses.')
			.addText((t) =>
				t.setPlaceholder('Arial').setValue(s.bodyFont).onChange(async (v) => {
					s.bodyFont = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName('Code font')
			.setDesc("Leave empty to use your theme's monospace font.")
			.addText((t) =>
				t.setPlaceholder('Menlo').setValue(s.monoFont).onChange(async (v) => {
					s.monoFont = v.trim();
					await save();
				}),
			);

		new Setting(containerEl).setName('Saving').setHeading();

		new Setting(containerEl).setName('Save to').addDropdown((d) =>
			d
				.addOption('ask', 'Ask every time')
				.addOption('next-to-note', 'Next to the note')
				.addOption('folder', 'A vault folder')
				.setValue(s.saveLocation)
				.onChange(async (v) => {
					s.saveLocation = v as SaveLocation;
					await save();
					this.display();
				}),
		);

		if (s.saveLocation === 'folder') {
			new Setting(containerEl).setName('Folder').addText((t) =>
				t.setPlaceholder('Exports').setValue(s.folder).onChange(async (v) => {
					s.folder = v.trim().replace(/^\/+|\/+$/g, '');
					await save();
				}),
			);
		}

				new Setting(containerEl)
			.setName('Text font')
			.setDesc('Leave empty to use the font PDF export uses.')
			.addText((t) =>
				t.setPlaceholder('Arial').setValue(s.bodyFont).onChange(async (v) => {
					s.bodyFont = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName('Code font')
			.setDesc("Leave empty to use your theme's monospace font.")
			.addText((t) =>
				t.setPlaceholder('Menlo').setValue(s.monoFont).onChange(async (v) => {
					s.monoFont = v.trim();
					await save();
				}),
			);

		new Setting(containerEl).setName('Saving').setHeading();

		new Setting(containerEl).setName('Save to').addDropdown((d) =>
			d
				.addOption('ask', 'Ask every time')
				.addOption('next-to-note', 'Next to the note')
				.addOption('folder', 'A vault folder')
				.setValue(s.saveLocation)
				.onChange(async (v) => {
					s.saveLocation = v as SaveLocation;
					await save();
					this.display();
				}),
		);

		if (s.saveLocation === 'folder') {
			new Setting(containerEl).setName('Folder').addText((t) =>
				t.setPlaceholder('Exports').setValue(s.folder).onChange(async (v) => {
					s.folder = v.trim().replace(/^\/+|\/+$/g, '');
					await save();
				}),
			);
		}

		new Setting(containerEl).setName('Open after export').addToggle((t) =>
			t.setValue(s.openAfterExport).onChange(async (v) => {
				s.openAfterExport = v;
				await save();
			}),
		);
	}
}
