import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayLabel, fullTime, stamp, withDayDividers } from '../src/chat-time.js';

// 기기 현지 시각으로 만든다(날짜는 현지 기준)
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const now = new Date(2026, 9, 12, 15); // 2026-10-12 (월) 15시

test('dayLabel: 오늘 / 어제 / 10월 10일 (토) / 해가 다르면 연도까지', () => {
  assert.equal(dayLabel(at(2026, 10, 12, 0, 1), now), '오늘');
  assert.equal(dayLabel(at(2026, 10, 11, 23, 59), now), '어제');
  assert.equal(dayLabel(at(2026, 10, 10), now), '10월 10일 (토)');
  assert.equal(dayLabel(at(2025, 12, 31), now), '2025년 12월 31일 (수)');
  assert.equal(dayLabel('', now), '');
  assert.equal(dayLabel('엉망', now), '');
  // 새해 첫날의 어제는 지난해 12월 31일
  assert.equal(dayLabel(at(2025, 12, 31), new Date(2026, 0, 1, 9)), '어제');
});

test('fullTime·stamp: 말풍선은 18:22, 올리면 전체 날짜·오전/오후', () => {
  assert.equal(fullTime(at(2026, 10, 12, 18, 22)), '2026년 10월 12일 (월) 오후 6:22');
  assert.equal(fullTime(at(2026, 10, 12, 0, 5)), '2026년 10월 12일 (월) 오전 12:05');
  assert.equal(fullTime(at(2026, 10, 12, 12, 0)), '2026년 10월 12일 (월) 오후 12:00');
  assert.deepEqual(stamp(at(2026, 10, 12, 18, 22)), { text: '18:22', title: '2026년 10월 12일 (월) 오후 6:22' });
  assert.deepEqual(stamp(at(2026, 10, 12, 9, 3)).text, '09:03');
  assert.equal(stamp(''), null);
  assert.equal(stamp('엉망'), null);
  assert.equal(dayKey('엉망'), null);
});

test('withDayDividers: 첫 말 위와 날짜가 바뀌는 곳에만 구분선, 시각 없는 말은 앞 말과 같은 날', () => {
  const ms = [
    { role: 'user', text: 'a', at: at(2026, 10, 10, 9) },
    { role: 'assistant', text: 'b', at: at(2026, 10, 10, 9, 1) },
    { role: 'system', text: 'c', at: at(2026, 10, 11, 8) },
    { role: 'user', text: 'd', at: '' },
    { role: 'user', text: 'e', at: at(2026, 10, 12, 18, 22) },
    { role: 'assistant', text: 'f', at: at(2026, 10, 12, 18, 23) },
  ];
  const out = withDayDividers(ms, now);
  assert.deepEqual(out.map((x) => (x.type === 'day' ? `[${x.label}]` : x.msg.text)), ['[10월 10일 (토)]', 'a', 'b', '[어제]', 'c', 'd', '[오늘]', 'e', 'f']);
  assert.equal(out[0].title, '2026년 10월 10일 (토)');
  assert.deepEqual(withDayDividers([], now), []);
  assert.deepEqual(withDayDividers(null, now), []);
});
