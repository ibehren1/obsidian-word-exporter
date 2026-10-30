import { Plugin, TFile } from 'obsidian';
import { exportNote, noteToDocx, noteToModel, renderForSettings } from './exporter';
import { DEFAULT_SETTINGS, WordExporterSettingTab, type WordExporterSettings } from './settings';

export default class WordExporterPlugin extends Plugin {
	settings!: WordExporterSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'export-current-note',
			name: 'Export current note to Word (.docx)',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void exportNote(this.app, file, this.settings);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem((item) =>
					item
						.setTitle('Export to Word (.docx)')
						.setIcon('file-text')
						.onClick(() => void exportNote(this.app, file, this.settings)),
				);
			}),
		);

		this.addSettingTab(new WordExporterSettingTab(this.app, this));
	}

	/** Converts a note to .docx bytes without saving; also used by test scripts. */
	toDocx(file: TFile): Promise<Uint8Array> {
		return noteToDocx(this.app, file, this.settings);
	}

	/** Dev aid: renders a note offscreen and leaves it in place for inspection. */
	async debugRender(file: TFile): Promise<HTMLElement> {
		return (await renderForSettings(this.app, file, this.settings)).root;
	}

	/** Dev aid: the intermediate model for a note, for inspecting layout decisions. */
	debugModel(file: TFile) {
		return noteToModel(this.app, file, this.settings);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<WordExporterSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
