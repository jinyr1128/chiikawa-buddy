// 확인 카드(회의 응답) — 정리·갱신·배치·모양·결과
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction, normalizeActions, upsertAction, placeActions, cardView, bubbleText, decideResult, okActionId, bubbleAfterAction } from '../src/actions.js';
import { normalizeBubble } from '../src/bubbles.js';

const card = { icon: '📅', title: '〈주간 회의〉', when: '10/15 목 10:00', verb: '수락', question: '**수락**으로 응답할까요?', notice: '주최자에게 알림이 가요', comment: '참석할게요' };
const raw = (o = {}) => ({ id: 'a1', type: 'calendar_respond', status: 'pending', card, summary: 's', threadId: 't1', msgN: 7, via: 'chat', expiresAt: '2026-10-12T01:30:00Z', ...o });

test('정리: 모양이 틀리면 null, 모르는 상태 거부, 글 길이 자름', () => {
  assert.equal(normalizeAction(null), null);
  assert.equal(normalizeAction(raw({ id: '../x' })), null);
  assert.equal(normalizeAction(raw({ status: 'weird' })), null);
  const a = normalizeAction(raw({ card: { ...card, title: 'x'.repeat(500) } }));
  assert.equal(a.card.title.length, 200);
  assert.equal(a.msgN, 7);
  assert.deepEqual(normalizeActions([raw(), { id: 'bad id' }]).map((x) => x.id), ['a1']);
  assert.equal(okActionId('abc_1-2'), true);
  assert.equal(okActionId('a b'), false);
});

test('갱신: 같은 id 는 바꾸고, 늦게 온 이전 상태는 무시, msgN 은 유지', () => {
  let list = upsertAction([], raw());
  list = upsertAction(list, raw({ status: 'running', msgN: undefined }));
  assert.equal(list[0].status, 'running');
  assert.equal(list[0].msgN, 7);
  list = upsertAction(list, raw({ status: 'done', result: { ok: true, message: '수락으로 응답했어요' } }));
  list = upsertAction(list, raw({ status: 'pending' })); // 늦은 이벤트
  assert.equal(list[0].status, 'done');
  assert.equal(upsertAction(list, { id: 'zz' }), list);
  assert.equal(upsertAction(list, raw({ id: 'a2' })).length, 2);
});

test('배치: 답 메시지 n 에 붙이고, 없으면 맨 아래', () => {
  const msgs = [{ role: 'user', n: 6 }, { role: 'assistant', n: 7 }];
  const { byMsg, orphans } = placeActions(normalizeActions([raw(), raw({ id: 'a2', msgN: 99 }), raw({ id: 'a3', msgN: undefined })]), msgs);
  assert.deepEqual(byMsg.get(7).map((a) => a.id), ['a1']);
  assert.deepEqual(orphans.map((a) => a.id), ['a2', 'a3']);
});

test('카드 모양: 대기면 물음+버튼, 누른 뒤엔 잠금, 결과는 ✅/⚠️, 취소·만료는 버튼 없음', () => {
  const p = cardView(normalizeAction(raw()));
  assert.equal(p.head, '📅 〈주간 회의〉 (10/15 목 10:00)');
  assert.equal(p.question, '**수락**으로 응답할까요? 주최자에게 알림이 가요');
  assert.equal(p.comment, '참석할게요');
  assert.deepEqual([p.showButtons, p.disabled, p.status], [true, false, null]);
  const c = cardView(normalizeAction(raw()), 'confirming');
  assert.deepEqual([c.showButtons, c.disabled, c.status], [true, true, '⏳ 보내는 중…']);
  const r = cardView(normalizeAction(raw({ status: 'running' })));
  assert.deepEqual([r.showButtons, r.disabled], [false, true]);
  const d = cardView(normalizeAction(raw({ status: 'done', result: { ok: true, message: '수락으로 응답했어요' } })));
  assert.deepEqual([d.showButtons, d.status, d.tone, d.question], [false, '✅ 수락으로 응답했어요', 'ok', '']);
  const f = cardView(normalizeAction(raw({ status: 'failed', result: { ok: false, message: '응답 실패: x' } })));
  assert.deepEqual([f.status, f.tone], ['⚠️ 응답 실패: x', 'error']);
  assert.match(cardView(normalizeAction(raw({ status: 'cancelled' }))).status, /취소/);
  assert.match(cardView(normalizeAction(raw({ status: 'expired' }))).status, /만료/);
  assert.match(cardView(normalizeAction(raw()), { error: '보내지 못했어요' }).status, /⚠️ 보내지 못했어요/);
  assert.equal(bubbleText(normalizeAction(raw())), '📅 〈주간 회의〉 (10/15 목 10:00) — **수락**으로 응답할까요? 주최자에게 알림이 가요');
});

test('결과: 200·409 는 서버 카드로, 연결 실패는 그대로 두고 오류', () => {
  const a = normalizeAction(raw());
  assert.equal(decideResult(a, 'confirm', { ok: true, data: { action: raw({ status: 'done' }) } }).action.status, 'done');
  assert.equal(decideResult(a, 'confirm', { ok: false, status: 409, data: { action: raw({ status: 'expired' }) } }).action.status, 'expired');
  const e = decideResult(a, 'confirm', { ok: false, error: 'ECONNREFUSED' });
  assert.equal(e.action, a);
  assert.match(e.error, /다시 눌러/);
  assert.match(decideResult(a, 'cancel', { ok: false, status: 404 }).error, /못 찾았어요/);
});

test('말풍선: actions "action" 은 제안 + actionId 일 때만', () => {
  const b = normalizeBubble({ id: 'action:a1', text: '📅 수락할까요?', kind: 'proposal', actions: 'action', actionId: 'a1' });
  assert.deepEqual([b.actions, b.actionId, b.ttlMs], ['action', 'a1', null]);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'info', actions: 'action', actionId: 'a1' }).actions, undefined);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'proposal', actions: 'action', actionId: 'a b' }).actions, undefined);
});

// ── 도구 승인 카드(tool_permission) ──
import { actionButtons, PERMISSION } from '../src/actions.js';
const pcard = { icon: '📄', title: 'docs · upload_document', verb: '실행', question: '**docs.upload_document** 를 실행할까요?', notice: '허용하면 바로 실행돼요',
  fields: [{ label: '제목', value: '테스트' }, { label: '', value: 'x' }, 'bad'], body: '본문 «redacted»', bodyKind: 'text', always: 'docs upload_document' };
const praw = (o = {}) => ({ id: 'p1', type: PERMISSION, status: 'pending', card: pcard, summary: 's', threadId: 't1', via: 'chat', toolName: 'mcp__docs__upload_document', todoId: 'mail:1', ...o });

test('도구 승인 카드: 필드·본문·항상 범위 정리, 버튼 [허용]/[항상 허용]/[거부] — 범위 없으면 [항상] 없음', () => {
  const a = normalizeAction(praw());
  assert.deepEqual(a.card.fields, [{ label: '제목', value: '테스트' }]);
  assert.deepEqual([a.card.body, a.card.bodyKind, a.card.always, a.toolName, a.todoId], ['본문 «redacted»', 'text', 'docs upload_document', 'mcp__docs__upload_document', 'mail:1']);
  const v = cardView(a);
  assert.equal(v.permission, true);
  assert.deepEqual(v.buttons.map((b) => b.decision), ['confirm', 'always', 'cancel']);
  assert.deepEqual(v.buttons.map((b) => b.label), ['허용', '항상 허용', '거부']);
  assert.match(v.buttons[1].title, /docs.upload_document/);
  assert.equal(v.body, '본문 «redacted»');
  assert.deepEqual(actionButtons(normalizeAction(praw({ card: { ...pcard, always: undefined } }))).map((b) => b.decision), ['confirm', 'cancel']);
  assert.deepEqual(cardView(normalizeAction(raw())).buttons.map((b) => b.label), ['실행', '취소']); // 회의 응답 카드는 그대로
  assert.equal(normalizeAction(praw({ card: { ...pcard, bodyKind: 'evil' } })).card.bodyKind, 'text');
});

test('도구 승인 카드 상태: 누르는 중 잠금, 허용 ✅ · 거부 ✗ · 만료 ⌛ — 버튼 없음', () => {
  const a = normalizeAction(praw());
  const busy = cardView(a, 'always');
  assert.deepEqual([busy.disabled, busy.status, busy.buttons[1].label], [true, '허용하는 중…', '저장하는 중…']);
  assert.equal(cardView(a, 'cancelling').status, '거부하는 중…');
  const d = cardView(normalizeAction(praw({ status: 'done', result: { ok: true, message: '항상 허용으로 저장했어요 — docs upload_document' } })));
  assert.deepEqual([d.status, d.tone, d.buttons.length, d.question], ['✅ 항상 허용으로 저장했어요 — docs upload_document', 'ok', 0, '']);
  assert.equal(cardView(normalizeAction(praw({ status: 'cancelled' }))).status, '✗ 거부했어요 — 실행하지 않았어요');
  assert.equal(cardView(normalizeAction(praw({ status: 'expired', result: { ok: false, message: '응답이 없어 취소했어요' } }))).status, '⌛ 응답이 없어 취소했어요 — 실행하지 않았어요');
  assert.match(decideResult(a, 'cancel', { ok: false }).error, /거부하지 못했어요/);
  assert.match(decideResult(a, 'always', { ok: false }).error, /허용하지 못했어요/);
});

test('말풍선: actions "permission" 은 제안 + actionId 일 때만', () => {
  const b = normalizeBubble({ id: 'action:p1', text: '🖥️ 실행할까요?', kind: 'proposal', actions: 'permission', actionId: 'p1', detail: 'npm test' });
  assert.deepEqual([b.actions, b.actionId, b.ttlMs, b.detail], ['permission', 'p1', null, 'npm test']);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'todo', actions: 'permission', actionId: 'p1' }).actions, undefined);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'proposal', actions: 'nope', actionId: 'p1' }).actions, undefined);
});

test('오버레이: 다른 곳에서 결정된 카드(SSE action) → 승인 말풍선을 결과 한 줄로, 기다림·보내는 중은 그대로', () => {
  assert.equal(bubbleAfterAction(praw()), null);
  assert.equal(bubbleAfterAction(raw({ status: 'running' })), null);
  assert.equal(bubbleAfterAction({ id: '../x', status: 'done' }), null);
  const d = bubbleAfterAction(praw({ status: 'done', result: { ok: true, message: '허용했어요' } }));
  assert.equal(d.id, `action:${d.actionId}`);
  assert.deepEqual([d.patch.decided, d.patch.kind, d.patch.ttlMs], [true, 'done', 8000]);
  assert.match(d.patch.text, /^✅ 허용했어요 — /);
  const c = bubbleAfterAction(raw({ status: 'cancelled' }));
  assert.deepEqual([c.id, c.patch.kind], ['action:a1', 'info']);
  assert.match(c.patch.text, /✗ 취소했어요 — 보내지 않았어요 — 📅 〈주간 회의〉 \(10\/15 목 10:00\)/);
  assert.equal(bubbleAfterAction(raw({ status: 'failed', result: { ok: false, message: '안 됨' } })).patch.kind, 'error');
});
