import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysAgo, trashModel, commitTrash, trashItemOf, todoBodyOf, confirmReducer, isConfirming, confirmKey, isTrashKey,
  createUndo, readTrashOpen, writeTrashOpen, overTrash, okTodoId, UNDO_MS, TRASH_OPEN_KEY,
} from '../src/todo-trash.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const iso = (daysBack) => new Date(NOW - daysBack * 864e5).toISOString();

test('daysAgo: 오늘·어제·n일 전, 이상한 값은 빈 문자열', () => {
  assert.equal(daysAgo(iso(0.2), NOW), '오늘');
  assert.equal(daysAgo(iso(1.5), NOW), '어제');
  assert.equal(daysAgo(iso(5), NOW), '5일 전');
  assert.equal(daysAgo(new Date(NOW + 60e3).toISOString(), NOW), '오늘'); // 시계 어긋남
  assert.equal(daysAgo('nope', NOW), '');
  assert.equal(daysAgo(undefined, NOW), '');
});

test('trashModel: 서버 목록을 다듬고(원래 우선순위 칩·n일 전), 이상한 항목은 버린다', () => {
  const m = trashModel([
    { id: 'a', title: 'A', priority: 1, source: 'mail', trashedAt: iso(0.1) },
    { id: 'b', title: 'B', priority: 4, source: 'slack', trashedAt: iso(3) },
    { id: '', title: 'x' }, null, { id: 'c' },
  ], 2, [], NOW);
  assert.equal(m.count, 2);
  assert.deepEqual(m.items.map((t) => [t.id, t.priorityLabel, t.ago]), [['a', '오늘 꼭', '오늘'], ['b', '언젠가', '3일 전']]);
  assert.equal(trashModel(null, undefined, [], NOW).count, 0);
  assert.equal(trashModel([{ id: 'a', title: 'A' }], 0, [], NOW).count, 1); // count가 목록보다 작으면 목록 기준
  assert.equal(trashModel([{ id: 'a', title: 'A' }], 70, [], NOW).count, 70); // 50개 넘게 있으면 전체 수
});

test('trashModel: 응답 대기 중인 휴지통으로·되살리기·영구 삭제·비우기를 겹친다', () => {
  const server = [{ id: 'a', title: 'A', priority: 2, source: 'x', trashedAt: iso(2) }];
  const t = trashModel(server, 1, [{ kind: 'trash', item: { id: 'n', title: 'N', priority: 1, source: 'mail' } }], NOW);
  assert.deepEqual(t.items.map((x) => x.id), ['n', 'a']);
  assert.equal(t.items[0].ago, '오늘');
  assert.equal(t.count, 2);
  // 서버에 이미 반영된 trash 는 두 번 세지 않는다
  assert.equal(trashModel(server, 1, [{ kind: 'trash', item: { id: 'a', title: 'A' } }], NOW).count, 1);
  assert.deepEqual(trashModel(server, 1, [{ kind: 'restore', id: 'a' }], NOW), { items: [], count: 0 });
  assert.deepEqual(trashModel(server, 1, [{ kind: 'purge', id: 'a' }], NOW), { items: [], count: 0 });
  assert.equal(trashModel(server, 1, [{ kind: 'purge', id: 'zz' }], NOW).count, 1); // 없는 것은 그대로
  assert.deepEqual(trashModel(server, 9, [{ kind: 'empty' }], NOW), { items: [], count: 0 });
  // 50개까지만
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, trashedAt: iso(i) }));
  const m = trashModel(many, 60, [], NOW);
  assert.equal(m.items.length, 50);
  assert.equal(m.count, 60);
});

test('commitTrash: raw(/dashboard)에 바로 반영 — 서버 모양 유지', () => {
  const raw = { todos: [], trash: [{ id: 'a', title: 'A', priority: 2, source: 'x', trashedAt: iso(1) }], trashCount: 1 };
  const r1 = commitTrash(raw, { kind: 'trash', item: { id: 'n', title: 'N', priority: 1, source: 'mail' } }, NOW);
  assert.equal(r1.trashCount, 2);
  assert.deepEqual(r1.trash[0], { id: 'n', title: 'N', priority: 1, source: 'mail', trashedAt: new Date(NOW).toISOString() });
  assert.equal(r1.trash[1], raw.trash[0]);
  assert.deepEqual(r1.todos, []);
  const r2 = commitTrash(r1, { kind: 'restore', id: 'n' }, NOW);
  assert.deepEqual(r2.trash.map((x) => x.id), ['a']);
  assert.equal(commitTrash(r2, { kind: 'empty' }, NOW).trashCount, 0);
  assert.equal(commitTrash(null, { kind: 'empty' }, NOW).trashCount, 0);
});

test('trashItemOf·todoBodyOf: 줄 → 휴지통 항목 / 되돌리기용 원래 모양', () => {
  const row = { id: 'm', title: '답장', source: 'mail', priority: 1, linkRaw: 'https://x', note: '메모', userEdited: true, pending: false };
  assert.deepEqual(trashItemOf(row), { id: 'm', title: '답장', priority: 1, source: 'mail' });
  assert.deepEqual(todoBodyOf(row), { id: 'm', title: '답장', source: 'mail', priority: 1, link: 'https://x', note: '메모', userEdited: true });
  assert.deepEqual(todoBodyOf({ id: 'b', title: 'B', source: '', priority: 2, linkRaw: '', note: '', userEdited: false }), { id: 'b', title: 'B', source: '', priority: 2, userEdited: false });
});

test('confirmReducer: 한 번에 하나만, 취소·확정·대상 사라짐', () => {
  let s = confirmReducer(null, { type: 'ask', kind: 'trash', id: 'a' });
  assert.deepEqual(s, { kind: 'trash', id: 'a' });
  assert.equal(isConfirming(s, 'trash', 'a'), true);
  assert.equal(isConfirming(s, 'trash', 'b'), false);
  assert.equal(isConfirming(s, 'purge', 'a'), false);
  s = confirmReducer(s, { type: 'ask', kind: 'purge', id: 'b' }); // 다른 확인을 열면 앞의 것은 닫힘
  assert.deepEqual(s, { kind: 'purge', id: 'b' });
  assert.equal(confirmReducer(s, { type: 'gone', ids: ['b'] }), s);
  assert.equal(confirmReducer(s, { type: 'gone', ids: ['x'] }), null);
  assert.deepEqual(confirmReducer(null, { type: 'ask', kind: 'empty' }), { kind: 'empty' });
  assert.equal(isConfirming({ kind: 'empty' }, 'empty'), true);
  assert.equal(confirmReducer({ kind: 'empty' }, { type: 'gone', ids: [] })?.kind, 'empty');
  assert.equal(confirmReducer(s, { type: 'cancel' }), null);
  assert.equal(confirmReducer(s, { type: 'done' }), null);
  assert.equal(confirmReducer(null, { type: 'ask', kind: 'trash' }), null); // id 없음
  assert.equal(confirmReducer(null, { type: 'ask', kind: 'nuke', id: 'a' }), null);
  assert.equal(confirmReducer(s, { type: 'weird' }), s);
});

test('confirmKey·isTrashKey: Enter 확인·Esc 취소, 조합 중 무시 / Delete·Backspace(수식키 없이)', () => {
  assert.equal(confirmKey({ key: 'Enter' }), 'confirm');
  assert.equal(confirmKey({ key: 'Escape' }), 'cancel');
  assert.equal(confirmKey({ key: 'Enter', isComposing: true }), null);
  assert.equal(confirmKey({ key: 'Enter', keyCode: 229 }), null);
  assert.equal(confirmKey({ key: 'Enter', shiftKey: true }), null);
  assert.equal(confirmKey({ key: 'a' }), null);
  assert.equal(confirmKey(null), null);
  assert.equal(isTrashKey({ key: 'Delete' }), true);
  assert.equal(isTrashKey({ key: 'Backspace' }), true);
  assert.equal(isTrashKey({ key: 'Backspace', metaKey: true }), false);
  assert.equal(isTrashKey({ key: 'Delete', altKey: true }), false);
  assert.equal(isTrashKey({ key: 'Backspace', isComposing: true }), false);
  assert.equal(isTrashKey({ key: 'x' }), false);
});

function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); } },
    get size() { return timers.size; },
  };
}

test('createUndo: 5초 창 — 그 안에 누르면 그 항목을 한 번만, 지나면 닫힘, 새로 옮기면 바뀜', () => {
  const c = fakeClock();
  const seen = [];
  const u = createUndo({ onChange: (x) => seen.push(x?.id ?? null), setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  assert.equal(UNDO_MS, 5000);
  u.show({ id: 'a', title: 'A' });
  assert.equal(u.current.id, 'a');
  c.advance(4999);
  assert.equal(u.take('zz'), null); // 다른 id
  assert.deepEqual(u.take('a'), { id: 'a', title: 'A' });
  assert.equal(u.take('a'), null); // 한 번만
  assert.equal(u.current, null);
  assert.equal(c.size, 0);

  u.show({ id: 'b', title: 'B' });
  c.advance(5000);
  assert.equal(u.current, null);
  assert.equal(u.take(), null);

  u.show({ id: 'c', title: 'C' });
  c.advance(3000);
  u.show({ id: 'd', title: 'D' }); // 새로 옮김 → 창 새로(앞의 타이머는 치움)
  c.advance(3000);
  assert.equal(u.current.id, 'd');
  assert.equal(u.take().id, 'd');
  u.show({ id: 'e', title: 'E' });
  u.close();
  assert.equal(u.current, null);
  assert.deepEqual(seen, ['a', null, 'b', null, 'c', 'd', null, 'e', null]);
});

test('휴지통 펼침 기억(기본 접힘), 저장소 오류도 견딘다', () => {
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(readTrashOpen(st), false);
  writeTrashOpen(st, true);
  assert.equal(m.get(TRASH_OPEN_KEY), '1');
  assert.equal(readTrashOpen(st), true);
  writeTrashOpen(st, false);
  assert.equal(readTrashOpen(st), false);
  const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(readTrashOpen(bad), false);
  writeTrashOpen(bad, true);
  assert.equal(readTrashOpen(undefined), false);
});

test('overTrash·okTodoId', () => {
  const r = { top: 100, bottom: 160, left: 10, right: 300 };
  assert.equal(overTrash(50, 120, r), true);
  assert.equal(overTrash(null, 120, r), true);
  assert.equal(overTrash(5, 120, r), false);
  assert.equal(overTrash(50, 99, r), false);
  assert.equal(overTrash(50, 120, null), false);
  assert.equal(okTodoId('mail:1'), true);
  assert.equal(okTodoId(''), false);
  assert.equal(okTodoId(3), false);
  assert.equal(okTodoId('x'.repeat(501)), false);
});
