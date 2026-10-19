// 대화 속 워크트리 카드: 응답 거르기·토큰 글·줄 상태(완료 초록·실패 빨강·멈춤)·초록 테두리·자리(시킨 답 아래)·세션 창 열기 인자
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normWorktrees, fmtTokens, worktreeRow, worktreeCard, openTarget, placeWorktrees, worktreesSig, worktreesPlaceSig } from '../src/worktrees.js';

const T = (m) => `2026-10-13T10:${String(m).padStart(2, '0')}:00.000Z`;
const w = (key, o = {}) => ({ key, kind: 'agent', title: `일 ${key}`, status: 'running', tokens: 0, askedAt: T(1), ...o });

test('normWorktrees: 모양이 맞는 것만, 모르는 상태는 멈춤, 시킨 순', () => {
  const list = normWorktrees({ worktrees: [
    w('b', { askedAt: T(2), tokens: 12345.6, branch: 'cy/agent-b-1', path: '/w/app-ab', runId: 'run-1', toolUseId: 'toolu_b' }),
    w('a', { status: 'queued', path: 'rel', runId: 'bad id!' }),
    { key: 'x', kind: 'weird', askedAt: T(1) }, { kind: 'fix', askedAt: T(1) }, null,
  ] });
  assert.deepEqual(list.map((x) => [x.key, x.status, x.tokens, x.path, x.runId]), [['a', 'stopped', 0, undefined, undefined], ['b', 'running', 12346, '/w/app-ab', 'run-1']]);
  assert.deepEqual(normWorktrees({}), []);
});

test('fmtTokens: 950 토큰 · 12.3k 토큰 · 1.2M 토큰', () => {
  assert.equal(fmtTokens(950), '950 토큰');
  assert.equal(fmtTokens(12345), '12.3k 토큰');
  assert.equal(fmtTokens(1_234_567), '1.2M 토큰');
  assert.equal(fmtTokens(undefined), '0 토큰');
});

test('worktreeRow: 돌면 「토큰…」(늘어나는 중), 끝나면 완료(초록)·실패(빨강)·멈춤', () => {
  const run = worktreeRow(w('a', { tokens: 12345, branch: 'cy/agent-a-1' }));
  assert.equal(run.tokens, '12.3k 토큰…');
  assert.equal(run.state, null);
  assert.equal(run.running, true);
  assert.equal(run.branch, 'cy/agent-a-1');
  assert.deepEqual(worktreeRow(w('a', { status: 'done', tokens: 2000 })).state, { text: '완료', tone: 'ok' });
  assert.equal(worktreeRow(w('a', { status: 'done', tokens: 2000 })).tokens, '2.0k 토큰');
  assert.deepEqual(worktreeRow(w('a', { status: 'failed' })).state, { text: '실패', tone: 'bad' });
  assert.deepEqual(worktreeRow(w('a', { status: 'stopped' })).state, { text: '멈춤', tone: 'muted' });
  assert.equal(worktreeRow(w('a', { status: 'stopped' })).tokens, '');
});

test('worktreeCard: 하나라도 돌면 active(초록 테두리), 머리 「🌿 워크트리 N개」', () => {
  const c = worktreeCard([w('a'), w('b', { status: 'done' }), w('c', { status: 'failed' })]);
  assert.equal(c.head, '🌿 워크트리 3개');
  assert.equal(c.sub, '1개 진행 중');
  assert.equal(c.active, true);
  assert.equal(c.rows.length, 3);
  const end = worktreeCard([w('a', { status: 'done' }), w('b', { status: 'failed' })]);
  assert.equal(end.active, false);
  assert.equal(end.sub, '완료 1 · 실패 1');
  assert.equal(worktreeCard([w('a', { status: 'done' })]).sub, '다 끝났어요');
});

test('openTarget: 수정 run 은 run 만, 에이전트는 그 Agent 줄까지, run 이 아직 없으면 못 연다', () => {
  assert.deepEqual(openTarget(w('f', { kind: 'fix', runId: 'r1', toolUseId: 'x' })), { runId: 'r1' });
  assert.deepEqual(openTarget(w('a', { runId: 'r2', toolUseId: 'toolu_a' })), { runId: 'r2', toolUseId: 'toolu_a' });
  assert.equal(openTarget(w('a')), null);
});

test('placeWorktrees: 시킨 답 아래에 한 카드로 묶고, 둘 이상이면 그 수정 run 의 세션 카드는 숨김 · 수정 run 하나뿐이면 세션 카드만', () => {
  const msgs = [
    { role: 'user', at: T(0), text: '세 가지 고쳐줘' }, { role: 'assistant', at: T(3), text: '🌿 워크트리 3개 만들었어요' },
    { role: 'user', at: T(10), text: '하나 더' }, { role: 'assistant', at: T(12), text: '…' },
  ];
  const list = [
    w('f1', { kind: 'fix', runId: 'r1', askedAt: T(1) }), w('f2', { kind: 'fix', runId: 'r2', askedAt: T(2) }), w('a1', { askedAt: T(2) }),
    w('f3', { kind: 'fix', runId: 'r3', askedAt: T(11) }),
  ];
  const p = placeWorktrees(list, msgs);
  assert.deepEqual([...p.after.keys()], [1]);
  assert.deepEqual(p.after.get(1).map((x) => x.key), ['f1', 'f2', 'a1']);
  assert.deepEqual([...p.hideRuns].sort(), ['r1', 'r2']);
  assert.deepEqual(p.tail, []);
  // 아직 답이 안 온 턴(맨 아래)
  const t = placeWorktrees([w('a', { askedAt: T(20) }), w('b', { askedAt: T(20) })], msgs);
  assert.deepEqual(t.tail.map((g) => g.map((x) => x.key)), [['a', 'b']]);
});

test('sig: 토큰·상태만 바뀌면 내용 sig 만(그 카드만 고침 — 대화 전체를 다시 그리지 않음), 새 워크트리가 생기면 자리 sig', () => {
  const a = [w('a', { tokens: 10 })], b = [w('a', { tokens: 20 })], c = [w('a', { tokens: 20, status: 'done' })];
  assert.notEqual(worktreesSig(a), worktreesSig(b));
  assert.notEqual(worktreesSig(b), worktreesSig(c));
  assert.equal(worktreesPlaceSig(a), worktreesPlaceSig(b));
  assert.equal(worktreesPlaceSig(b), worktreesPlaceSig(c));
  assert.notEqual(worktreesPlaceSig(c), worktreesPlaceSig([...c, w('b')]));
});
