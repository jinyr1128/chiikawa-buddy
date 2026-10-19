import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveAsset, ALLOWED, parseRange, assetCandidates, CHARACTER_FILES, PICKABLE_FILES } from '../src/assets.js';
import { IMAGES } from '../src/bubbles.js';
import { knockOutWhite } from '../scripts/prepare-assets.mjs';
import { decodePNG, encodePNG } from '../scripts/png.mjs';

test('cy-asset: 허용 목록만, 경로 조작·다른 호스트·쿼리 거절', () => {
  assert.deepEqual(resolveAsset('cy-asset://app/character.png'), { rel: 'character.png', type: 'image/png' });
  assert.deepEqual(resolveAsset('cy-asset://app/reactions/merge.jpg'), { rel: 'reactions/merge.jpg', type: 'image/jpeg' });
  for (const bad of [
    'cy-asset://app/../config.json', 'cy-asset://app/%2e%2e/config.json', 'cy-asset://app/reactions/../../cy.db',
    'cy-asset://app/reactions/nope.jpg', 'cy-asset://evil/character.png', 'cy-asset://app/character.png?x=1',
    'file:///etc/passwd', 'https://app/character.png', 'cy-asset://app/config.json', 'not a url',
  ]) assert.equal(resolveAsset(bad), null, bad);
  // 시사 12(두 번째 춤 dance2·점심 포함) + 고를 수 있는 캐릭터 75(정지 그림 + clips.json 에 적힌 영상·첫 장면) + character.png + 반응 그림
  assert.equal(CHARACTER_FILES.length, 12);
  assert.equal(PICKABLE_FILES.length, 75);
  assert.equal(ALLOWED.size, 1 + CHARACTER_FILES.length + PICKABLE_FILES.length + IMAGES.length);
  for (const [rel] of [...CHARACTER_FILES, ...PICKABLE_FILES]) assert.ok(fs.existsSync(new URL(`../../assets/${rel}`, import.meta.url)), `${rel}: 허용 목록에 있는데 파일이 없음`);
});

test('cy-asset: 캐릭터 상태 그림·영상(character/) — 정확한 이름만, MIME 맞게', () => {
  const ok = {
    'character/eyes_open.png': 'image/png', 'character/eyes_closed.png': 'image/png',
    'character/eyes_open@2x.png': 'image/png', 'character/eyes_closed@2x.png': 'image/png',
    'character/studying.webm': 'video/webm', 'character/dance.webm': 'video/webm',
    'character/studying.png': 'image/png', 'character/dance.png': 'image/png',
    'character/dance2.webm': 'video/webm', 'character/dance2.png': 'image/png',
  };
  for (const [rel, type] of Object.entries(ok)) assert.deepEqual(resolveAsset(`cy-asset://app/${rel}`), { rel, type }, rel);
  assert.deepEqual(resolveAsset('cy-asset://app/character/eyes_open%402x.png'), { rel: 'character/eyes_open@2x.png', type: 'image/png' });
  for (const bad of [
    'cy-asset://app/character/video.json', 'cy-asset://app/character/../config.json', 'cy-asset://app/character/%2e%2e/cy.db',
    'cy-asset://app/character/dance.mp4', 'cy-asset://app/character/', 'cy-asset://app/character', 'cy-asset://app/Character/dance.webm',
    'cy-asset://app/character/dance.webm?t=1', 'cy-asset://app/character/dance.webm%00.png', 'cy-asset://app/character%2fdance.webm/../x',
    'cy-asset://app//character/dance.webm',
  ]) assert.equal(resolveAsset(bad), null, bad);
});

test('Range: <video> 가 끊어 읽는 bytes=a-b · a- · -n, 이상하면 invalid, 없거나 여러 구간이면 전체', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=20-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
});

test('배경 투명화: 가장자리에서 이어진 흰색만 지우고, 외곽선 안 흰색은 남긴다', () => {
  // 9×9: 흰 배경 / 갈색 테두리 링(2..6) / 안쪽 흰 점(4,4)
  const w = 9, h = 9, rgba = Buffer.alloc(w * h * 4, 255);
  const set = (x, y, c) => { const i = (y * w + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255; };
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) set(x, y, [240, 225, 205]); // 크림색 털(흰색 아님)
  for (let i = 2; i <= 6; i++) { set(i, 2, [70, 40, 20]); set(i, 6, [70, 40, 20]); set(2, i, [70, 40, 20]); set(6, i, [70, 40, 20]); }
  set(4, 4, [255, 255, 255]); // 옷깃
  const out = knockOutWhite({ w, h, rgba });
  const a = (x, y) => out.rgba[(y * w + x) * 4 + 3];
  assert.equal(a(0, 0), 0);
  assert.equal(a(8, 8), 0);
  assert.equal(a(1, 4), 0);
  assert.equal(a(2, 4), 255); // 진한 외곽선
  assert.equal(a(4, 4), 255); // 안쪽 흰색 유지
  assert.equal(a(3, 3), 255); // 크림색 유지
  // PNG 왕복
  const back = decodePNG(encodePNG(w, h, out.rgba));
  assert.deepEqual([back.w, back.h, back.rgba[3]], [9, 9, 0]);
});

test('cy-asset: 홈에 없으면 레포 assets/ 로, character.png 만 번들 플레이스홀더까지', () => {
  const dirs = { user: '/h/.cy-agent/assets', repo: '/r/assets', bundled: '/app/assets' };
  assert.deepEqual(assetCandidates('character/dance.webm', dirs), ['/h/.cy-agent/assets/character/dance.webm', '/r/assets/character/dance.webm']);
  assert.deepEqual(assetCandidates('character.png', dirs), ['/h/.cy-agent/assets/character.png', '/r/assets/character.png', '/app/assets/character.png']);
  assert.deepEqual(assetCandidates('reactions/merge.jpg', { user: '/h/a/' }), ['/h/a/reactions/merge.jpg']);
});

test('assetCandidates: 앱 번들(dmg) 그림은 홈 다음, 플레이스홀더 앞', () => {
  const dirs = { user: '/h/.cy-agent/assets', bundle: '/A/시사.app/Contents/Resources/assets', bundled: '/A/app.asar/assets' };
  assert.deepEqual(assetCandidates('character/eyes_open.png', dirs), ['/h/.cy-agent/assets/character/eyes_open.png', '/A/시사.app/Contents/Resources/assets/character/eyes_open.png']);
  assert.deepEqual(assetCandidates('character.png', dirs), ['/h/.cy-agent/assets/character.png', '/A/시사.app/Contents/Resources/assets/character.png', '/A/app.asar/assets/character.png']);
  assert.deepEqual(assetCandidates('reactions/merge.jpg', { user: null, repo: null, bundle: '/R/assets' }), ['/R/assets/reactions/merge.jpg']);
});
