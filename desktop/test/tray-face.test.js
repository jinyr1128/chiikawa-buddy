import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceBox } from '../src/tray-face.js';

const img = (w, h, fill) => { const b = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) b[(y * w + x) * 4 + 3] = 255; return b; };

test('메뉴 막대 얼굴: 동그란 캐릭터는 위에서부터, 키 큰 캐릭터는 조금 아래, 빈 그림은 전체', () => {
  const round = faceBox(img(100, 100, (x, y) => x >= 20 && x < 80 && y >= 10 && y < 70), 100, 100);
  assert.deepEqual(round, { x: 22, y: 10, width: 57, height: 57 });
  const tall = faceBox(img(100, 200, (x, y) => x >= 30 && x < 70 && y >= 0 && y < 200), 100, 200);
  assert.equal(tall.width, 38);
  assert.ok(tall.y > 50 && tall.y < 100);
  assert.deepEqual(faceBox(new Uint8Array(10 * 10 * 4), 10, 10), { x: 1, y: 0, width: 9, height: 9 });
});
