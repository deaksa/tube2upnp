import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, udnFromUsn, maxAge } from '../src/ssdp.js';
import { parseDescription, buildDidl, sinkAccepts } from '../src/upnp.js';
import { parseHms } from '../src/renderer.js';
import { urlExpiry, mimeFor, Resolver } from '../src/resolver.js';

test('SSDP parsing handles CRLF, case and missing headers', () => {
  const { startLine, headers } = parseMessage(Buffer.from(
    'NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\ncache-control: max-age=200\r\n'
    + 'Location: http://192.168.1.15:51161/x.xml\r\nNTS: ssdp:alive\r\n'
    + 'USN: uuid:93B2ABAC-cb6a::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'));
  assert.equal(startLine, 'NOTIFY * HTTP/1.1');
  assert.equal(headers.LOCATION, 'http://192.168.1.15:51161/x.xml');
  assert.equal(maxAge(headers.CACHECONTROL, 1), 200);
  assert.equal(maxAge(undefined, 1800), 1800);
  assert.equal(udnFromUsn(headers.USN), '93b2abac-cb6a');
  assert.equal(udnFromUsn(undefined), null);
});

test('description parser finds embedded MediaRenderer and normalises serviceIds', async () => {
  const { startFakeRenderer } = await import('./fakeRenderer.js');
  const fake = await startFakeRenderer();
  const xml = await (await fetch(fake.location)).text();
  fake.server.close();
  const d = parseDescription(xml, fake.location);
  assert.equal(d.friendlyName, 'Living Room Speaker');
  assert.ok(d.services['urn:upnp-org:serviceId:AVTransport']);
  assert.match(d.services['urn:upnp-org:serviceId:AVTransport'].controlURL, /^http:\/\/127\.0\.0\.1:\d+\/ctl\/AVTransport$/);
});

test('DIDL escapes metadata', () => {
  const x = buildDidl({ url: 'http://h/s?a=1&b=2', protocolInfo: 'http-get:*:audio/mp4:*', title: 'Tom & Jerry <live>', artist: 'A"B', duration: 125 });
  assert.match(x, /Tom &amp; Jerry &lt;live&gt;/);
  assert.match(x, /a=1&amp;b=2/);
  assert.match(x, /duration="0:02:05.000"/);
  assert.doesNotMatch(x, /<live>/);
});

test('sink protocol matching', () => {
  const p = (cf) => ({ protocol: 'http-get', contentFormat: cf });
  assert.equal(sinkAccepts([p('audio/mpeg')], 'audio/mp4'), false);
  assert.equal(sinkAccepts([p('audio/x-m4a')], 'audio/mp4'), true);
  assert.equal(sinkAccepts([p('*')], 'audio/webm'), true);
  assert.equal(sinkAccepts(null, 'audio/mp4'), null);
});

test('time helpers', () => {
  assert.equal(parseHms('0:01:05'), 65);
  assert.equal(parseHms('01:00:00.500'), 3600.5);
  assert.equal(parseHms('NOT_IMPLEMENTED'), 0);
  const now = 1_700_000_000_000;
  assert.equal(urlExpiry(`https://r1.googlevideo.com/v?expire=${now / 1000 + 600}`, now), now + 300_000);
  assert.equal(mimeFor({ ext: 'm4a' }), 'audio/mp4');
});

test('resolver rejects IDs that could be used for injection', async () => {
  const r = new Resolver({ ytdlpPath: '/bin/false' }, { debug() {}, info() {} });
  await assert.rejects(r.resolve('abc; rm -rf /'), /invalid video ID/);
  await assert.rejects(r.resolve('--exec=evil'), /invalid video ID/);
});
