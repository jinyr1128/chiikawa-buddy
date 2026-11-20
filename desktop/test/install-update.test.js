import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installerFor, downloadVerified } from '../src/install-update.js';
import { RELEASES_PAGE } from '../src/update-check.js';

function release(tag, name) {
  return { version: '1.2.3', tag, asset: { name, url: RELEASES_PAGE + '/download/' + tag + '/' + name } };
}

test('설치 방식·버전·배포 주소가 일치할 때만 자동 설치', () => {
  const target = { platform: 'darwin', arch: 'arm64' };
  const mac = release('v1.2.3', 'chiikawa-manager-arm64.zip');
  assert.equal(installerFor(mac, target), 'mac');
  assert.equal(installerFor(mac, { ...target, checkout: true }), null);
  assert.equal(installerFor(mac, { ...target, arch: 'x64' }), null);
  assert.equal(installerFor({ ...mac, asset: { ...mac.asset, url: mac.asset.url + '?other' } }, target), null);
  const win = release('v1.2.3-windows', 'ChiikawaManager-1.2.3-Setup.exe');
  assert.equal(installerFor(win, { platform: 'win32', arch: 'x64' }), 'windows');
  assert.equal(installerFor(win, { platform: 'win32', portable: true }), null);
  assert.equal(installerFor({ ...win, version: '1.2.4' }, { platform: 'win32' }), null);
});

test('파일을 끝까지 받은 뒤 크기와 SHA-256을 모두 검증', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const body = Buffer.from('치이카와');
  const get = async () => new Response(body);
  const meta = { size: body.length, digest: 'sha256:' + createHash('sha256').update(body).digest('hex') };
  const asset = { url: 'fixture' };
  await downloadVerified(asset, meta, path.join(dir, 'ok'), get);
  assert.deepEqual(await fs.readFile(path.join(dir, 'ok')), body);
  for (const [i, bad] of [{ size: 1 }, { size: 1000 }, { digest: 'sha256:' + '0'.repeat(64) }, { digest: null }].entries()) {
    await assert.rejects(downloadVerified(asset, { ...meta, ...bad }, path.join(dir, String(i)), get));
  }
});
