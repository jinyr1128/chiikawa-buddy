// 대화 속 작업 세션 카드(채팅이 넘긴 수정 run) — desktop/src/agents.js 의 sessions 부분
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normSessions, shortAge, sessionCard, placeSessions, sessionsSig, sessionsPlaceSig, normAgents } from '../src/agents.js';

const T = (m) => `2026-10-12T01:${String(m).padStart(2, '0')}:00.000Z`;
const ss = (o) => ({ runId: 'run-1', title: '다음 PR(과소분리 나누기)', repo: 'cy-agent', branch: 'cy/split-abc123', status: 'running', last: 'Bash(npm test)', startedAt: T(1), ...o });
const NOW = Date.parse(T(10));

test('normSessions: 모양이 틀린 건 빼고 시작 순 · 모르는 상태는 stopped · 예전 응답(sessions 없음)은 빈 목록', () => {
  assert.deepEqual(normSessions({ agents: [] }), []);
  assert.deepEqual(normSessions([]), []);
  const out = normSessions({ sessions: [
    ss({ runId: 'b', startedAt: T(5), status: 'weird', title: '  ', branch: ' ', prUrl: 'javascript:x', endedAt: 'nope', askedAt: T(4), continued: 'yes' }),
    ss({ runId: 'a', startedAt: T(2), status: 'done', endedAt: T(3), prUrl: 'https://github.com/o/r/pull/1', continued: true }),
    { runId: '../x', startedAt: T(0) },
    { runId: 'c', startedAt: 'nope' },
    null,
  ] });
  assert.deepEqual(out.map((s) => [s.runId, s.title, s.status]), [['a', '다음 PR(과소분리 나누기)', 'done'], ['b', '작업', 'stopped']]);
  assert.equal(out[0].prUrl, 'https://github.com/o/r/pull/1');
  assert.equal(out[0].continued, true);
  assert.equal(out[1].branch, undefined);
  assert.equal(out[1].prUrl, undefined);
  assert.equal(out[1].endedAt, undefined);
  assert.equal(out[1].askedAt, T(4));
  assert.equal(out[1].continued, undefined);
  // 같은 응답의 agents 는 그대로(normAgents 는 sessions 를 신경 쓰지 않음)
  assert.deepEqual(normAgents({ agents: [], sessions: [ss({})] }), []);
});

test('shortAge: 방금 · N분 · N시간 · N일(음수·NaN 은 방금)', () => {
  assert.equal(shortAge(0), '방금');
  assert.equal(shortAge(-5000), '방금');
  assert.equal(shortAge(NaN), '방금');
  assert.equal(shortAge(59e3), '방금');
  assert.equal(shortAge(60e3), '1분');
  assert.equal(shortAge(59 * 60e3), '59분');
  assert.equal(shortAge(3600e3), '1시간');
  assert.equal(shortAge(23 * 3600e3 + 3599e3), '23시간');
  assert.equal(shortAge(3 * 86400e3 + 5), '3일');
});

test('sessionCard: 진행 중 — 초록 점·점선 스피너·마지막 줄·시작부터 경과, 연결 끊기면 점이 꺼짐', () => {
  const v = sessionCard(ss({ last: '  Bash(npm\n test)  ' }), { now: NOW });
  assert.deepEqual({ tone: v.tone, dot: v.dot, spinning: v.spinning, icon: v.icon, header: v.header, sub: v.sub, label: v.label, last: v.last, age: v.age, status: v.status },
    { tone: 'run', dot: 'on', spinning: true, icon: '', header: 'cy-agent', sub: 'cy/split-abc123', label: '다음 PR(과소분리 나누기)', last: 'Bash(npm test)', age: '9분', status: '진행 중' });
  assert.equal(v.ageTitle, '시작한 지 9분');
  assert.equal(sessionCard(ss({}), { now: NOW, connected: false }).dot, 'off');
  assert.equal(sessionCard(ss({ last: '' }), { now: NOW }).last, '시작하는 중…');
  assert.equal(sessionCard(ss({ startedAt: T(10) }), { now: NOW }).ageTitle, '방금 시작했어요');
  const long = sessionCard(ss({ last: 'x'.repeat(400) }), { now: NOW }).last;
  assert.ok(long.length <= 160 && long.endsWith('…'));
  // 레포 이름이 없으면 머리는 작업 제목, 브랜치 없으면 아랫줄 없음
  const bare = sessionCard(ss({ repo: '', branch: undefined }), { now: NOW });
  assert.equal(bare.header, '다음 PR(과소분리 나누기)');
  assert.equal(bare.sub, '');
});

test('sessionCard: 끝남 ✓ / 실패 ✗ / 멈춤 – — 스피너 없음, 경과는 끝난 뒤로', () => {
  const done = sessionCard(ss({ status: 'done', endedAt: T(7), last: 'PR https://github.com/o/r/pull/9' }), { now: NOW });
  assert.deepEqual([done.tone, done.dot, done.spinning, done.icon, done.age, done.ageTitle, done.last], ['ok', 'ok', false, '✓', '3분', '끝남 · 3분 전', 'PR https://github.com/o/r/pull/9']);
  const failed = sessionCard(ss({ status: 'failed', endedAt: T(10) }), { now: NOW });
  assert.deepEqual([failed.tone, failed.dot, failed.icon, failed.age, failed.ageTitle, failed.status], ['bad', 'bad', '✗', '방금', '실패 · 방금', '실패']);
  const stopped = sessionCard(ss({ status: 'stopped', last: '' }), { now: NOW });
  assert.deepEqual([stopped.tone, stopped.dot, stopped.icon, stopped.last, stopped.age], ['muted', 'off', '–', '', '9분']); // endedAt 없으면 시작부터
  assert.equal(sessionCard(ss({ status: 'done', endedAt: T(7) }), { now: NOW, connected: false }).dot, 'ok'); // 끝난 건 연결과 상관없음
});

test('placeSessions: 채팅에서 시킨 것은 시킨 뒤 첫 답 바로 아래 · 답이 아직 없으면 맨 아래 · 이어서 한 것은 시작 시각 자리', () => {
  const msgs = [
    { role: 'user', text: '다음 PR 해줘', at: T(1) },
    { role: 'assistant', text: '다음 PR(과소분리 나누기) 작업 시작했어요. 진행은 작업 세션 창에서 볼 수 있어요.', at: T(3) },
    { role: 'user', text: '고마워', at: T(6) },
    { role: 'assistant', text: '네', at: T(7) },
  ];
  const asked = ss({ runId: 'a', askedAt: T(2), startedAt: T(2) }); // run 이 답보다 먼저 시작해도(askedAt 기준) 그 답 아래
  const cont = ss({ runId: 'c', startedAt: T(5), continued: true }); // 시작 시각 뒤 첫 말(T6) 앞 = 인덱스 1 뒤
  const late = ss({ runId: 'l', startedAt: T(9) });
  const early = ss({ runId: 'e', startedAt: T(0) });
  const p = placeSessions([asked, cont, late, early], msgs);
  assert.deepEqual([...p.after.entries()].sort((x, y) => x[0] - y[0]).map(([i, l]) => [i, l.map((s) => s.runId)]), [[-1, ['e']], [1, ['a', 'c']]]);
  assert.deepEqual(p.tail.map((s) => s.runId), ['l']);
  // 답이 아직 안 왔으면 맨 아래 — 답이 오면 그 아래로
  assert.deepEqual(placeSessions([asked], msgs.slice(0, 1)).tail.map((s) => s.runId), ['a']);
  // 위에 안 불러온 말이 있으면 첫 말보다 이른 것은 뺀다
  const more = placeSessions([early, ss({ runId: 'x', askedAt: T(0) })], msgs, { moreAbove: true });
  assert.equal(more.after.size + more.tail.length, 0);
  assert.deepEqual(placeSessions(undefined, undefined), { after: new Map(), tail: [] });
});

test('sessionsSig / sessionsPlaceSig: 진행 줄만 바뀌면 카드만, 상태·자리가 바뀌면 대화 다시', () => {
  const a = [ss({})];
  const b = [ss({ last: 'Read(a.ts)' })];
  const c = [ss({ status: 'done', endedAt: T(9) })];
  assert.notEqual(sessionsSig(a), sessionsSig(b));
  assert.equal(sessionsPlaceSig(a), sessionsPlaceSig(b));
  assert.notEqual(sessionsPlaceSig(a), sessionsPlaceSig(c));
  assert.equal(sessionsSig(undefined), '');
});
