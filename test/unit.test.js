import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, udnFromUsn, maxAge } from '../src/ssdp.js';
import { parseDescription, buildDidl, sinkAccepts, pickIcon, parseScpd, didlTitle } from '../src/upnp.js';
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

test('yt-dlp info JSON is private and never written through a planted symlink', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { downloadWithYtdlp } = await import('../src/resolver.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'ytdlp-'));
  // Fake yt-dlp: records the info JSON's permissions, then "downloads" to -o.
  const fake = path.join(dir, 'yt-dlp');
  writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do\n  [ "$1" = "--load-info-json" ] && stat -c %a "$2" > "$DIR/mode"\n  shift\ndone\necho audio > "$2"\n');
  chmodSync(fake, 0o755);
  process.env.DIR = dir;
  const config = { ytdlpPath: fake, ytdlpFormat: 'bestaudio', ytdlpJsRuntime: '', ytdlpExtraArgs: [] };
  const info = { formatId: '140' };
  Object.defineProperty(info, 'rawJson', { value: '{"id":"x"}' });

  const dest = path.join(dir, 'aaaaaaaaaaa.source');
  const victim = path.join(dir, 'victim');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, `${dest}.info.json`); // planted before the download
  await downloadWithYtdlp(config, null, 'aaaaaaaaaaa', info, dest);
  assert.equal(readFileSync(path.join(dir, 'mode'), 'utf8').trim(), '600');
  assert.equal(readFileSync(victim, 'utf8'), 'keep me', 'symlink target untouched');
  assert.equal(readFileSync(dest, 'utf8').trim(), 'audio');
  assert.ok(!existsSync(`${dest}.info.json`), 'removed afterwards');
});

test('device page and icons: only web URLs, from the renderer or its root device', () => {
  const desc = (page, icons) => parseDescription(`<?xml version="1.0"?><root><device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>X</friendlyName>
    ${page ? `<presentationURL>${page}</presentationURL>` : ''}${icons}</device></root>`, 'http://10.0.0.2:1400/desc.xml');
  assert.equal(desc('/web', '').presentationURL, 'http://10.0.0.2:1400/web');
  assert.equal(desc('javascript:alert(1)', '').presentationURL, null);
  assert.equal(desc('', '').presentationURL, null);
  const icons = desc('', `<iconList>
    <icon><mimetype>image/png</mimetype><width>256</width><url>/big.png</url></icon>
    <icon><mimetype>image/jpeg</mimetype><width>64</width><url>/mid.jpg</url></icon>
    <icon><mimetype>image/png</mimetype><width>60</width><url>/small.png</url></icon>
    <icon><mimetype>image/svg+xml</mimetype><width>64</width><url>/logo.svg</url></icon>
    <icon><mimetype>image/png</mimetype><width>64</width><url>file:///etc/passwd</url></icon></iconList>`).icons;
  assert.equal(icons.length, 4, 'the file: URL is dropped');
  assert.equal(pickIcon(icons).url, 'http://10.0.0.2:1400/small.png', 'a raster image near 64 px, PNG when about as close, never SVG');
  assert.equal(pickIcon([]), null);
});

test('SCPD: actions and allowed ranges', () => {
  const s = parseScpd(`<scpd><actionList><action><name>GetVolume</name></action><action><name>GetVolumeDB</name></action></actionList>
    <serviceStateTable><stateVariable><name>Volume</name><allowedValueRange><minimum>0</minimum><maximum>80</maximum></allowedValueRange></stateVariable>
    <stateVariable><name>Mute</name></stateVariable></serviceStateTable></scpd>`);
  assert.deepEqual([...s.actions], ['GetVolume', 'GetVolumeDB']);
  assert.deepEqual(s.ranges, { Volume: { min: 0, max: 80 } });
});

test('DIDL title for "playing another source"', () => {
  assert.deepEqual(didlTitle('<DIDL-Lite xmlns:dc="x" xmlns:upnp="y"><item><dc:title>Song</dc:title><upnp:artist>Band</upnp:artist></item></DIDL-Lite>'),
    { title: 'Song', artist: 'Band' });
  assert.equal(didlTitle(''), null);
  assert.equal(didlTitle('NOT_IMPLEMENTED'), null);
  assert.equal(didlTitle('<DIDL-Lite><item><dc:title>broken'), null);
});
