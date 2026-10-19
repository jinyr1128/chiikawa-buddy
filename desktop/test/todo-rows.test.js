import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClickSorter, toggleOpen, dropTarget, autoScrollDelta, reorderLocal, isNoopMove, keyMove, detailView } from '../src/todo-rows.js';
import { overlayTodos } from '../src/todos.js';

function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    set: (fn, ms) => { const id = ++seq; q.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => q.delete(id),
    tick(ms) { now += ms; for (const [id, t] of [...q]) if (t.at <= now) { q.delete(id); t.fn(); } },
  };
}

test('createClickSorter: 한 번은 220ms 뒤 펼침, 그 안에 두 번이면 고치기만(펼침 없음), 다른 줄 누르면 앞의 한 번은 바로', () => {
  const T = fakeTimers();
  const log = [];
  const s = createClickSorter({ onSingle: (k) => log.push(['single', k]), onDouble: (k, x) => log.push(['double', k, x]), setTimer: T.set, clearTimer: T.clear });
  s.click('a', 10); T.tick(219);
  assert.deepEqual(log, []);
  T.tick(1);
  assert.deepEqual(log, [['single', 'a']]);
  log.length = 0;
  s.click('a', 10); T.tick(120); assert.equal(s.click('a', 12), 'double'); T.tick(500);
  assert.deepEqual(log, [['double', 'a', 12]], '더블클릭이면 펼침이 안 일어난다');
  log.length = 0;
  s.click('a'); T.tick(50); s.click('b'); T.tick(300);
  assert.deepEqual(log, [['single', 'a'], ['single', 'b']]);
  log.length = 0;
  s.click('c'); s.cancel(); T.tick(300);
  assert.deepEqual(log, [], '끌기 시작하면 취소');
  assert.equal(s.pending, null);
});

test('toggleOpen: 한 번에 하나, 같은 걸 다시 누르면 접힘', () => {
  assert.equal(toggleOpen(null, 'a'), 'a');
  assert.equal(toggleOpen('a', 'b'), 'b');
  assert.equal(toggleOpen('b', 'b'), null);
});

const groups = [
  { priority: 1, top: 100, bottom: 200, rows: [{ id: 'a', top: 130, bottom: 160 }, { id: 'b', top: 160, bottom: 190 }] },
  { priority: 2, top: 220, bottom: 300, rows: [{ id: 'c', top: 250, bottom: 280 }] },
  { priority: 3, top: 320, bottom: 380, rows: [] },
];

test('dropTarget: 줄 위쪽 절반이면 그 앞, 아래면 다음, 그룹 끝·빈 그룹·그룹 사이', () => {
  assert.deepEqual(dropTarget(135, groups, 'c'), { priority: 1, beforeId: 'a', y: 130 });
  assert.deepEqual(dropTarget(150, groups, 'c'), { priority: 1, beforeId: 'b', y: 160 });
  assert.deepEqual(dropTarget(195, groups, 'c'), { priority: 1, beforeId: null, y: 190 });
  assert.deepEqual(dropTarget(260, groups, 'a'), { priority: 2, beforeId: 'c', y: 250 });
  assert.deepEqual(dropTarget(350, groups, 'a'), { priority: 3, beforeId: null, y: 328 }); // 빈 칸
  assert.equal(dropTarget(210, groups, 'a').priority, 1, '사이 빈 곳은 가까운 그룹');
  assert.deepEqual(dropTarget(150, groups, 'a'), { priority: 1, beforeId: 'b', y: 160 }, '끄는 줄 자신은 뺀다');
  assert.equal(dropTarget(10, [], 'a'), null);
});

test('autoScrollDelta: 가장자리 가까울수록 빠르게, 가운데는 0', () => {
  const box = { top: 100, bottom: 600 };
  assert.equal(autoScrollDelta(350, box), 0);
  assert.ok(autoScrollDelta(105, box) < 0);
  assert.ok(autoScrollDelta(595, box) > 0);
  assert.ok(Math.abs(autoScrollDelta(101, box)) > Math.abs(autoScrollDelta(140, box)));
  assert.equal(autoScrollDelta(0, box), -16);
});

const list = [
  { id: 'a', priority: 1 }, { id: 'b', priority: 1 }, { id: 'c', priority: 2 }, { id: 'd', priority: 2 }, { id: 'x', priority: 9 },
];
const ids = (xs) => xs.map((t) => `${t.priority}${t.id}`).join(' ');

test('reorderLocal·overlayTodos reorder: 그룹 안·그룹 옮기기(직접 수정 표시)·끝·빈 그룹, 원본 그대로', () => {
  assert.equal(ids(reorderLocal(list, 'b', 1, 'a')), '1b 1a 2c 2d 9x');
  assert.equal(ids(reorderLocal(list, 'd', 1, 'b')), '1a 1d 1b 2c 9x');
  assert.equal(reorderLocal(list, 'd', 1, 'b').find((t) => t.id === 'd').userEdited, true);
  assert.equal(ids(reorderLocal(list, 'a', 2, null)), '1b 2c 2d 2a 9x');
  assert.equal(ids(reorderLocal(list, 'a', 3, null)), '1b 2c 2d 3a 9x', '빈 P3은 더 낮은 우선순위 앞에');
  assert.equal(reorderLocal(list, 'zz', 1, null), list);
  assert.equal(ids(list), '1a 1b 2c 2d 9x');
  const o = overlayTodos(list, [{ kind: 'reorder', id: 'c', priority: 1, beforeId: 'a' }]);
  assert.equal(ids(o), '1c 1a 1b 2d 9x');
  assert.equal(o[0].pending, true);
});

test('isNoopMove·keyMove: 제자리면 안 보냄, Alt+↑↓ 한 칸, Alt+1/2/3 그 우선순위 끝', () => {
  assert.equal(isNoopMove(list, 'a', 1, 'b'), true);
  assert.equal(isNoopMove(list, 'b', 1, null), true);
  assert.equal(isNoopMove(list, 'a', 1, null), false);
  assert.equal(isNoopMove(list, 'a', 2, null), false);
  assert.deepEqual(keyMove(list, 'b', 'ArrowUp'), { priority: 1, beforeId: 'a' });
  assert.equal(keyMove(list, 'a', 'ArrowUp'), null);
  assert.deepEqual(keyMove(list, 'c', 'ArrowDown'), { priority: 2, beforeId: null });
  assert.deepEqual(keyMove([...list, { id: 'e', priority: 2 }], 'c', 'ArrowDown'), { priority: 2, beforeId: 'e' });
  assert.equal(keyMove(list, 'd', 'ArrowDown'), null);
  assert.deepEqual(keyMove(list, 'a', '3'), { priority: 3, beforeId: null });
  assert.equal(keyMove(list, 'a', '1'), null);
  assert.equal(keyMove(list, 'zz', '1'), null);
  // 결과를 reorderLocal 에 넣으면 실제로 한 칸 움직인다
  const m = keyMove(list, 'a', 'ArrowDown');
  assert.equal(ids(reorderLocal(list, 'a', m.priority, m.beforeId)), '1b 1a 2c 2d 9x');
});

test('detailView: 종류별 원본 줄, 링크는 안전한 것만, 링크 없으면 원본 permalink', () => {
  const now = Date.parse('2026-10-08T12:00:00+09:00');
  const slack = detailView({ description: '팀원이 물어봄', link: null, source: { kind: 'slack', author: '팀원', channel: '#cy-agent', at: '2026-10-08T11:00:00+09:00', excerpt: '어디 저장돼요?', permalink: 'https://x.slack.com/archives/C1/p1' } }, now);
  assert.equal(slack.description, '팀원이 물어봄');
  assert.equal(slack.link, 'https://x.slack.com/archives/C1/p1');
  assert.deepEqual([slack.source.kindLabel, slack.source.meta, slack.source.quote, slack.source.excerpt], ['Slack', ['팀원', '#cy-agent', '10/8 11:00'], true, '어디 저장돼요?']);
  const commit = detailView({ description: 'x', link: 'javascript:alert(1)', source: { kind: 'commit', repo: '/code/cy-agent', sha: 'a1b2c3d4e5', author: '지우', at: '2026-10-06T12:00:00+09:00' } }, now);
  assert.equal(commit.link, null, '위험한 링크는 버림');
  assert.deepEqual(commit.source.meta, ['cy-agent', 'a1b2c3d', '지우', '10/6 12:00 (2일 전)']);
  const mail = detailView({ description: '', link: 'https://outlook.office.com/m', source: { kind: 'mail', ref: 'mail:AA', title: 'Re: 리뷰' } }, now);
  assert.deepEqual([mail.link, mail.source.meta, mail.source.quote], ['https://outlook.office.com/m', ['Re: 리뷰'], false]);
  assert.deepEqual(detailView(null), { description: '', link: null, source: null });
  assert.equal(detailView({ source: { kind: 'weird' } }).source.kindLabel, '기타');
});

test('직접 추가한 할 일의 원본 칸엔 안쪽 id 를 보이지 않는다', () => {
  const v = detailView({ source: { kind: 'user', ref: 'user:eb08ba75-1111-2222-3333-444455556666', at: new Date().toISOString() } });
  assert.equal(v.source.kindLabel, '직접 추가');
  assert.ok(!v.source.meta.join(' ').includes('eb08ba75'), v.source.meta.join(' '));
});
