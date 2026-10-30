import { App, FileSystemAdapter, Notice, TFile, normalizePath } from 'obsidian';
import { Walker } from './convert/dom-to-ir';
import { toDocxBytes } from './docx/emit';
import type { DocumentModel, PageSetup } from './ir';
import { setScale } from './render/css';
import { cssPageMargins, renderNote, type RenderedNote } from './render/render-note';
import { electron, nodeFs } from './node';
import { effectiveSettings, pageSetup, textHeightPx, textWidthPx, type WordExporterSettings } from './settings';

/** The page as PDF export would set it up, including margins from @page rules. */
function exportPage(app: App, settings: WordExporterSettings): PageSetup {
	const s = effectiveSettings(app, settings);
	const page = pageSetup(s);
	if (s.margins !== 'default') return page;
	const css = cssPageMargins();
	const m = { ...page.margins };
	for (const side of ['top', 'right', 'bottom', 'left'] as const) {
		const px = css[side];
		if (px !== undefined) m[side] = (px * 72) / 96;
	}
	return { ...page, margins: m };
}

/** Renders a note offscreen as PDF export would lay it out on the page. */
export function renderForSettings(app: App, file: TFile, settings: WordExporterSettings): Promise<RenderedNote> {
	const s = effectiveSettings(app, settings);
	const page = exportPage(app, settings);
	const scale = Math.min(1, Math.max(0.1, s.scale / 100));
	setScale(scale);
	return renderNote(app, file, {
		// Downscaling lays the note out wider, then shrinks it onto the page.
		widthPx: textWidthPx(page) / scale,
		heightPx: textHeightPx(page) / scale,
		includeTitle: s.includeTitle,
	});
}

/** Reads a file by absolute path through the vault API; null if it's outside the vault. */
async function readVaultFile(app: App, absolute: string): Promise<Uint8Array | null> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return null;
	const base = adapter.getBasePath().replace(/\\/g, '/').replace(/\/$/, '');
	const path = absolute.replace(/\\/g, '/');
	if (!path.startsWith(`${base}/`)) return null;
	const vaultPath = normalizePath(path.slice(base.length + 1));
	if (!(await adapter.exists(vaultPath))) return null;
	return new Uint8Array(await adapter.readBinary(vaultPath));
}

/** Renders a note and describes it as the intermediate document model. */
export async function noteToModel(app: App, file: TFile, settings: WordExporterSettings): Promise<DocumentModel> {
	const page = exportPage(app, settings);
	const rendered = await renderForSettings(app, file, settings);
	try {
		return await new Walker(rendered.root, {
			page,
			pageElements: [rendered.html, rendered.body],
			bodyFont: settings.bodyFont,
			monoFont: settings.monoFont,
			title: file.basename,
			readLocalFile: (path) => readVaultFile(app, path),
		}).walk();
	} finally {
		rendered.dispose();
	}
}

/** Renders a note and converts it to .docx bytes. */
export async function noteToDocx(app: App, file: TFile, settings: WordExporterSettings): Promise<Uint8Array> {
	return toDocxBytes(await noteToModel(app, file, settings));
}

function absolutePath(app: App, vaultPath: string): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getFullPath(vaultPath) : null;
}

async function writeToVault(app: App, path: string, data: Uint8Array): Promise<string> {
	const existing = app.vault.getAbstractFileByPath(path);
	const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	if (existing instanceof TFile) await app.vault.modifyBinary(existing, buffer);
	else await app.vault.createBinary(path, buffer);
	return path;
}

async function ensureFolder(app: App, folder: string) {
	if (!folder || app.vault.getAbstractFileByPath(folder)) return;
	await app.vault.createFolder(folder);
}

/** Exports a note, asking where to save or using the configured location. Returns the saved path. */
export async function exportNote(app: App, file: TFile, settings: WordExporterSettings): Promise<string | null> {
	const notice = new Notice(`Exporting ${file.basename} to Word…`, 0);
	try {
		const data = await noteToDocx(app, file, settings);
		const name = `${file.basename}.docx`;
		const el = electron();
		let absolute: string | null = null;

		if (settings.saveLocation === 'ask' && el?.remote?.dialog) {
			const next = absolutePath(app, normalizePath(`${file.parent?.path ?? ''}/${name}`));
			const result = await el.remote.dialog.showSaveDialog({
				title: 'Export to Word',
				defaultPath: next ?? name,
				filters: [{ name: 'Word document', extensions: ['docx'] }],
			});
			if (result.canceled || !result.filePath) return null;
			absolute = result.filePath;
			const fs = nodeFs();
			if (!fs) throw new Error('Saving outside the vault is not available');
			await fs.promises.writeFile(absolute, data);
		} else {
			const folder =
				settings.saveLocation === 'folder' && settings.folder ? settings.folder : (file.parent?.path ?? '');
			await ensureFolder(app, folder);
			const vaultPath = normalizePath(folder && folder !== '/' ? `${folder}/${name}` : name);
			await writeToVault(app, vaultPath, data);
			absolute = absolutePath(app, vaultPath);
		}

		new Notice(`Exported ${name}`);
		if (settings.openAfterExport && absolute && el?.shell) await el.shell.openPath(absolute);
		return absolute;
	} catch (e) {
		console.error('Word Exporter: export failed', e);
		new Notice(`Word export failed: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	} finally {
		notice.hide();
	}
}
