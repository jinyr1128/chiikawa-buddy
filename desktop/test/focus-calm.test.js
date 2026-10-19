import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
test('집중 중에도 캐릭터의 기존 study 변형 번호를 사용한다', () => {
  const declaration = src.split('\n').find((l) => l.startsWith('const clipOf ='));
  const calls = [];
  const ctx = { act: { focus: 'on' }, charA: {}, studyVariant: 2, clipFor: (...args) => { calls.push(args); return 'original-gif'; } };
  assert.equal(vm.runInNewContext(`(() => { ${declaration}; return clipOf('studying'); })()`, ctx), 'original-gif');
  assert.equal(calls[0][1], 'study'); assert.equal(calls[0][2], 2);
  assert.doesNotMatch(src, /if \(act.focus === 'on'\) return/);
  assert.doesNotMatch(readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8'), /focus-calm/);
});
