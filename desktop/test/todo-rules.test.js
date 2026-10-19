import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeRules, rulesChip, overlayRules, hitsLabel, readBacklogOpen, writeBacklogOpen, isCollapsed, BACKLOG_KEY,
  sanitizeRulePatch, okRuleId,
} from '../src/todo-rules.js';
import { groupTodos, shapeDashboard, priorityLabel } from '../src/dashboard.js';
import { dropTarget, keyMove, reorderLocal } from '../src/todo-rows.js';
import { clampPriority, sanitizeTodoPatch, PRIORITIES } from '../src/todos.js';

const RULES = [
  { id: 'rule:a', text: '앞으로 뉴스레터는 백로그로', summary: '제목에 "뉴스레터" → 언젠가·백로그(P4)', enabled: true, hits: 2, created: '2026-10-01T00:00:00Z' },
  { id: 'rule:b', text: '세미나는 백로그', summary: '', enabled: false, hits: 0, created: '2026-10-08T00:00:00Z' },
  { id: '', text: '깨진 것' }, null, { id: 'rule:c' },
];

test('shapeRules·rulesChip·overlayRules: 최근 것 먼저, 깨진 건 빼고, 꺼진 건 칩 수에서 뺀다', () => {
  const rs = shapeRules(RULES);
  assert.deepEqual(rs.map((r) => r.id), ['rule:b', 'rule:a']);
  assert.equal(rulesChip(rs), '규칙 1/2');
  assert.equal(rulesChip(rs.filter((r) => r.enabled)), '규칙 1');
  assert.equal(rulesChip([]), '규칙 0');
  assert.deepEqual(shapeRules(null), []);
  const pend = new Map([['rule:a', 'delete'], ['rule:b', { enabled: true }]]);
  assert.deepEqual(overlayRules(rs, pend).map((r) => [r.id, r.enabled]), [['rule:b', true]]);
  assert.equal(overlayRules(rs, new Map()), rs);
  assert.equal(hitsLabel(0), '미적용');
  assert.equal(hitsLabel(3), '3번 적용');
});

test('백로그 접힘: 기본 접힘, 저장소에 기억, 저장소가 없거나 깨져도 안전', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readBacklogOpen(storage), false);
  writeBacklogOpen(storage, true);
  assert.equal(mem.get(BACKLOG_KEY), '1');
  assert.equal(readBacklogOpen(storage), true);
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.equal(readBacklogOpen(broken), false);
  writeBacklogOpen(broken, true);
  assert.equal(readBacklogOpen(undefined), false);
  assert.equal(isCollapsed(4, false), true);
  assert.equal(isCollapsed(4, true), false);
  assert.equal(isCollapsed(3, false), false);
});

test('P4 묶음 모델: 네 번째 묶음 "백로그", 열린 수·P1 수에서 빠지고 따로 셈, 규칙 표시', () => {
  const vm = shapeDashboard({
    todos: [
      { id: 'a', title: 'P1', priority: 1 }, { id: 'b', title: '나중', priority: 4, appliedRule: { id: 'rule:a', text: '뉴스레터는 백로그' } },
      { id: 'c', title: 'P3', priority: 3, progress: 'PR 올림 · 리뷰 대기', progressAt: '2026-10-13T06:00:00Z' }, { id: 'd', title: '또 나중', priority: 4, progress: 3 }, { id: 'e', title: '이상', priority: 7 },
    ],
    todoRules: RULES,
  });
  assert.deepEqual(vm.todoGroups.map((g) => [g.priority, g.label, g.items.length]), [[1, '오늘 꼭', 1], [3, '천천히', 1], [4, '언젠가', 2], [9, '기타', 1]]);
  assert.equal(vm.stats.openTodos, 3);
  assert.equal(vm.stats.p1Todos, 1);
  assert.equal(vm.stats.backlogTodos, 2);
  assert.deepEqual(vm.todoGroups[2].items[0].appliedRule, { id: 'rule:a', text: '뉴스레터는 백로그' });
  assert.equal('appliedRule' in vm.todoGroups[2].items[1], false);
  assert.deepEqual([vm.todoGroups[1].items[0].progress, vm.todoGroups[1].items[0].progressAt], ['PR 올림 · 리뷰 대기', '2026-10-13T06:00:00Z']); // 진행 확인 한 줄
  assert.equal('progress' in vm.todoGroups[2].items[1], false); // 글자가 아니면 버림
  assert.equal(vm.todoRules.length, 2);
  assert.equal(priorityLabel(4), '언젠가');
  assert.deepEqual(groupTodos([{ id: 'x', title: 'x', priority: 4 }])[0].priority, 4);
});

test('끌기·키보드: 백로그로/에서 옮기기(Alt+4), 접힌 백로그 칸도 놓을 자리', () => {
  const groups = [
    { priority: 3, top: 0, bottom: 100, rows: [{ id: 'c', top: 30, bottom: 60 }] },
    { priority: 4, top: 110, bottom: 150, rows: [] }, // 접힘: 줄 없이 칸만
  ];
  assert.deepEqual(dropTarget(130, groups, 'c'), { priority: 4, beforeId: null, y: 118 });
  const todos = [{ id: 'a', priority: 1 }, { id: 'c', priority: 3 }, { id: 'd', priority: 4 }];
  assert.deepEqual(keyMove(todos, 'a', '4'), { priority: 4, beforeId: null });
  assert.deepEqual(keyMove(todos, 'd', '2'), { priority: 2, beforeId: null });
  assert.equal(keyMove(todos, 'd', '4'), null);
  assert.deepEqual(reorderLocal(todos, 'a', 4, null).map((t) => [t.id, t.priority]), [['c', 3], ['d', 4], ['a', 4]]);
  assert.equal(clampPriority(4), 4);
  assert.deepEqual(PRIORITIES.at(-1), { value: 4, label: '언젠가' });
  assert.deepEqual(sanitizeTodoPatch({ priority: 4 }), { priority: 4 });
  assert.equal(sanitizeTodoPatch({ priority: 5 }), null);
});

test('IPC 거르기: 규칙 패치·id', () => {
  assert.deepEqual(sanitizeRulePatch({ enabled: false, evil: 1 }), { enabled: false });
  assert.deepEqual(sanitizeRulePatch({ text: '  새  글 ' }), { text: '새 글' });
  for (const bad of [null, [], {}, { enabled: 'no' }, { text: '' }]) assert.equal(sanitizeRulePatch(bad), null, JSON.stringify(bad));
  assert.equal(okRuleId('rule:ab12cd34'), true);
  for (const bad of ['', 'rule:', 'x:1', 'rule:../a', 1, null]) assert.equal(okRuleId(bad), false);
});
