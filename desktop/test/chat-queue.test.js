// 줄 선 말(대기 중)·보냄 상태와 낙관적 사본 짝 맞추기 — 「바로 보낸 걸로 보였는데 사실은 줄 서 있던」 것·같은 말이 두 번 그려지던 것
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialChat, chatReducer, localState, queuedChats, queuedLabel, sentLabel, isRunning, busyLabel, busyCaption, heldIds, runningThreads } from '../src/chat.js';
import { appendLocal, tagLocal, mergeMessages, markSent, isDoubleSend, dropLocal } from '../src/threads.js';

const run = (actions, s = initialChat()) => actions.reduce(chatReducer, s);
const ev = (o) => ({ type: 'event', ev: o });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('대기 중: POST 응답(accepted)이 SSE queued 보다 먼저 와도 대기 중 — 예전엔 「돌고 있음」으로 굳어 보낸 것처럼 보였다', () => {
  let s = run([ev({ chatId: A, threadId: 't', status: 'thinking' })]);
  // 응답이 먼저(queued 정보 없는 옛 데몬): 아직 모름 → 「보내는 중」, 이어 온 queued 는 받아들인다
  s = run([{ type: 'accepted', chatId: B, threadId: 't' }], s);
  assert.equal(localState(s, B), 'sending');
  s = run([ev({ chatId: B, threadId: 't', status: 'queued', position: 1, text: '둘째', queuedAt: '2026-10-12T12:52:00.000Z', ahead: { chatId: A, threadId: 't', text: '코드점검 서브에이전트로 한 번 굴리고 다시 물어' } })], s);
  assert.equal(localState(s, B), 'queued');
  // 새 데몬: 응답에 queued 가 있으면 SSE 를 기다리지 않고 바로 대기 중
  s = run([{ type: 'accepted', chatId: C, threadId: 't', queued: true, position: 2, text: '셋째', clientId: 'k3' }], s);
  assert.equal(localState(s, C), 'queued');
  assert.deepEqual(queuedChats(s, 't').map((p) => [p.chatId, p.position, p.text]), [[B, 1, '둘째'], [C, 2, '셋째']]);
  assert.deepEqual(queuedChats(s, 'other'), []);
  // thinking 이 오면 보냄(sentAt), 그 뒤 늦게 온 queued 는 무시
  s = run([ev({ chatId: B, threadId: 't', status: 'thinking', sentAt: '2026-10-12T12:54:58.000Z', queuedAt: '2026-10-12T12:52:00.000Z' })], s);
  assert.equal(localState(s, B), 'running');
  assert.equal(s.pending[B].sentAt, '2026-10-12T12:54:58.000Z');
  assert.equal(s.pending[B].position, undefined);
  assert.equal(chatReducer(s, ev({ chatId: B, status: 'queued', position: 1 })), s);
  assert.ok(isRunning(s, 't'));
});

test('대기 중 상태 줄: 차례(그 대화 안에서 2번째부터)·이 대화의 앞 답(다른 대화는 동시에 답하니 기다리지 않는다)', () => {
  const ahead = { chatId: A, threadId: 't', text: 'PR #271 코드 점검' };
  assert.deepEqual(queuedLabel({ position: 1, ahead }), { status: '대기 중', wait: '앞 답(“PR #271 코드 점검”)이 끝나면 보내요' });
  assert.deepEqual(queuedLabel({ position: 3, ahead }), { status: '대기 중 · 3번째', wait: '앞 답(“PR #271 코드 점검”)이 끝나면 보내요 — 앞에 2개 더 있어요' });
  assert.equal(queuedLabel({}).wait, '앞 답이 끝나면 보내요');
});

const REASON = '앞 대화(“버튼 색 바꿔줘”)가 같은 레포(app)를 고치는 중이라 기다려요';

test('동시 답: 두 대화가 함께 답하면 캡션은 「대화 2개 답하는 중」, 하나면 그 단계', () => {
  let s = run([
    ev({ chatId: A, threadId: 't', status: 'thinking', sentAt: '2026-10-12T12:00:00.000Z' }),
    ev({ chatId: A, threadId: 't', status: 'step', step: 'slack.slack_search_messages' }),
  ]);
  assert.equal(busyCaption(s), 'Slack · search messages');
  s = run([ev({ chatId: B, threadId: 'u', status: 'thinking', sentAt: '2026-10-12T12:00:01.000Z' })], s);
  assert.equal(runningThreads(s), 2);
  assert.equal(busyCaption(s), '대화 2개 답하는 중');
  // 같은 대화에 줄 선 말은 「메시지 N개 대기 중」
  s = run([ev({ chatId: C, threadId: 't', status: 'queued', position: 1, queuedAt: '2026-10-12T12:00:02.000Z', text: '다음', waitFor: 'thread', reason: '앞 답이 끝나면 보내요' })], s);
  assert.equal(busyCaption(s), '대화 2개 답하는 중 · 메시지 1개 대기 중');
});

test('레포 잠금 대기: 돌던 답이 queued(waitFor repo)를 받으면 running 그대로 이유를 보이고, thinking 이 다시 오면 걷는다', () => {
  let s = run([
    { type: 'accepted', chatId: B, threadId: 'u', queued: false },
    ev({ chatId: B, threadId: 'u', status: 'thinking', sentAt: '2026-10-12T12:00:01.000Z' }),
    ev({ chatId: B, threadId: 'u', status: 'queued', waitFor: 'repo', repo: 'app', reason: REASON, position: 1, queuedAt: '2026-10-12T12:00:03.000Z', ahead: { chatId: A, threadId: 't', text: '버튼 색 바꿔줘' } }),
  ]);
  assert.equal(localState(s, B), 'running'); // 이미 보낸 말 — 줄 선 풍선으로 다시 그리지 않는다
  assert.deepEqual(queuedChats(s, 'u'), []);
  assert.deepEqual(heldIds(s, 'u'), [B]);
  assert.equal(busyLabel(s, 'u'), REASON);
  assert.equal(busyCaption(s), `${REASON} · 메시지 1개 대기 중`);
  assert.equal(s.pending[B].sentAt, '2026-10-12T12:00:01.000Z');
  s = run([ev({ chatId: B, threadId: 'u', status: 'thinking', sentAt: '2026-10-12T12:00:01.000Z' })], s);
  assert.deepEqual(heldIds(s), []);
  assert.equal(busyLabel(s, 'u'), '생각 중…');
  // 이유 글이 없으면 무시
  assert.equal(chatReducer(s, ev({ chatId: B, status: 'queued', waitFor: 'repo' })), s);
});

test('GET /chat/queue: running[].held 로 레포 잠금 대기를 되살린다(패널을 다시 열어도)', () => {
  const s = run([{ type: 'queue', queue: [], running: [
    { chatId: A, threadId: 't', text: '버튼 색 바꿔줘', sentAt: '2026-10-12T12:00:00.000Z' },
    { chatId: B, threadId: 'u', text: 'README 고쳐줘', sentAt: '2026-10-12T12:00:01.000Z', held: { repo: 'app', reason: REASON, since: '2026-10-12T12:00:03.000Z', position: 1 } },
  ] }]);
  assert.ok(isRunning(s, 'u'));
  assert.deepEqual(s.pending[B].held, { reason: REASON, repo: 'app' });
  assert.equal(s.pending[A].held, undefined);
  assert.equal(busyLabel(s, 'u'), REASON);
});

test('보냄 상태 줄: 바로 보냈으면 「보냄」, 줄 섰다 갔으면 얼마나 기다렸는지와 두 시각', () => {
  assert.equal(sentLabel(undefined, '2026-10-12T12:55:00.000Z').status, '보냄');
  assert.equal(sentLabel('2026-10-12T12:55:00.000Z', '2026-10-12T12:55:01.000Z').status, '보냄');
  const l = sentLabel('2026-10-12T12:52:00.000Z', '2026-10-12T12:54:58.000Z');
  assert.equal(l.status, '대기 3분 뒤 보냄');
  assert.match(l.title, /줄 서서.*보냈어요/);
  assert.equal(sentLabel('2026-10-12T12:52:00.000Z', '2026-10-12T12:52:20.000Z').status, '대기 20초 뒤 보냄');
});

test('GET /chat/queue 로 되살리기: 패널을 다시 열어도 대기 중·보내는 중이 그대로(로컬 사본 없이)', () => {
  const s = run([{ type: 'queue',
    running: [{ chatId: A, threadId: 't', text: '첫째', sentAt: '2026-10-12T12:51:34.000Z' }],
    queue: [{ chatId: B, threadId: 't', text: '둘째', queuedAt: '2026-10-12T12:52:00.000Z', position: 1, clientId: 'k2', ahead: { chatId: A, threadId: 't', text: '첫째' } }, { chatId: 'bad' }, null],
  }]);
  assert.equal(localState(s, A), 'running');
  assert.equal(localState(s, B), 'queued');
  assert.deepEqual(queuedChats(s, 't').map((p) => [p.chatId, p.text, p.clientId]), [[B, '둘째', 'k2']]);
  assert.equal(queuedChats(s, 't')[0].ahead.text, '첫째');
  // 이미 끝난 건 되살리지 않는다
  const done = run([ev({ chatId: C, threadId: 't', status: 'done', text: '끝' }), { type: 'queue', running: [], queue: [{ chatId: C, threadId: 't', text: 'x', position: 1 }] }]);
  assert.equal(done.pending[C], undefined);
});

test('짝 맞추기: 서버 기록에 같은 clientId 가 오면 로컬 사본을 걷는다 — 같은 글을 두 번 보내도 하나씩', () => {
  let m = appendLocal([], { role: 'user', text: '엥? 1이 아니라?', at: '2026-10-12T12:52:00.000Z', clientId: 'k1' });
  m = appendLocal(m, { role: 'user', text: '엥? 1이 아니라?', at: '2026-10-12T12:52:30.000Z', clientId: 'k2' });
  m = tagLocal(m, { text: 'x', at: 'y', clientId: 'k2' }, B);
  assert.equal(m[1].chatId, B);
  assert.equal(m[0].chatId, undefined);
  // 첫 번째만 서버에 기록됨 → 두 번째 로컬 사본은 남는다(글이 같아도)
  const merged = mergeMessages(m, [{ n: 165, role: 'user', text: '엥? 1이 아니라?', at: '2026-10-12T12:54:58.115Z', clientId: 'k1', queuedAt: '2026-10-12T12:52:00.000Z' }]);
  assert.deepEqual(merged.map((x) => [x.n ?? 'local', x.clientId]), [[165, 'k1'], ['local', 'k2']]);
  assert.equal(merged[0].queuedAt, '2026-10-12T12:52:00.000Z');
  // 둘 다 기록되면 로컬 사본은 없다 — 같은 말이 두 번 그려지지 않는다
  const both = mergeMessages(merged, [
    { n: 165, role: 'user', text: '엥? 1이 아니라?', at: '2026-10-12T12:54:58.115Z', clientId: 'k1' },
    { n: 167, role: 'user', text: '엥? 1이 아니라?', at: '2026-10-12T12:55:16.520Z', clientId: 'k2' },
  ]);
  assert.deepEqual(both.map((x) => x.n), [165, 167]);
  // clientId 없는 옛 기록은 예전처럼 글·시각으로
  const old = mergeMessages(appendLocal([], { role: 'user', text: '안녕', at: '2026-10-12T12:00:00.000Z' }), [{ n: 1, role: 'user', text: '안녕', at: '2026-10-12T12:00:01.000Z' }]);
  assert.equal(old.length, 1);
});

test('줄 섰던 말이 모델에 감(markSent): 같은 풍선을 맨 아래로 옮기고 보낸 시각을 붙인다 — 새 풍선 없음', () => {
  let m = appendLocal([], { role: 'user', text: '둘째', at: '2026-10-12T12:52:00.000Z', clientId: 'k2', chatId: B });
  m = [...m, { role: 'assistant', text: '첫째 답', at: '2026-10-12T12:54:58.000Z', n: 10 }];
  const next = markSent(m, { chatId: B, queuedAt: '2026-10-12T12:52:00.000Z', sentAt: '2026-10-12T12:54:58.100Z' });
  assert.equal(next.length, 2);
  assert.equal(next[1].text, '둘째');
  assert.equal(next[1].at, '2026-10-12T12:54:58.100Z');
  assert.equal(next[1].queuedAt, '2026-10-12T12:52:00.000Z');
  // 로컬 사본이 없으면(패널을 다시 연 뒤) 데몬 큐의 글로 하나 만든다
  const fresh = markSent([], { chatId: C, clientId: 'k3', text: '셋째', queuedAt: '2026-10-12T12:52:00.000Z', sentAt: '2026-10-12T12:55:00.000Z' });
  assert.deepEqual(fresh.map((x) => [x.text, x.chatId, x.local]), [['셋째', C, true]]);
  assert.deepEqual(markSent([], { chatId: C }), []);
  // 취소(dropLocal)는 chatId 로 그 사본만
  assert.equal(dropLocal(next, B).messages.length, 1);
});

test('같은 말 두 번 보내기 막기: 같은 글의 로컬 사본이 3초 안에 있으면', () => {
  const now = Date.parse('2026-10-12T12:52:01.000Z');
  const m = appendLocal([], { role: 'user', text: '엥?', at: '2026-10-12T12:52:00.000Z', clientId: 'k1' });
  assert.equal(isDoubleSend(m, '엥?', now), true);
  assert.equal(isDoubleSend(m, '다른 말', now), false);
  assert.equal(isDoubleSend(m, '엥?', now + 5000), false);
  assert.equal(isDoubleSend([{ ...m[0], error: true }], '엥?', now), false);
});
