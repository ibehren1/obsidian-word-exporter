// Runs inside Obsidian (via cdp.mjs): exports NOTE with Obsidian's own
// "Export to PDF" so Word output can be compared against it.
const out = '/Users/ibehr/github_repos/obsidian-word-exporter/test-output/';
const fs = require('fs');
const file = app.vault.getAbstractFileByPath(NOTE);
const leaf = app.workspace.getLeaf(false);
await leaf.openFile(file, { state: { mode: 'preview' } });
await new Promise((r) => setTimeout(r, 1500));
const target = out + file.basename + '.obsidian.pdf';
try { fs.unlinkSync(target); } catch {}
const dialog = require('electron').remote.dialog;
const original = dialog.showSaveDialog;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
const shell = require('electron').remote.shell;
const openPath = shell.openPath;
shell.openPath = async () => '';
try {
	app.commands.executeCommandById('workspace:export-pdf');
	await new Promise((r) => setTimeout(r, 800));
	const btn = document.querySelector('.modal-container .mod-cta');
	if (!btn) return 'no export button';
	btn.click();
	for (let i = 0; i < 60 && !fs.existsSync(target); i++) await new Promise((r) => setTimeout(r, 500));
	await new Promise((r) => setTimeout(r, 1000));
	return fs.existsSync(target) ? target : 'timed out';
} finally {
	dialog.showSaveDialog = original;
	shell.openPath = openPath;
}
