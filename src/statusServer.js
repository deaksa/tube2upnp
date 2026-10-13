// Tiny LAN status page: lists renderers, what they play, and hands out
// "Link with TV code" pairing codes. Pairing works even when the phone can't
// see our DIAL/SSDP announcements (other VLAN, guest Wi-Fi, mDNS-filtering APs).

import http from 'node:http';

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function snapshot(renderers) {
  return [...renderers.values()].map((r) => ({
    id: r.udn,
    name: r.name,
    device: r.description ? `${r.description.manufacturer} ${r.description.modelName}`.trim() : '',
    address: r.address,
    port: r.port,
    receiver: r.receiverStatus,
    senders: r.connectedSenders.map((s) => s.user?.name ?? s.name),
    nowPlaying: r.nowPlaying,
    lastError: r.lastError,
  }));
}

function page(list) {
  const rows = list.map((r) => `
    <tr>
      <td><b>${esc(r.name)}</b><br><small>${esc(r.device)} · ${esc(r.address)}</small></td>
      <td>${esc(r.receiver)}${r.senders.length ? `<br><small>${esc(r.senders.join(', '))}</small>` : ''}</td>
      <td>${r.nowPlaying ? `${esc(r.nowPlaying.title)}<br><small>${esc(r.nowPlaying.artist)}</small>` : '–'}
          ${r.lastError ? `<br><small class="err">${esc(r.lastError)}</small>` : ''}</td>
      <td><button data-id="${esc(r.id)}">TV code</button><span class="code"></span></td>
    </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>upnpTube</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 1.5rem; max-width: 60rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: .5rem; border-bottom: 1px solid #8884; text-align: left; vertical-align: top; }
  small { opacity: .7 } .err { color: #d33; opacity: 1 }
  .code { font: 600 1.2rem ui-monospace, monospace; margin-left: .5rem; letter-spacing: .1em; }
</style></head><body>
<h1>upnpTube</h1>
<p>${list.length} renderer(s). In the YouTube app: <i>Settings → Watch on TV → Link with TV code</i> if a speaker doesn't show up in the cast menu.</p>
<table><tr><th>Renderer</th><th>Receiver</th><th>Now playing</th><th>Pairing</th></tr>${rows}</table>
<script>
document.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
  const out = b.nextElementSibling; out.textContent = '…';
  const r = await fetch('/api/renderers/' + encodeURIComponent(b.dataset.id) + '/pair', { method: 'POST' });
  const j = await r.json();
  out.textContent = j.code ? j.code.replace(/(\\d{3})(?=\\d)/g, '$1 ') : (j.error || 'failed');
});
</script></body></html>`;
}

export function startStatusServer(config, renderers, log) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(snapshot(renderers)));
      } else if (req.method === 'GET' && url.pathname === '/api/renderers') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot(renderers)));
      } else if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200).end('ok');
      } else if (req.method === 'POST' && /^\/api\/renderers\/[^/]+\/pair$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const r = renderers.get(id);
        if (!r) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"unknown renderer"}');
        const code = await r.getPairingCode();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code }));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      log.warn('Status request failed:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
  });
  server.on('error', (err) => log.error(`Status page on :${config.statusPort} failed:`, err.message));
  server.listen(config.statusPort, () => log.info(`Status page on http://<this-host>:${config.statusPort}/`));
  return server;
}
