import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToastQueue } from '../src/toasts.js';

const it = (id, source = 'mail') => ({ id, source, title: id, at: '2026-10-19T07:00:00Z' });

test('알림 팝업: 최신이 위, 최대 3장', () => {
  const q = createToastQueue();
  q.push(it('a'), 0); q.push(it('b', 'slack'), 10_000); q.push(it('c', 'calendar'), 20_000); q.push(it('d', 'claude'), 30_000);
  assert.deepEqual(q.list().map((t) => t.id), ['d', 'c', 'b']);
  q.remove('c');
  assert.deepEqual(q.list().map((t) => t.id), ['d', 'b']);
});

test('한 출처에서 몰려 오면 한 장으로 묶고 개수를 센다', () => {
  const q = createToastQueue();
  for (let i = 0; i < 3; i++) q.push(it(`s${i}`, 'slack'), i * 100);
  assert.equal(q.list().length, 3);
  q.push(it('s3', 'slack'), 400);
  assert.deepEqual(q.list().map((t) => t.id), ['sum:slack']);
  assert.equal(q.list()[0].summary.n, 4);
  for (let i = 4; i < 12; i++) q.push(it(`s${i}`, 'slack'), 500 + i);
  assert.equal(q.list()[0].summary.n, 12);
  assert.equal(q.list()[0].summary.latest.id, 's11');
  q.push(it('m', 'mail'), 600);
  assert.deepEqual(q.list().map((t) => t.id), ['m', 'sum:slack']);
});
