import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PortRegistry } from '../src/ports.js';
import { Logger } from '../src/logger.js';

const make = (dataDir = mkdtempSync(path.join(tmpdir(), 'ports-')), receiverBasePort = 3000) =>
  new PortRegistry({ dataDir, receiverBasePort }, new Logger('none'));

test('hands out consecutive ports and reuses a released one', async () => {
  const r = await make().load();
  assert.equal(r.claim('a'), 3000);
  assert.equal(r.claim('b'), 3001);
  r.release(3000);
  assert.equal(r.claim('c'), 3000);
});

test('a speaker keeps its port across restarts whatever the discovery order', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
  const first = await make(dataDir).load();
  for (const udn of ['kitchen', 'lamp', 'deck']) await first.remember(udn, first.claim(udn));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'ports.json'), 'utf8')), { kitchen: 3000, lamp: 3001, deck: 3002 });

  const second = await make(dataDir).load();
  assert.equal(second.claim('deck'), 3002);
  assert.equal(second.claim('lamp'), 3001);
  assert.equal(second.claim('kitchen'), 3000);
});

test('a new device never takes the port remembered for an offline one', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
  const first = await make(dataDir).load();
  await first.remember('kitchen', first.claim('kitchen'));
  await first.remember('lamp', first.claim('lamp'));

  const second = await make(dataDir).load();
  assert.equal(second.claim('newcomer'), 3002);
  assert.equal(second.claim('lamp'), 3001);
});

test('devices that never came up (filtered, failed) are not remembered', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
  const r = await make(dataDir).load();
  r.claim('tv');
  r.release(3000);
  const next = await make(dataDir).load();
  assert.equal(next.claim('lamp'), 3000);
});

test('tolerates a corrupt ports.json', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
  writeFileSync(path.join(dataDir, 'ports.json'), '{nope');
  const r = await make(dataDir).load();
  assert.equal(r.claim('a'), 3000);
});

test('ignores a ports.json of the wrong shape, and entries that are not ports', async () => {
  for (const content of ['null', '[]', '"3000"', '{"a":"3005","b":3001.5,"c":70000,"d":3002}']) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
    writeFileSync(path.join(dataDir, 'ports.json'), content);
    const r = await make(dataDir).load();
    assert.equal(r.claim('a'), 3000, content);
    assert.equal(r.claim('d'), content.includes('"d"') ? 3002 : 3001, content);
  }
});

test('speakers coming up at the same time are all saved without write errors', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ports-'));
  const warnings = [];
  const r = await new PortRegistry({ dataDir, receiverBasePort: 3000 }, { warn: (m) => warnings.push(m) }).load();
  const udns = ['kitchen', 'lamp', 'deck', 'family'];
  await Promise.all(udns.map((u) => r.remember(u, r.claim(u))));
  assert.deepEqual(warnings, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'ports.json'), 'utf8')), { kitchen: 3000, lamp: 3001, deck: 3002, family: 3003 });
});
