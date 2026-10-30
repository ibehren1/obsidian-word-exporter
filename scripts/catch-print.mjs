// Dev helper: runs Obsidian's Export to PDF and evaluates a probe script in
// its hidden print window while the note is laid out there.
// Usage: node scripts/catch-print.mjs probe.js ["Note.md"]
import { readFileSync } from 'node:fs';
const list = async () => (await (await fetch('http://127.0.0.1:9222/json')).json()).filter((t) => t.type === 'page');
const before = new Set((await list()).map((t) => t.id));
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  return { ws, ev: async (e) => (await send('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true })).result?.result?.value };
};
const main = await connect((await list()).find((t) => t.title.includes('test-vault - Obsidian')));
const code = `const NOTE = ${JSON.stringify(process.argv[3] ?? 'Kitchen Sink.md')};\n` + readFileSync('scripts/obsidian-pdf.js', 'utf8');
const done = main.ev(code);
const measure = readFileSync(process.argv[2], "utf8");
let result = null;
for (let i = 0; i < 200 && !result; i++) {
  for (const t of await list()) {
    if (before.has(t.id)) { const v = await main.ev(measure); if (v) { result = { where: 'main', ...v }; break; } continue; }
    try { const c = await connect(t); const v = await c.ev(measure); c.ws.close(); if (v) { result = { where: t.title, ...v }; break; } } catch {}
  }
  await new Promise((r) => setTimeout(r, 50));
}
await done;
console.log(JSON.stringify(result, null, 2));
main.ws.close();
