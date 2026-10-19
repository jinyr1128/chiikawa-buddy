import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEATS, TIMING, parseArgs, resolveFrom, selectBeats, plan, totalOf, fmtClock, FAST_PACE } from '../scripts/demo-driver.mjs';

test('데모 옵션: 기본·--fast·--speed·--from·--only·포트', () => {
  const d = parseArgs([]);
  assert.equal(d.pace, 1);
  assert.equal(d.port, 47950);
  assert.equal(parseArgs(['--fast']).pace, FAST_PACE);
  assert.equal(parseArgs(['--speed', '2']).pace, 0.5);
  assert.ok(Math.abs(parseArgs(['--speed=0.8']).pace - 1.25) < 1e-9);
  assert.equal(parseArgs(['--from', 'todos']).from, 'todos');
  assert.deepEqual(parseArgs(['--only', 'chat, merge']).only, ['chat', 'merge']);
  assert.equal(parseArgs(['--loop', '--exit', '--shots', '/tmp/x']).shots, '/tmp/x');
  assert.throws(() => parseArgs(['--speed', '0']), /--speed/);
  assert.throws(() => parseArgs(['--port', '47823']), /진짜 데몬/);
  assert.throws(() => parseArgs(['--from', '2', '--only', '3']), /같이/);
  assert.throws(() => parseArgs(['--nope']), /모르는 옵션/);
  assert.throws(() => parseArgs(['--from']), /값이 필요/);
});

test('--from: 번호·id·앞부분, 잘못되면 오류', () => {
  assert.equal(resolveFrom(null), 0);
  assert.equal(resolveFrom('1'), 0);
  assert.equal(resolveFrom(String(BEATS.length)), BEATS.length - 1);
  assert.equal(resolveFrom('merge'), BEATS.findIndex((b) => b.id === 'merge'));
  assert.equal(resolveFrom('today'), BEATS.findIndex((b) => b.id === 'today'));
  assert.throws(() => resolveFrom('0'), /1–/);
  assert.throws(() => resolveFrom('zzz'), /그런 장면이 없어/);
});

test('--only 는 고른 장면만 원래 순서로, --from 은 거기서 끝까지', () => {
  const at = (id) => BEATS.findIndex((b) => b.id === id);
  assert.deepEqual(selectBeats({ only: ['merge', 'chat', 'merge'] }), [at('chat'), at('merge')]);
  assert.deepEqual(selectBeats({ from: 'meeting' }), [at('meeting'), at('day'), at('outro')]);
  for (const id of ['nobrain', 'setup', 'tour']) assert.ok(at(id) > 0 && at(id) < at('briefing'), `${id}: 처음 켤 때 장면은 앞쪽`);
  assert.equal(selectBeats({}).length, BEATS.length);
});

test('계획표: 누적 시작 시각, 속도·기본 느리기·장면 간격이 길이에 곱해짐', () => {
  const t = { base: 1, gaps: { afterBeat: 0 }, beats: {} };
  const rows = plan(BEATS, { pace: 1, timing: t });
  assert.equal(rows[0].at, 0);
  for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i].at - (rows[i - 1].at + rows[i - 1].dur)) < 0.11);
  assert.ok(Math.abs(totalOf(rows) - BEATS.reduce((s, b) => s + b.est, 0)) < 0.5);
  const half = plan(BEATS, { pace: 0.5, timing: t });
  assert.ok(Math.abs(totalOf(half) * 2 - totalOf(rows)) < 1);
  const slow = plan(BEATS, { pace: 1, timing: { base: 2, gaps: { afterBeat: 1000 }, beats: { idle: 3 } } });
  assert.equal(slow[0].dur, (BEATS[0].est * 3 + 1) * 2);
  const sel = plan(BEATS, { indices: [2, 5], timing: t });
  assert.deepEqual(sel.map((r) => r.n), [3, 6]);
  assert.equal(sel[1].at, BEATS[2].est);
  assert.ok(TIMING.gaps.beforeAction > 0 && TIMING.gaps.afterBeat > 0 && TIMING.typing.msPerChar > 0);
});

test('시각 표시', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(80.4), '01:20');
  assert.equal(fmtClock(-3), '00:00');
});
