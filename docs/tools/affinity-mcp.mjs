// Mini client MCP (SSE) pour Affinity Studio : node mcp.mjs list | call <tool> '<json args>' [--raw]
const BASE = 'http://[::1]:6767';
const res = await fetch(BASE + '/sse', { headers: { Accept: 'text/event-stream' } });
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let endpoint = null;
const pending = new Map(); let nextId = 1;
function handleEvent(ev, data) {
  if (ev === 'endpoint') endpoint = data.startsWith('http') ? data : BASE + data;
  else if (data) { try { const m = JSON.parse(data); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} }
}
(async () => {
  let ev = null, data = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line === '') { if (ev || data.length) handleEvent(ev, data.join('\n')); ev = null; data = []; }
      else if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    // certains serveurs n'envoient pas de ligne vide finale : on flush si on a un data complet JSON
    if (data.length && !buf.length) { const d = data.join('\n'); if (ev === 'endpoint' || /^[\[{].*[\]}]$/s.test(d)) { handleEvent(ev, d); ev = null; data = []; } }
  }
})();
while (!endpoint) await new Promise(r => setTimeout(r, 20));
async function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => { pending.set(id, resolve); setTimeout(() => reject(new Error('timeout ' + method)), timeoutMs); });
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const t = await r.text();
  try { const m = JSON.parse(t); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  return p;
}
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cc-mini', version: '1' } });
await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const argv = process.argv.slice(2); const raw = argv.includes('--raw');
const [cmd, tool, args] = argv.filter(a => a !== '--raw');
if (cmd === 'list') {
  const tools = (await rpc('tools/list', {})).result.tools;
  for (const t of tools) console.log(t.name + ' — ' + (t.description || '').replace(/\s+/g, ' ').slice(0, 300) + '\n   ' + JSON.stringify(t.inputSchema?.properties || {}).slice(0, 500));
} else {
  await rpc('tools/call', { name: 'read_sdk_documentation_topic', arguments: { filename: 'preamble' } }); // chaque session SSE exige la lecture du préambule
  const out = await rpc('tools/call', { name: tool, arguments: args ? JSON.parse(args) : {} });
  if (raw) console.log(JSON.stringify(out, null, 1));
  else for (const c of out.result?.content || [out]) console.log(c.type === 'text' ? c.text : JSON.stringify(c).slice(0, 2000));
}
process.exit(0);
