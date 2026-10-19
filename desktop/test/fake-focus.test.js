import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFocus, seedSpans, localDay, handleFocus } from '../scripts/fake-focus.mjs';

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime(); // 2026-10-14(수) 15:00 로컬

test('가짜 집중하기: 시작·일시정지·다시 시작·그만(두 번 눌러도 안전), 쉰 시간은 빼고 셈', () => {
  let t = NOW;
  const events = [];
  const f = createFakeFocus({ emit: (e, d) => events.push([e, d]), now: () => t, seed: false });
  assert.equal(f.view().active, null);
  f.start();
  const id = f.view().active.id;
  f.start();
  assert.equal(f.view().active.id, id);
  t += 10 * 60e3;
  f.pause(); f.pause();
  assert.equal(f.view().active.paused, true);
  assert.equal(f.view().active.since, null);
  t += 5 * 60e3; // 쉬는 중
  f.resume();
  t += 2 * 60e3;
  assert.equal(f.view().active.seconds, 12 * 60);
  assert.equal(f.view().today, 12 * 60);
  const r = f.stop();
  assert.deepEqual(r.stopped, { id, seconds: 12 * 60 });
  assert.equal(r.active, null);
  assert.equal(f.stop().stopped, null);
  assert.ok(events.some(([e, d]) => e === 'bubble' && d.text === '12분 집중했어요. 수고했어요!'));
  assert.ok(events.filter(([e]) => e === 'focus').length >= 4);
});

test('가짜 집중하기: stats 는 날마다 seconds·longest, 자정 넘긴 구간은 나눠 셈, 틀린 범위는 undefined', () => {
  let t = new Date(2026, 9, 13, 23, 50).getTime();
  const f = createFakeFocus({ now: () => t, seed: false });
  f.start();
  t += 30 * 60e3; // 00:20 까지
  f.stop();
  const s = f.stats('2026-10-13', '2026-10-14');
  assert.deepEqual(s.days, [{ date: '2026-10-13', seconds: 600, longest: 600 }, { date: '2026-10-14', seconds: 1200, longest: 1200 }]);
  assert.equal(s.total, 1800);
  assert.equal(f.stats('2026-10-14', '2026-10-13'), undefined);
  assert.equal(f.stats('2026-13-01', '2026-13-02'), undefined);
});

test('지어 넣은 기록: 지난 몇 주에 진한 날·연한 날·쉰 날이 섞여 있고, 돌릴 때마다 같다', () => {
  const f = createFakeFocus({ now: () => NOW });
  const s = f.stats('2026-09-01', '2026-10-13');
  const lv = (sec) => (sec < 1 ? 0 : sec < 1800 ? 1 : sec < 3600 ? 2 : sec < 7200 ? 3 : 4);
  const levels = new Set(s.days.map((d) => lv(d.seconds)));
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3, 4]);
  for (const d of s.days) assert.ok(d.longest <= d.seconds);
  assert.deepEqual(seedSpans(NOW), seedSpans(NOW));
  assert.ok(f.view().today > 0, '오늘 아침 기록');
  assert.equal(f.view().day, localDay(NOW));
});

test('HTTP: GET /focus · /focus/stats(400) · POST /focus/<cmd>(404)', () => {
  const f = createFakeFocus({ now: () => NOW, seed: false });
  const out = [];
  const json = (_res, status, body) => out.push([status, body]);
  const call = (method, u) => handleFocus(f, { method }, null, new URL(u, 'http://x'), json);
  assert.equal(call('GET', '/focus'), true);
  assert.equal(out.at(-1)[0], 200);
  call('GET', '/focus/stats?from=2026-10-14&to=2026-10-14');
  assert.equal(out.at(-1)[1].days.length, 1);
  call('GET', '/focus/stats?from=bad&to=2026-10-14');
  assert.equal(out.at(-1)[0], 400);
  call('POST', '/focus/start');
  assert.ok(out.at(-1)[1].active);
  call('POST', '/focus/nope');
  assert.equal(out.at(-1)[0], 404);
  assert.equal(call('GET', '/todos'), false);
});
