// Runs inside Obsidian (via cdp.mjs): switches the test vault between the
// default look and the reference vault's look. MODE is 'default' or 'user'.
const c = app.customCss;
const user = MODE === 'user';
c.setTheme(user ? 'Newsprint' : '');
for (const s of ['no-strikethrough-checkbox', 'pdf-watermark', 'custom-callouts']) c.setCssEnabledStatus(s, user);
app.vault.setConfig('textFontFamily', user ? 'Amazon Ember' : '');
app.vault.setConfig('monospaceFontFamily', user ? 'JetBrains Mono,Hack Nerd Font Mono' : '');
app.vault.setConfig('accentColor', user ? '#ff9900' : '');
app.vault.setConfig('baseFontSize', user ? 14 : 16);
app.updateFontFamily?.(); app.updateAccentColor?.(); app.updateFontSize?.();
await new Promise((r) => setTimeout(r, 1500));
return MODE;
