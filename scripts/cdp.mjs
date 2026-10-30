// Dev helper: evaluates JavaScript in a running Obsidian window over the
// Chrome DevTools Protocol. Obsidian must be started with
// --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1.
//
// Usage: node scripts/cdp.mjs [--title <substring>] <file.js | -e "code">
// The code runs inside an async function; its return value is printed as JSON.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let title = '';
let code = '';
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--title') title = args[++i];
	else if (args[i] === '-e') code = args[++i];
	else if (args[i] === '--list') continue;
	else code = readFileSync(args[i], 'utf8');
}

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const pages = targets.filter((t) => t.type === 'page');
if (args.includes('--list') || !code) {
	console.log(pages.map((p) => `${p.id}  ${p.title}  ${p.url}`).join('\n'));
	process.exit(0);
}
const page = pages.find((p) => p.title.includes(title)) ?? pages[0];
if (!page) throw new Error('No Obsidian window found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
	ws.onopen = r;
	ws.onerror = j;
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
};
const send = (method, params) =>
	new Promise((resolve) => {
		const n = ++id;
		pending.set(n, resolve);
		ws.send(JSON.stringify({ id: n, method, params }));
	});

const res = await send('Runtime.evaluate', {
	expression: `(async () => { ${code} })()`,
	awaitPromise: true,
	returnByValue: true,
});
ws.close();
if (res.result?.exceptionDetails) {
	console.error(res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails));
	process.exit(1);
}
const value = res.result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
