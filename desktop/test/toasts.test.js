import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toastView } from '../src/toasts.js';

const it = (id, read = false) => ({ id, source: 'mail', title: id, at: '2026-10-19T07:00:00Z', read });

test('알림 팝업: 안 읽은 것 중 최신 3장 + 나머지 개수, 읽은 건 안 보인다', () => {
  assert.deepEqual(toastView([]), { cards: [], more: 0 });
  const v = toastView([it('a'), it('b', true), it('c'), it('d'), it('e')]);
  assert.deepEqual(v.cards.map((x) => x.id), ['a', 'c', 'd']);
  assert.equal(v.more, 1);
  assert.equal(toastView([it('a'), it('b')]).more, 0);
});
