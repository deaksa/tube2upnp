import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MediaServer } from '../src/mediaServer.js';
import { Logger } from '../src/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('proxies with Range, DLNA headers, and re-resolves on 403', async (t) => {
  const payload = Buffer.from('0123456789abcdef');
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++;
    if (req.url.includes('expired')) return res.writeHead(403).end();
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${payload.length}`, 'content-length': b - a + 1 });
      return res.end(payload.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-length': payload.length }).end(payload);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  let resolves = 0;
  const resolver = {
    resolve: async () => ({ url: resolves++ === 0 ? `${base}/expired` : `${base}/ok`, mime: 'audio/mp4', headers: {} }),
    invalidate: () => {},
  };
  const ms = new MediaServer({ mediaPort: 0, cacheDir: mkdtempSync(path.join(tmpdir(), 'ut-')) }, resolver, new Logger('none'));
  await ms.start();
  t.after(() => { ms.stop(); upstream.close(); });
  const streamPath = ms.register({ videoId: 'dQw4w9WgXcQ', format: 'direct', ext: 'm4a' });
  assert.match(streamPath, /^\/stream\/[0-9a-f]{32}\.m4a$/);

  const res = await fetch(`http://127.0.0.1:${ms.port}${streamPath}`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), '2345');
  assert.equal(res.headers.get('content-type'), 'audio/mp4');
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/16');
  assert.match(res.headers.get('contentfeatures.dlna.org'), /DLNA.ORG_OP=01/);
  assert.equal(resolves, 2, 'expired URL should trigger one re-resolve');
  assert.equal(hits, 2);

  const bad = await fetch(`http://127.0.0.1:${ms.port}/stream/${'0'.repeat(32)}.m4a`);
  assert.equal(bad.status, 404, 'unknown tokens must not proxy anything');
});
