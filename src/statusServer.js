// LAN status page: renderers, per-renderer stream format, live logs, stats for nerds,
// and "Link with TV code" pairing codes (which work even when the phone can't see our
// DIAL/SSDP announcements: other VLAN, guest Wi-Fi, multicast-filtering APs).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { recentLogs, onLog } from './logger.js';
import { stats } from './stats.js';
import { CATEGORIES } from './sponsorblock.js';

const PAGE = readFileSync(new URL('./ui/index.html', import.meta.url));

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(res, code, body) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function tokenOk(config, req, url) {
  if (!config.statusToken) return true;
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(config.statusToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Changes need a custom header (a cross-site page can't send one without a CORS
 * preflight, which we never approve) and, if the browser sends Origin, our own host.
 */
function csrfOk(req) {
  if (req.headers['x-tube2upnp'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

export function startStatusServer(config, { renderers, mediaServer, settings }, log) {
  const routes = [
    ['GET', /^\/api\/status$/, async () => ({
      app: { version: stats.info.version, uptimeS: Math.round((Date.now() - stats.started) / 1000),
        outputFormat: config.outputFormat, prefetch: config.prefetch, gapless: config.gapless },
      renderers: [...renderers.values()].map((r) => r.statusInfo()),
    })],
    ['GET', /^\/api\/stats$/, async () => ({ ...stats.snapshot(), cache: await mediaServer.cacheInfo() })],
    ['GET', /^\/api\/logs$/, async (_m, url) => ({ lines: recentLogs(Number(url.searchParams.get('after')) || 0) })],
    ['GET', /^\/api\/settings$/, async () => ({
      sponsorblock: { ...settings.sponsorblock, envEnabled: config.sponsorblock, envCategories: config.sponsorblockCategories },
      sponsorblockCategories: CATEGORIES,
    })],
    ['POST', /^\/api\/settings\/sponsorblock$/, async (_m, _url, req) => {
      const { enabled, categories } = await readJson(req);
      if (enabled !== undefined && typeof enabled !== 'boolean') throw Object.assign(new Error('"enabled" must be true or false'), { status: 400 });
      if (categories !== undefined && (!Array.isArray(categories) || categories.some((c) => !CATEGORIES[c]))) {
        throw Object.assign(new Error('Unknown SponsorBlock category'), { status: 400 });
      }
      await settings.setSponsorblock({ enabled, categories });
      log.info(`SponsorBlock ${settings.sponsorblock.enabled ? `on (${settings.sponsorblock.categories.join(', ')})` : 'off'} - changed on the status page`);
      return { ok: true };
    }],
    ['POST', /^\/api\/settings\/sponsorblock\/reset$/, async () => {
      await settings.resetSponsorblock();
      log.info('SponsorBlock settings reset to the .env defaults');
      return { ok: true };
    }],
    ['POST', /^\/api\/renderers\/([^/]+)\/format$/, async (m, _url, req) => {
      const { format } = await readJson(req);
      await renderer(m[1]).setFormatOverride(format ?? null);
      return { ok: true };
    }],
    ['POST', /^\/api\/renderers\/([^/]+)\/forget-format$/, async (m) => {
      await renderer(m[1]).forgetLearnedFormat();
      return { ok: true };
    }],
    ['POST', /^\/api\/renderers\/([^/]+)\/pair$/, async (m) => ({ code: await renderer(m[1]).getPairingCode() })],
  ];

  function renderer(id) {
    const r = renderers.get(decodeURIComponent(id));
    if (!r) throw Object.assign(new Error('Unknown renderer - it may have gone offline'), { status: 404 });
    return r;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, SECURITY_HEADERS).end('ok');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        // The page itself is harmless; with STATUS_TOKEN set, its API calls carry the token.
        res.writeHead(200, {
          ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store',
        }).end(PAGE);
        return;
      }
      if (!tokenOk(config, req, url)) return json(res, 401, { error: 'Missing or wrong token. Open the page as /?token=…' });

      if (req.method === 'GET' && url.pathname === '/api/logs/stream') return streamLogs(req, res, url);

      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (!m || req.method !== method) continue;
        if (method === 'POST' && !csrfOk(req)) return json(res, 403, { error: 'Cross-site request refused' });
        return json(res, 200, await handler(m, url, req));
      }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) log.warn(`${req.method} ${url.pathname} failed:`, err.message);
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
    }
  });

  // Server-sent events: live log lines.
  function streamLogs(req, res, url) {
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
    });
    const send = (line) => res.write(`id: ${line.id}\ndata: ${JSON.stringify(line)}\n\n`);
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after')) || 0;
    for (const line of recentLogs(after)) send(line);
    const off = onLog(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { off(); clearInterval(ping); });
  }

  server.on('error', (err) => log.error(`Status page on :${config.statusPort} failed:`, err.message));
  server.listen(config.statusPort, config.statusBind || undefined, () => {
    log.info(`Status page on http://<this-host>:${server.address().port}/${config.statusToken ? '?token=…' : ''}`);
  });
  return server;
}
