// 머지 승인: 패널 채팅의 머지 카드(검사·충돌·리뷰 + ✓ 머지/✗ 안 함)와 캐릭터 말풍선(같은 결정) — 순수 로직
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBubble, isWaitingApproval, isMergeApproval, approvalButtons, BubbleQueue } from '../src/bubbles.js';
import { MERGE, normalizeAction, cardView, mergeRows, aroundAnswer, foldedPermission, bubbleAfterAction, decideResult, upsertAction } from '../src/actions.js';

const URL = 'https://github.com/example/speaker/pull/268';
const merge = (o = {}) => ({
  number: 268, repo: 'example/speaker', title: '스피커 dev 설정', url: URL, base: 'develop', head: 'cy/feat-speaker-dev-1c7c7a',
  draft: false, mergeable: 'MERGEABLE', review: '', checks: { pass: 3, pending: 0, fail: 0, failing: [] }, ...o,
});
const raw = (o = {}, m = {}) => ({
  id: 'mc1', type: MERGE, status: 'pending', summary: '🔀 #268', via: 'chat', threadId: 't1', msgN: 4, mergeId: 'pr-example_speaker-268',
  card: { icon: '🔀', title: '#268 스피커 dev 설정', verb: '머지', question: '**#268** 을(를) 머지할까요?', notice: '', merge: merge(m) }, created: '2026-10-12T01:00:00Z', ...o,
});
const bubble = (o = {}) => ({ id: 'merge:pr-example_speaker-268', text: '#268 머지할까요? 검사 통과·충돌 없음', kind: 'proposal', proposalId: 'pr-example_speaker-268', actions: 'merge', image: 'merge', link: URL, ...o });

test('캐릭터 말풍선: 머지 승인도 승인 대기 — ✓ 머지/✗ 안 함/추가질문, 막혔으면 ✓ 꺼짐', () => {
  const b = normalizeBubble(bubble({ detail: 'example/speaker · develop ← cy/feat', open: { section: 'chat', id: 't1' } }));
  assert.equal(b.actions, 'merge');
  assert.equal(b.image, 'merge');
  assert.equal(b.ttlMs, null); // 결정될 때까지 안 사라짐
  assert.deepEqual(b.open, { section: 'chat', id: 't1' });
  assert.ok(isMergeApproval(b));
  assert.ok(isWaitingApproval(b));
  assert.deepEqual(approvalButtons(b).map((x) => [x.decision, x.label, !!x.disabled]), [['merge', '✓ 머지', false], ['decline', '✗ 안 함', false], ['ask', '추가질문', false]]);
  const blocked = normalizeBubble(bubble({ text: '#268 머지할 수 없어요 — 검사 1개 실패·충돌 없음', blocked: '검사 1개 실패(jest)' }));
  assert.equal(blocked.blocked, '검사 1개 실패(jest)');
  const ok = approvalButtons(blocked)[0];
  assert.equal(ok.disabled, true);
  assert.match(ok.title, /머지할 수 없어요 — 검사 1개 실패/);
  assert.equal(normalizeBubble(bubble({ proposalId: undefined })).actions, undefined); // proposalId 없으면 버튼 없음
  assert.equal(isWaitingApproval({ ...b, decided: true }), false);
});

test('캐릭터 말풍선: 머지 승인이 여러 개면 하나씩(+N), 결정되면 다음 것', () => {
  const q = new BubbleQueue();
  q.add(normalizeBubble(bubble()));
  q.add(normalizeBubble(bubble({ id: 'merge:p2', proposalId: 'p2', text: '#12 머지할까요?' })));
  q.add(normalizeBubble({ id: 'action:a', text: '보낼까요?', kind: 'proposal', actions: 'action', actionId: 'a' }));
  assert.deepEqual(q.visible().map((x) => x.id), ['merge:pr-example_speaker-268']);
  assert.equal(q.waitingMore('merge:pr-example_speaker-268'), 2);
  q.update('merge:pr-example_speaker-268', { decided: true });
  assert.deepEqual(q.visible().map((x) => x.id), ['merge:pr-example_speaker-268', 'merge:p2']);
});

test('채팅 카드: 대상·검사·충돌·리뷰 줄과 색, ✓ 머지/✗ 안 함', () => {
  const a = normalizeAction(raw({}, { review: 'APPROVED', checks: { pass: 3, pending: 1, fail: 0, failing: [] } }));
  assert.equal(a.mergeId, 'pr-example_speaker-268');
  const v = cardView(a);
  assert.equal(v.merge, true);
  assert.equal(v.head, '🔀 #268 스피커 dev 설정');
  assert.equal(v.sub, 'example/speaker');
  assert.equal(v.url, URL);
  assert.deepEqual(v.rows.map((r) => [r.label, r.value, r.tone]), [
    ['대상', 'develop ← cy/feat-speaker-dev-1c7c7a', 'muted'],
    ['검사', '⏳ 1개 대기 중 · 통과 3', 'warn'],
    ['충돌', '✓ 충돌 없음', 'ok'],
    ['리뷰', '승인됨', 'ok'],
  ]);
  assert.deepEqual(v.buttons.map((b) => [b.decision, b.label, !!b.disabled]), [['confirm', '✓ 머지', false], ['cancel', '✗ 안 함', false]]);
  assert.match(v.question, /머지할까요/);
  assert.equal(v.blocked, '');
  // 통과·충돌 있음·변경 요청·초안
  const rows = mergeRows(normalizeAction(raw({}, { mergeable: 'CONFLICTING', review: 'CHANGES_REQUESTED', draft: true })).card.merge);
  assert.deepEqual(rows.slice(1).map((r) => [r.value, r.tone]), [['✓ 3개 통과', 'ok'], ['✗ 충돌 있음', 'error'], ['변경 요청', 'error'], ['초안(draft)', 'warn']]);
});

test('채팅 카드: 실패한 검사면 ✓ 꺼지고 이유, 질문 대신 막힌 이유', () => {
  const a = normalizeAction(raw({}, { checks: { pass: 2, pending: 0, fail: 1, failing: ['jest'] }, blocked: '검사 1개 실패(jest) — 고친 뒤 다시 요청해 주세요' }));
  const v = cardView(a);
  assert.equal(v.rows[1].tone, 'error');
  assert.equal(v.rows[1].value, '✗ 1개 실패 — jest · 통과 2');
  assert.equal(v.buttons[0].disabled, true);
  assert.equal(v.buttons[1].disabled, undefined); // ✗ 는 누를 수 있다
  assert.match(v.blocked, /검사 1개 실패\(jest\)/);
  assert.equal(v.question, '');
});

test('채팅 카드: 결정 뒤 접힘 — 머지됨(+머지 커밋)·안 함·실패 이유, 머지 중엔 펼친 그대로', () => {
  const done = normalizeAction(raw({ status: 'done', result: { ok: true, message: '머지했어요', link: 'https://github.com/example/speaker/commit/abc1234' } }));
  const v = cardView(done);
  assert.equal(v.status, '🎉 머지했어요');
  assert.equal(v.tone, 'ok');
  assert.equal(v.link, 'https://github.com/example/speaker/commit/abc1234');
  assert.deepEqual(v.buttons, []);
  assert.equal(foldedPermission(done), true);
  const evil = normalizeAction(raw({ status: 'done', result: { ok: true, message: 'x', link: 'javascript:alert(1)' } }));
  assert.equal(evil.result.link, undefined);
  assert.equal(cardView(normalizeAction(raw({ status: 'cancelled' }))).status, '✗ 머지 안 함 — PR은 열어 뒀어요');
  const failed = cardView(normalizeAction(raw({ status: 'failed', result: { ok: false, message: '머지 실패: 충돌이 있어요' } })));
  assert.equal(failed.status, '⚠️ 머지 실패: 충돌이 있어요');
  assert.equal(failed.tone, 'error');
  const running = normalizeAction(raw({ status: 'running' }));
  assert.equal(cardView(running).status, '⏳ 머지하는 중…');
  assert.equal(cardView(running).disabled, true);
  assert.equal(foldedPermission(running), false);
  assert.equal(cardView(normalizeAction(raw()), 'confirming').status, '⏳ 머지하는 중…');
});

test('채팅 카드 자리: 머지 승인은 답 위(도구 승인처럼), 회의 응답 카드는 답 아래', () => {
  const m = normalizeAction(raw());
  const cal = normalizeAction({ id: 'c1', type: 'calendar_respond', status: 'pending', card: { icon: '📅', title: '회의' } });
  const r = aroundAnswer([cal, m]);
  assert.deepEqual(r.before.map((x) => x.id), ['mc1']);
  assert.deepEqual(r.after.map((x) => x.id), ['c1']);
});

test('한 화면에서 결정 → 다른 화면이 따라감: 카드 SSE(done/cancelled) → 캐릭터 머지 말풍선 결과로, 실패는 데몬이 다시 묻게 둔다', () => {
  const u = bubbleAfterAction(raw({ status: 'done', result: { ok: true, message: '머지했어요' } }));
  assert.equal(u.id, 'merge:pr-example_speaker-268');
  assert.equal(u.waitingOnly, true);
  assert.equal(u.patch.decided, true);
  assert.equal(u.patch.kind, 'done');
  assert.match(u.patch.text, /🎉 머지했어요 — 🔀 #268/);
  assert.equal(bubbleAfterAction(raw({ status: 'cancelled' })).patch.kind, 'info');
  assert.equal(bubbleAfterAction(raw({ status: 'failed', result: { ok: false, message: 'x' } })), null);
  assert.equal(bubbleAfterAction(raw({ status: 'running' })), null);
  // 말풍선에서 결정 → 데몬이 카드 상태를 바꿔 보낸다(SSE action) → 패널 목록이 따라감
  const list = upsertAction([], raw());
  const next = upsertAction(list, raw({ status: 'cancelled' }));
  assert.equal(next[0].status, 'cancelled');
  assert.equal(next[0].msgN, 4);
});

test('✓ 결과: 막힌 머지(409)는 데몬이 준 이유를 보인다', () => {
  const a = normalizeAction(raw());
  assert.deepEqual(decideResult(a, 'confirm', { ok: false, status: 409, data: { error: '검사 1개 실패(jest)' } }), { action: a, error: '검사 1개 실패(jest)' });
  assert.equal(decideResult(a, 'confirm', { ok: false, status: 409, data: { error: '벌써 머지하는 중이에요', action: raw() } }).error, '벌써 머지하는 중이에요');
  assert.equal(decideResult(a, 'confirm', { ok: false, status: 409, data: { error: 'x', action: raw({ status: 'failed' }) } }).error, null); // 실패는 카드 상태 줄로
  assert.equal(decideResult(a, 'confirm', { ok: false }).error, '머지 요청을 보내지 못했어요 — 다시 눌러 주세요');
  const ok = decideResult(a, 'confirm', { ok: true, data: { action: raw({ status: 'done' }) } });
  assert.equal(ok.action.status, 'done');
});
