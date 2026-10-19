import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normAgents, agentStrip, agentCard, placeAgents, agentsSig, runningCount, runningCaption, okToolUseId, agentStatus } from '../src/agents.js';
import { focusTarget } from '../src/session.js';

const T = (m) => `2026-10-12T01:${String(m).padStart(2, '0')}:00.000Z`;
const ag = (o) => ({ runId: 'run-1', toolUseId: `toolu_${o.n ?? 1}`, description: '조사', status: 'running', tools: 0, last: '', startedAt: T(o.m ?? 0), ...o });

test('normAgents: 모양이 틀린 건 빼고, 시작 순, 모르는 상태는 stopped', () => {
  const out = normAgents({ agents: [
    ag({ n: 2, m: 5, description: '  둘째  ', status: 'done', tools: 3, endedAt: T(6), via: 'cli' }),
    ag({ n: 1, m: 1, status: 'weird', tools: -2 }),
    { runId: '../x', toolUseId: 't', startedAt: T(0) },
    { runId: 'r', toolUseId: 'bad id!', startedAt: T(0) },
    { runId: 'r', toolUseId: 't', startedAt: 'nope' },
    null,
    ag({ n: 3, m: 2, description: '' }),
  ] });
  assert.deepEqual(out.map((a) => [a.toolUseId, a.description, a.status, a.tools]), [
    ['toolu_1', '조사', 'stopped', 0], ['toolu_3', '서브에이전트', 'running', 0], ['toolu_2', '둘째', 'done', 3],
  ]);
  assert.equal(out[2].via, 'cli');
  assert.equal(out[2].endedAt, T(6));
  assert.deepEqual(normAgents(null), []);
  assert.ok(okToolUseId('toolu_01AbC-x') && !okToolUseId('') && !okToolUseId(3));
});

test('agentStrip: 돌고 있는 게 없으면 null · 돌고 있는 줄 + 끝난 것 접힘/펼침', () => {
  assert.equal(agentStrip([]), null);
  assert.equal(agentStrip([ag({ status: 'done' })]), null);
  const list = [
    ag({ n: 1, status: 'done', tools: 2, description: '첫째' }),
    ag({ n: 2, status: 'running', tools: 4, last: 'Bash(npm   test)', description: 'STT 확인' }),
    ag({ n: 3, status: 'failed', description: '셋째' }),
    ag({ n: 4, status: 'stopped', description: '넷째' }),
  ];
  const s = agentStrip(list);
  assert.deepEqual(s.running.map((r) => r.text), ['STT 확인 · 도구 4번 · Bash(npm test)']);
  assert.equal(s.finished.label, '에이전트 3개 끝남');
  assert.deepEqual(s.finished.rows, []);
  const o = agentStrip(list, { open: true });
  assert.deepEqual(o.finished.rows.map((r) => [r.icon, r.text]), [['–', '넷째'], ['✗', '셋째'], ['✓', '첫째 · 도구 2번']]);
  assert.equal(agentStrip([list[1]]).finished, null);
  assert.equal(runningCount(list), 1);
  assert.equal(runningCaption(2), '에이전트 2개 실행 중');
  assert.equal(runningCaption(0), '');
  assert.equal(agentStatus({ status: '???' }).text, '끝남(결과 없음)');
});

test('agentCard: 시작 카드 글과 상태', () => {
  assert.deepEqual(agentCard(ag({ status: 'running', tools: 2, last: 'Read(a.ts)' })), { title: '🤖 에이전트 시작: 조사', status: '진행 중 · 도구 2번', tone: 'run', last: 'Read(a.ts)' });
  assert.equal(agentCard(ag({ status: 'done', tools: 5, last: 'x' })).status, '끝남 ✓ · 도구 5번');
  assert.equal(agentCard(ag({ status: 'done', last: 'x' })).last, '');
  assert.equal(agentCard(ag({ status: 'failed' })).status, '실패 ✗');
  assert.equal(agentCard(ag({ status: 'stopped' })).status, '끝남(결과 없음)');
});

test('placeAgents: 시작 시각 뒤 첫 말 앞 · 마지막 말 뒤는 tail · 위에 안 불러온 말이 있으면 첫 말보다 이른 건 뺌', () => {
  const msgs = [{ at: T(0) }, { at: T(10) }, { at: T(20) }];
  const a = ag({ n: 1, m: 5 }), b = ag({ n: 2, m: 6 }), c = ag({ n: 3, m: 25 }), early = ag({ n: 4 });
  early.startedAt = '2026-10-12T00:59:00.000Z';
  const p = placeAgents([early, a, b, c], msgs);
  assert.deepEqual([...p.before.entries()].map(([i, xs]) => [i, xs.map((x) => x.toolUseId)]), [[0, ['toolu_4']], [1, ['toolu_1', 'toolu_2']]]);
  assert.deepEqual(p.tail.map((x) => x.toolUseId), ['toolu_3']);
  const q = placeAgents([early, a], msgs, { moreAbove: true });
  assert.deepEqual([...q.before.keys()], [1]);
  assert.deepEqual(placeAgents([a], []).tail.length, 1);
});

test('agentsSig: 진행이 바뀌면 달라짐', () => {
  assert.equal(agentsSig([ag({})]), agentsSig([ag({})]));
  assert.notEqual(agentsSig([ag({})]), agentsSig([ag({ tools: 1 })]));
});

test('focusTarget: Agent 줄 key · 묶음 key · 펼칠 서브에이전트(바깥 것까지)', () => {
  const events = [
    { seq: 1, type: 'user', text: '해 줘' },
    { seq: 2, type: 'tool_use', name: 'Read', input: 'a', toolUseId: 'r1' },
    { seq: 3, type: 'tool_use', name: 'Agent', input: '조사', toolUseId: 'A' },
    { seq: 4, type: 'tool_use', name: 'Agent', input: '안쪽', toolUseId: 'N', parent: 'A' },
    { seq: 5, type: 'tool_use', name: 'Bash', input: 'ls', toolUseId: 'b', parent: 'N' },
    { seq: 6, type: 'assistant', text: '끝' },
  ];
  assert.deepEqual(focusTarget(events, 'A'), { key: 't3', groupKey: 'g2', subs: ['t3'] });
  assert.deepEqual(focusTarget(events, 'N'), { key: 't4', groupKey: 'g2', subs: ['t3', 't4'] });
  assert.equal(focusTarget(events, 'zzz'), null);
  assert.equal(focusTarget(events, ''), null);
  assert.equal(focusTarget([{ seq: 9, type: 'tool_use', name: 'Agent', toolUseId: 'X', parent: 'gone' }], 'X'), null);
});
