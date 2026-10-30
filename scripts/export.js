// Runs inside Obsidian (via cdp.mjs). Reloads the plugin, exports NOTES to
// test-output/<name>.docx. NOTES is substituted by run-export.sh.
const out = '/Users/ibehr/github_repos/obsidian-word-exporter/test-output/';
const fs = require('fs');
await app.plugins.disablePlugin('word-exporter');
await app.plugins.enablePlugin('word-exporter');
const plugin = app.plugins.plugins['word-exporter'];
const results = [];
for (const path of NOTES) {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) { results.push({ path, error: 'not found' }); continue; }
	const t = performance.now();
	try {
		const bytes = await plugin.toDocx(file);
		fs.writeFileSync(out + file.basename + '.docx', bytes);
		results.push({ path, bytes: bytes.length, ms: Math.round(performance.now() - t) });
	} catch (e) {
		results.push({ path, error: String(e && e.stack || e) });
	}
}
return results;
