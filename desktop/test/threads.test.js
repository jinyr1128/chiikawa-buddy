import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normThreads, upsertThread, groupThreads, filterThreads, initSeen, isUnread, markSeen, pruneSeen, unreadCount,
  pickInitial, neighborThread, afterRemoval, mergeMessages, appendLocal, tagLocal, dropLocal, dropFailed, todoChip, okThreadId,
} from '../src/threads.js';
import { initialChat, chatReducer, isBusy, latestStep, busyThreads } from '../src/chat.js';

// 기기 현지 시각으로 만든다(묶음은 현지 날짜 기준)
const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).toISOString();
const now = new Date(2026, 9, 12, 15); // 10월 12일 15시
const T = (id, updated, extra = {}) => ({ id, title: id, kind: 'chat', created: updated, updated, archived: false, count: 2, ...extra });

test('normThreads: 이상한 항목은 버리고, 최근 순·중복 없이, 모르는 kind 는 chat', () => {
  const list = normThreads([T('a', at(2026, 10, 1)), null, { id: '' }, T('b', at(2026, 10, 12), { kind: 'weird', title: '  ' }), T('a', at(2026, 9, 1))]);
  assert.deepEqual(list.map((t) => [t.id, t.kind, t.title]), [['b', 'chat', '새 대화'], ['a', 'chat', 'a']]);
  const up = upsertThread(list, T('a', at(2026, 10, 12, 16), { title: '새 제목' }));
  assert.deepEqual(up.map((t) => [t.id, t.title]), [['a', '새 제목'], ['b', '새 대화']]);
  assert.equal(upsertThread(list, { nope: 1 }), list);
});

test('groupThreads: 오늘/어제/이전 7일/그 이전, 빈 묶음은 뺀다', () => {
  const list = normThreads([
    T('today', at(2026, 10, 12, 0)), T('yday', at(2026, 10, 11, 23)), T('week', at(2026, 10, 5, 1)),
    T('old', at(2026, 10, 4, 23)), T('bad', 'not-a-date'),
  ]);
  assert.deepEqual(groupThreads(list, now).map((g) => [g.label, g.items.map((t) => t.id)]),
    [['오늘', ['today']], ['어제', ['yday']], ['이전 7일', ['week']], ['그 이전', ['bad', 'old']]]);
  assert.deepEqual(groupThreads([T('x', at(2026, 10, 12))], now).map((g) => g.key), ['today']);
  assert.deepEqual(groupThreads([], now), []);
});

test('filterThreads: 제목·마지막 말, 낱말 모두, 대소문자 무시', () => {
  const list = [T('a', 'x', { title: 'CY-12 접근성', preview: '대비 4.5' }), T('b', 'x', { title: '회의 정리', kind: 'hover' })];
  assert.deepEqual(filterThreads(list, 'cy-12').map((t) => t.id), ['a']);
  assert.deepEqual(filterThreads(list, '접근성 대비').map((t) => t.id), ['a']);
  assert.deepEqual(filterThreads(list, '캐릭터').map((t) => t.id), ['b']); // 종류 이름으로도
  assert.equal(filterThreads(list, '  '), list);
});

test('안 읽음: 처음엔 다 읽은 걸로, 백그라운드 답으로 updated 가 늘면 안 읽음, 보고 있는 건 아님', () => {
  const list = [T('a', at(2026, 10, 12, 10)), T('b', at(2026, 10, 12, 11))];
  let seen = initSeen(null, list);
  assert.equal(unreadCount(seen, list, null), 0);
  const later = [T('a', at(2026, 10, 12, 14)), list[1], T('hover-new', at(2026, 10, 12, 14))];
  assert.deepEqual(later.filter((t) => isUnread(seen, t, null)).map((t) => t.id), ['a', 'hover-new']);
  assert.equal(isUnread(seen, later[0], 'a'), false); // 열어 둔 대화
  seen = markSeen(seen, later[0]);
  assert.equal(markSeen(seen, later[0]), seen); // 같으면 그대로
  assert.equal(unreadCount(seen, later, null), 1);
  assert.deepEqual(Object.keys(pruneSeen(seen, [later[0]])), ['a']);
  assert.equal(pruneSeen(seen, []), seen);
  assert.deepEqual(initSeen({ a: 'x', bad: 3 }, list), { a: 'x' }); // 저장된 게 있으면 그것
});

test('선택: 기억한 스레드, ⌘↑/⌘↓ 이웃, 지운 뒤 옆 것', () => {
  const list = [T('a', '3'), T('b', '2'), T('c', '1')];
  assert.equal(pickInitial(list, 'b'), 'b');
  assert.equal(pickInitial(list, 'gone'), null);
  assert.equal(pickInitial(list, null), null);
  const order = ['a', 'b', 'c'];
  assert.equal(neighborThread(order, 'a', 1), 'b');
  assert.equal(neighborThread(order, 'a', -1), 'a');
  assert.equal(neighborThread(order, 'c', 1), 'c');
  assert.equal(neighborThread(order, null, 1), 'a');
  assert.equal(neighborThread(order, null, -1), null);
  assert.equal(neighborThread([], null, 1), null);
  assert.equal(afterRemoval(order, 'b'), 'c');
  assert.equal(afterRemoval(order, 'c'), 'b');
  assert.equal(afterRemoval(['a'], 'a'), null);
  assert.equal(afterRemoval(order, 'x'), null);
});

test('말 합치기: 서버 기록으로 교체, 아직 안 들어간 내 말·실패한 말은 남기고, 위로 더 불러온 건 앞에', () => {
  let m = appendLocal([], { role: 'user', text: '안녕', at: 't1' });
  assert.deepEqual(m, [{ role: 'user', text: '안녕', at: 't1', local: true }]);
  m = appendLocal(m, { role: 'user', text: '실패', at: 't2', error: true });
  // 서버에 아직 '안녕'이 없음 → 남김
  m = mergeMessages(m, [{ n: 1, role: 'user', text: '예전', at: 't0' }]);
  assert.deepEqual(m.map((x) => x.text), ['예전', '안녕', '실패']);
  // 서버에 들어감 → 로컬 사본은 빠진다. 시스템 줄도 받는다
  m = mergeMessages(m, [{ n: 1, role: 'user', text: '예전', at: 't0' }, { n: 2, role: 'user', text: '안녕', at: 't1' }, { n: 3, role: 'assistant', text: '네', at: 't3' }, { n: 4, role: 'system', text: '✓ 삭제: X', at: 't3' }, { role: 'bogus', text: 'x' }]);
  assert.deepEqual(m.map((x) => [x.n ?? null, x.role, x.text]), [[1, 'user', '예전'], [2, 'user', '안녕'], [3, 'assistant', '네'], [4, 'system', '✓ 삭제: X'], [null, 'user', '실패']]);
  // 위로 더
  const older = mergeMessages(m, [{ n: 0, role: 'user', text: '처음', at: 't' }, { n: 1, role: 'user', text: '예전', at: 't0' }], { older: true });
  assert.deepEqual(older.slice(0, 2).map((x) => x.text), ['처음', '예전']);
  // 그 뒤 최신 쪽을 다시 받아도 위로 불러온 옛말은 유지
  const again = mergeMessages(older, [{ n: 3, role: 'assistant', text: '네', at: 't3' }, { n: 4, role: 'system', text: '✓ 삭제: X', at: 't3' }]);
  assert.deepEqual(again.map((x) => x.n ?? null), [0, 1, 2, 3, 4, null]);
});

test('할 일 칩: 할 일이 있으면 링크, 없으면 흐리게(제목은 스레드 이름에서)', () => {
  const th = T('t', 'x', { kind: 'todo', todoId: 'mail:1', title: '할 일: 견적 회신' });
  assert.deepEqual(todoChip(th, [{ id: 'mail:1', title: '견적 회신(급함)', status: 'open' }]), { id: 'mail:1', title: '견적 회신(급함)', open: true });
  assert.deepEqual(todoChip(th, []), { id: 'mail:1', title: '견적 회신', gone: true });
  assert.deepEqual(todoChip(th, [], [{ id: 'mail:1', title: '견적 회신' }]), { id: 'mail:1', title: '견적 회신', done: true });
  assert.deepEqual(todoChip(th, [{ id: 'mail:1', title: 'x', status: 'done' }]), { id: 'mail:1', title: 'x', done: true });
  assert.equal(todoChip(T('c', 'x'), []), null);
  assert.equal(todoChip(null, []), null);
});

test('okThreadId', () => {
  for (const ok of ['legacy', '0b7c1c1e-1111-4222-8333-944445555666']) assert.ok(okThreadId(ok));
  for (const bad of ['', '../x', 'a/b', 3, null, 'x'.repeat(65)]) assert.ok(!okThreadId(bad), String(bad));
});

test('채팅 진행: 스레드별 바쁨·단계, accepted·이벤트의 threadId, 끝난 답에 threadId', () => {
  let s = initialChat();
  s = chatReducer(s, { type: 'event', ev: { chatId: 'c1', threadId: 'A', status: 'thinking' } });
  s = chatReducer(s, { type: 'accepted', chatId: 'c2', threadId: 'B' });
  s = chatReducer(s, { type: 'event', ev: { chatId: 'c2', status: 'step', step: 'git.log' } }); // threadId 빠져도 유지
  assert.ok(isBusy(s, 'A') && isBusy(s, 'B') && !isBusy(s, 'C') && isBusy(s));
  assert.equal(latestStep(s, 'B'), 'git.log');
  assert.equal(latestStep(s, 'A'), null);
  assert.deepEqual([...busyThreads(s)].sort(), ['A', 'B']);
  s = chatReducer(s, { type: 'event', ev: { chatId: 'c2', threadId: 'B', status: 'done', text: '끝' } });
  assert.ok(!isBusy(s, 'B'));
  assert.deepEqual(s.replies, [{ chatId: 'c2', text: '끝', show: null, error: false, threadId: 'B' }]);
});

test('코드 읽기 단계 이름', async () => {
  const { stepLabel } = await import('../src/chat.js');
  assert.equal(stepLabel('code.Read README.md'), '코드 · Read README.md');
  assert.equal(stepLabel('code.Grep TODO'), '코드 · Grep TODO');
});

test('내 말에 chatId 붙이기(tagLocal)·대기 중 취소로 빼기(dropLocal)·같은 글을 또 보내도 헷갈리지 않는 합치기', () => {
  const t1 = at(2026, 10, 12, 17), t2 = at(2026, 10, 12, 18);
  let m = mergeMessages([], [{ n: 1, role: 'user', text: '응', at: t1 }, { n: 2, role: 'assistant', text: '네', at: t1 }]);
  m = appendLocal(m, { role: 'user', text: '응', at: t2 });
  m = appendLocal(m, { role: 'user', text: '그리고', at: t2 });
  m = tagLocal(m, { text: '응', at: t2 }, 'c1');
  m = tagLocal(m, { text: '그리고', at: t2 }, 'c2');
  assert.deepEqual(m.filter((x) => x.local).map((x) => [x.text, x.chatId]), [['응', 'c1'], ['그리고', 'c2']]);
  assert.equal(tagLocal(m, { text: '응', at: t2 }, 'c9').find((x) => x.chatId === 'c9'), undefined, '이미 붙었으면 다시 안 붙인다');
  // 예전에 한 "응"(t1)이 서버에 있어도, 아직 안 들어간 새 "응"(t2, 대기 중)은 남는다
  m = mergeMessages(m, [{ n: 1, role: 'user', text: '응', at: t1 }, { n: 2, role: 'assistant', text: '네', at: t1 }]);
  assert.deepEqual(m.map((x) => [x.n ?? null, x.text, x.chatId ?? null]), [[1, '응', null], [2, '네', null], [null, '응', 'c1'], [null, '그리고', 'c2']]);
  // 대기 중인 "그리고"를 취소 → 빠지고, 뺀 말을 돌려준다
  const r = dropLocal(m, 'c2');
  assert.equal(r.dropped.text, '그리고');
  assert.deepEqual(r.messages.map((x) => x.text), ['응', '네', '응']);
  assert.equal(dropLocal(m, 'nope').messages, m);
  assert.equal(dropLocal(m, 'nope').dropped, null);
  // 새 "응"이 서버에 들어가면 로컬 사본이 빠진다
  const after = mergeMessages(r.messages, [{ n: 1, role: 'user', text: '응', at: t1 }, { n: 2, role: 'assistant', text: '네', at: t1 }, { n: 3, role: 'user', text: '응', at: at(2026, 10, 12, 19) }]);
  assert.deepEqual(after.map((x) => x.n ?? null), [1, 2, 3]);
});

test('다시 보내서 받아들여지면 앞서 못 보낸 말·「못 보냈어요」 줄은 걷힌다(dropFailed)', () => {
  let m = mergeMessages([], [{ n: 1, role: 'user', text: '예전', at: 't0' }]);
  m = appendLocal(m, { role: 'user', text: '실패1', at: 't1', error: true });
  m = appendLocal(m, { role: 'assistant', text: '못 보냈어요: 첨부 파일을 찾지 못했어요', at: 't1', error: true });
  m = appendLocal(m, { role: 'user', text: '실패2', at: 't2', error: true });
  m = appendLocal(m, { role: 'assistant', text: '에이전트에 연결되지 않아서 못 보냈어요.', at: 't2', error: true });
  m = appendLocal(m, { role: 'user', text: '새 말', at: 't3', clientId: 'c3' });
  m = dropFailed(tagLocal(m, { text: '새 말', at: 't3', clientId: 'c3' }, 'chat-3'));
  assert.deepEqual(m.map((x) => x.text), ['예전', '새 말']);
  assert.equal(m[1].chatId, 'chat-3');
  const clean = [{ role: 'user', text: 'a', at: 't' }];
  assert.equal(dropFailed(clean), clean); // 걷을 게 없으면 그대로
});
