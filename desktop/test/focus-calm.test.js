import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
test('집중 렌더러는 원본 공부 장면을 그대로 쓰고, 장면이 없을 때만 원본 대기 그림을 쓴다', () => {
  const declaration = src.split('\n').find((l) => l.startsWith('const clipOf ='));
  const original = { src: 'work.webm', kind: 'video' };
  const ctx = { act: { focus: 'on' }, charA: { open: 'current-character.png' }, studyVariant: 2, clipFor: () => original };
  const clip = vm.runInNewContext(`(() => { ${declaration}; return clipOf('studying'); })()`, ctx);
  assert.equal(clip, original);
  ctx.clipFor = () => null;
  const fallback = vm.runInNewContext(`(() => { ${declaration}; return clipOf('studying'); })()`, ctx);
  assert.equal(fallback.kind, 'img');
  assert.equal(fallback.src, 'current-character.png');
  assert.doesNotMatch(readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8'), /content: '📖'/);
});
