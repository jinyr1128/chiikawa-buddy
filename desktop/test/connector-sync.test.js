// 연결 카드: 캘린더가 「연결됨」인데 일정을 못 가져오면 그 까닭을 같은 자리에(제보: 「캘린더 연결됨」 + 「연결 안 돼서 일정을 못 가져왔다」)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeConnectors, connectorChipView } from '../src/dashboard.js';

test('shapeConnectors: 캘린더 동기화 상태(sync)를 모양만 맞춰 싣는다', () => {
  const [cal, slack] = shapeConnectors([
    { cap: 'calendar', mode: 'api', ready: true, detail: 'ICS 1개', sync: { phase: 'failed', reason: '구글 캘린더의 「공개 주소」를 넣으셨어요', meetings: 2, at: 'x' } },
    { cap: 'slack', mode: 'off', ready: false, sync: { phase: 'ok' } },
  ]);
  assert.deepEqual(cal.sync, { phase: 'failed', meetings: 2, reason: '구글 캘린더의 「공개 주소」를 넣으셨어요' });
  assert.equal('sync' in slack, false); // 꺼진 줄엔 없다
  assert.equal('sync' in shapeConnectors([{ cap: 'calendar', mode: 'api', ready: true, sync: { phase: 'weird' } }])[0], false);
  assert.equal(shapeConnectors([{ cap: 'calendar', mode: 'api', ready: true, sync: { phase: 'failed', reason: 'x'.repeat(500) } }])[0].sync.reason.length, 300);
});

test('connectorChipView: 가져오는 중·못 가져옴(이유)·가져옴(일정 수), 예전 데몬(sync 없음)은 그대로', () => {
  const base = { cap: 'calendar', mode: 'api', modeLabel: 'API', ready: true };
  assert.deepEqual(connectorChipView({ ...base }), { tone: 'ok', text: '연결됨 · API' });
  assert.equal(connectorChipView({ ...base, sync: { phase: 'pending' } }).text, '연결됨 · 일정 가져오는 중');
  const fail = connectorChipView({ ...base, sync: { phase: 'failed', reason: '구글 캘린더의 「공개 주소」를 넣으셨어요' } });
  assert.deepEqual(fail, { tone: 'warn', text: '연결됨 · 일정을 못 가져옴', hint: '구글 캘린더의 「공개 주소」를 넣으셨어요' });
  assert.equal(connectorChipView({ ...base, sync: { phase: 'ok', meetings: 0 } }).hint, '오늘·내일 일정 0개를 가져왔어요.');
  assert.deepEqual(connectorChipView({ cap: 'slack', mode: 'off' }), { tone: '', text: '연결 안 됨' });
  assert.deepEqual(connectorChipView({ ...base, ready: false }), { tone: 'warn', text: '준비 안 됨 · API' });
  for (const v of [fail, connectorChipView({ ...base, sync: { phase: 'pending' } })]) assert.ok(!JSON.stringify(v).includes('—'), 'em dash 없음');
});
