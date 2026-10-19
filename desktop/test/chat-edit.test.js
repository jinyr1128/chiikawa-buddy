// 말 고치기(✏️): 마지막 내 말에만, 고친 뒤 화면에서 그 말부터 뒤를 걷기, SSE edited 를 받은 다른 창
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTarget, dropFrom, mergeMessages, appendLocal } from '../src/threads.js';
import { initialChat, chatReducer } from '../src/chat.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const msgs = mergeMessages([], [
  { n: 1, role: 'user', text: '첫 물음', at: '2026-10-13T01:00:00.000Z' },
  { n: 2, role: 'assistant', text: '첫 답', at: '2026-10-13T01:00:05.000Z' },
  { n: 3, role: 'user', text: '둘째 물음', at: '2026-10-13T01:01:00.000Z', edited: '2026-10-13T01:01:00.000Z' },
  { n: 4, role: 'assistant', text: '둘째 답', at: '2026-10-13T01:01:05.000Z' },
]);

test('✏️ 는 마지막 내 말 하나에만 — 줄 선 말이 있으면 맨 뒤에 줄 선 말', () => {
  assert.deepEqual(editTarget(msgs), { kind: 'sent', n: 3 });
  assert.deepEqual(editTarget(msgs, [{ chatId: A }, { chatId: B }]), { kind: 'queued', chatId: B });
  // 아직 기록 전인 로컬 사본·터미널에서 이어 간 말이 마지막이면 없음
  assert.equal(editTarget(appendLocal(msgs, { role: 'user', text: '방금', at: '2026-10-13T01:02:00.000Z' })), null);
  assert.equal(editTarget(mergeMessages([], [{ n: 9, role: 'user', text: '터미널', at: 't', via: 'cli' }])), null);
  assert.equal(editTarget([]), null);
});

test('수정됨 표시는 서버 기록에서만, 고치면 그 말부터 뒤를 걷는다(로컬 사본은 그대로)', () => {
  assert.equal(msgs[2].edited, '2026-10-13T01:01:00.000Z');
  assert.equal(msgs[0].edited, undefined);
  const withLocal = appendLocal(msgs, { role: 'user', text: '고친 말', at: '2026-10-13T01:03:00.000Z' });
  assert.deepEqual(dropFrom(withLocal, 3).map((m) => m.text), ['첫 물음', '첫 답', '고친 말']);
  assert.equal(dropFrom(msgs, undefined), msgs);
});

test('SSE edited: 이 창이 보낸 답을 고쳤으면 새 답도 이 창 것(캐릭터 말풍선), 줄 선 말이면 글만 바뀐다', () => {
  let s = chatReducer(initialChat(), { type: 'accepted', chatId: A, threadId: 't' });
  s = chatReducer(s, { type: 'event', ev: { chatId: A, threadId: 't', status: 'thinking', sentAt: '2026-10-13T01:00:00.000Z' } });
  s = chatReducer(s, { type: 'event', ev: { chatId: A, threadId: 't', status: 'stopped', text: '멈췄어요' } });
  s = chatReducer(s, { type: 'consumed' });
  s = chatReducer(s, { type: 'event', ev: { chatId: B, threadId: 't', status: 'thinking', sentAt: '2026-10-13T01:00:01.000Z' } });
  s = chatReducer(s, { type: 'event', ev: { chatId: B, threadId: 't', status: 'edited', n: 3, text: '고친 말', replaces: A } });
  // stopped 로 mine 에서 빠졌으면 잇지 않는다 — 고칠 때 멈춘 답이 아직 mine 이면 잇는다
  let t = chatReducer(initialChat(), { type: 'accepted', chatId: A, threadId: 't' });
  t = chatReducer(t, { type: 'event', ev: { chatId: B, threadId: 't', status: 'edited', n: 3, text: '고친 말', replaces: A } });
  assert.deepEqual(t.mine, [B]);
  t = chatReducer(t, { type: 'event', ev: { chatId: B, threadId: 't', status: 'done', text: '새 답', show: null } });
  assert.deepEqual(t.replies.map((r) => r.text), ['새 답']);
  assert.ok(!s.mine.includes(B));
  // 줄 선 말 글 바꾸기
  let q = chatReducer(initialChat(), { type: 'event', ev: { chatId: A, threadId: 't', status: 'queued', position: 1, text: '옛 글', queuedAt: '2026-10-13T01:00:00.000Z' } });
  q = chatReducer(q, { type: 'event', ev: { chatId: A, threadId: 't', status: 'edited', text: '새 글' } });
  assert.equal(q.pending[A].text, '새 글');
  assert.equal(q.pending[A].queued, true);
});

test('AI 없이 고른 말은 로컬 사본에 canned 표시가 남는다(서버 말·답에는 안 붙음)', () => {
  const at = '2026-10-14T09:00:00Z';
  assert.equal(appendLocal([], { role: 'user', text: '좀 쉬어도 될까요?', at, canned: true })[0].canned, true);
  assert.equal(appendLocal([], { role: 'assistant', text: '잠깐 쉬어요', at, canned: true })[0].canned, undefined);
  assert.equal(mergeMessages([], [{ role: 'user', text: 'x', at, canned: true }]).find((m) => m.text === 'x')?.canned, undefined);
});
