import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shapeManualProjects, dueText, dueTone, dayLabel, todoCountText, createBody, editBody, draftFromPick, draftOf, shapePick, eventWhen, sanitizeProjectBody, okProjectId,
} from '../src/manual-projects.js';
import { shapeDashboard } from '../src/dashboard.js';
import { sanitizeTodoPatch } from '../src/todos.js';

const NOW = new Date(2026, 9, 17, 10, 0).getTime(); // 2026-10-17(토) 10:00 로컬

test('카드 모양: 기한 글·톤, 일정에서 표시, 묶인 열린 할 일, 깨진 항목은 버림', () => {
  const list = shapeManualProjects([
    { id: 'proj:a', name: '가을 행사', note: '장소', due: '2026-10-30', start: '2026-10-18', status: 'open', todos: 3, openTodos: 2, source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '킥오프' } },
    { id: 'proj:b', name: '끝난 일', due: '2026-10-01', status: 'done', todos: 0, openTodos: 0 },
    { id: '', name: 'x' }, null, { id: 'proj:c' },
  ], [{ id: 't1', title: '섭외', projectId: 'proj:a', priority: 2 }, { id: 't2', title: '다른 일' }], NOW);
  assert.equal(list.length, 2);
  const [a, b] = list;
  assert.deepEqual([a.dueText, a.dueTone, a.startText], ['10월 30일(금)까지 · D-13', '', '10월 18일(일)']);
  assert.deepEqual(a.fromCalendar, { calendar: '회사', title: '킥오프', eventId: 'e1' });
  assert.deepEqual(a.linked, [{ id: 't1', title: '섭외', priority: 2 }]);
  assert.deepEqual([b.done, b.dueText], [true, ''], '끝난 건 기한 글 없음');
  assert.equal(dueText('2026-10-17', NOW), '오늘까지');
  assert.equal(dueText('2026-10-18', NOW), '내일까지');
  assert.equal(dueText('2026-10-14', NOW), '10월 14일(수) · 3일 지남');
  assert.deepEqual([dueTone('2026-10-14', NOW), dueTone('2026-10-19', NOW), dueTone('2026-11-19', NOW)], ['over', 'soon', '']);
  assert.equal(dayLabel('2027-01-02', NOW), '2027년 1월 2일(토)');
  assert.equal(todoCountText({ todos: 0, openTodos: 0 }), '할 일 없음');
  assert.equal(todoCountText({ todos: 3, openTodos: 0 }), '할 일 다 끝냄 (3개)');
  assert.equal(todoCountText({ todos: 3, openTodos: 2 }), '할 일 2개 남음 · 모두 3개');
  // 대시보드 vm: manualProjects, 할 일의 projectId
  const vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: 'A', status: 'open' }], todos: [{ id: 't1', title: 'x', priority: 1, projectId: 'proj:a' }] }, NOW);
  assert.equal(vm.manualProjects[0].linked[0].id, 't1');
  assert.equal(vm.todoGroups[0].items[0].projectId, 'proj:a');
  assert.deepEqual(shapeDashboard(null).manualProjects, []);
});

test('만들기 칸 → 본문: 이름 필수·날짜 순서·빈 칸은 뺌, 고치기는 바뀐 것만(지운 칸은 null)', () => {
  assert.deepEqual(createBody({ name: '  ' }), { error: '이름을 적어 주세요' });
  assert.deepEqual(createBody({ name: 'a', start: '2026-10-20', due: '2026-10-19' }), { error: '기한이 시작보다 앞이에요' });
  assert.deepEqual(createBody({ name: ' 가을  행사 ', note: ' 메모 \r\n둘 ', start: '', due: '2026-10-30' }), { name: '가을 행사', note: '메모 \n둘', due: '2026-10-30' });
  const src = { kind: 'calendar', eventId: 'e1', calendar: '회사' };
  assert.deepEqual(createBody({ name: 'a', source: src }), { name: 'a', source: src });
  const cur = { name: '가을 행사', note: '장소', start: '', due: '2026-10-30' };
  assert.deepEqual(editBody(cur, draftOf(cur)), { patch: null });
  assert.deepEqual(editBody(cur, { ...draftOf(cur), note: '', start: '2026-10-18' }), { patch: { note: null, start: '2026-10-18' } });
  assert.deepEqual(editBody(cur, { ...draftOf(cur), name: '' }), { error: '이름을 적어 주세요' });
});

test('일정 고르기: 응답 → 상태(연결 안 됨·오류·비었음·일부만), 고른 일정 → 칸, 시각 글', () => {
  assert.deepEqual(shapePick({ ok: true, data: { connected: false, events: [] } }), { state: 'off' });
  assert.deepEqual(shapePick({ ok: false, error: 'x' }), { state: 'error' });
  assert.deepEqual(shapePick({ ok: false, status: 503, data: { error: 'x' } }), { state: 'error' });
  assert.equal(shapePick({ ok: true, data: { connected: true, ok: true, events: [] } }).state, 'empty');
  assert.equal(shapePick({ ok: true, data: { connected: true, ok: false, events: [] } }).state, 'error');
  const ev = { id: 'e1', title: '킥오프', start: new Date(2026, 9, 20, 10).toISOString(), end: new Date(2026, 9, 20, 11).toISOString(), allDay: false, past: false,
    draft: { name: '킥오프', note: '안건', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } } };
  const old = { ...ev, id: 'e0', past: true };
  const p = shapePick({ ok: true, data: { connected: true, ok: false, events: [ev, old] } });
  assert.deepEqual([p.state, p.partial, p.upcoming.length, p.past.length], ['ok', true, 1, 1]);
  assert.deepEqual(draftFromPick(ev), { name: '킥오프', note: '안건', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } });
  assert.equal(eventWhen(ev, NOW), '10월 20일(화) 10:00–11:00');
  assert.equal(eventWhen({ start: new Date(2026, 9, 23).toISOString(), end: new Date(2026, 9, 24).toISOString(), allDay: true }, NOW), '10월 23일(금) 종일');
  assert.equal(eventWhen({ start: new Date(2026, 9, 23).toISOString(), end: new Date(2026, 9, 26).toISOString(), allDay: true }, NOW), '10월 23일(금) ~ 10월 25일(일)');
});

test('IPC 본문 거르기: 프로젝트 본문·id, 할 일의 projectId', () => {
  assert.deepEqual(sanitizeProjectBody({ name: 'a', note: null, owner: 'x', source: { kind: 'calendar', eventId: 'e', calendar: 'c', bad: 1 } }), { name: 'a', note: null, source: { kind: 'calendar', eventId: 'e', calendar: 'c' } });
  assert.equal(sanitizeProjectBody({ note: 'x' }), null, '만들기는 이름이 있어야');
  assert.deepEqual(sanitizeProjectBody({ status: 'done', source: { kind: 'calendar', eventId: 'e' } }, { partial: true }), { status: 'done' });
  assert.equal(sanitizeProjectBody({}, { partial: true }), null);
  assert.ok(okProjectId('proj:0b4c-11aa'));
  assert.ok(!okProjectId('proj:../x') && !okProjectId('user:1') && !okProjectId(3));
  assert.deepEqual(sanitizeTodoPatch({ projectId: 'proj:a1' }), { projectId: 'proj:a1' });
  assert.deepEqual(sanitizeTodoPatch({ projectId: null }), { projectId: null });
  assert.equal(sanitizeTodoPatch({ projectId: '../x' }), null);
});

// ---- 화면: 가짜 DOM 으로 projects-view.js 를 그려 누른다 ----
function fakeDom() {
  const body = [];
  globalThis.document = { body: { append: (el) => body.push(el) }, addEventListener() {}, removeEventListener() {} };
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = {
      tag, cls, props: props ?? {}, kids: kids.flat().filter((k) => k != null && k !== false), value: props?.value ?? '',
      focus() {}, remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); }, append(...k) { el.kids.push(...k); },
    };
    return el;
  };
  const fill = (el, ...kids) => { el.kids = kids.flat().filter((k) => k != null && k !== false); };
  const text = (el) => { if (Array.isArray(el)) throw new Error('nested array kid'); return typeof el === 'string' ? el : !el ? '' : [el.props?.text ?? '', ...el.kids.map(text)].join(' '); };
  // 패널 h 처럼 한 겹만 편다 — 더 깊은 배열이 남으면 화면에 [object …] 로 찍히니 잡는다
  const all = (el, out = []) => { if (Array.isArray(el)) throw new Error('nested array kid'); if (el && typeof el === 'object') { out.push(el); for (const k of el.kids) all(k, out); } return out; };
  const find = (root, pred) => all(root).find(pred);
  const button = (root, label) => find(root, (e) => e.tag === 'button' && text(e).includes(label));
  return { body, h, fill, text, find, button };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('화면: 빈 탭 → ＋ → 새로 만들기 → 저장, ＋ → 일정에서 가져오기 → 고르기 → 채운 칸 저장, 캘린더 없으면 안내', async () => {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const calls = [];
  let pick = { ok: true, data: { connected: true, ok: true, events: [
    { id: 'e1', title: '제품 출시 회의', start: new Date(2026, 9, 20, 10).toISOString(), end: new Date(2026, 9, 20, 11).toISOString(), allDay: false, past: false, calendar: '회사', location: '3층',
      draft: { name: '제품 출시 회의', note: '안건\n장소: 3층', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '제품 출시 회의' } } },
  ] } };
  const cy = {
    projectCreate: async (b) => { calls.push(['create', b]); return { ok: true, status: 201, data: { project: { id: 'proj:1' } } }; },
    projectCalendarEvents: async () => pick,
  };
  let changed = 0, settings = 0;
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => changed++, openSettings: () => settings++ });
  const vm = { manualProjects: [], todoGroups: [] };
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  assert.match(d.text(sec), /내가 만든 프로젝트/);
  assert.match(d.text(sec), /아직 만든 프로젝트가 없어요/);

  // ＋ → 새로 만들기
  d.button(sec, '＋ 새 프로젝트').props.onclick();
  assert.equal(d.body.length, 1);
  assert.match(d.text(d.body[0]), /새로 만들기.*일정에서 가져오기/s);
  d.button(d.body[0], '새로 만들기').props.onclick();
  const name = d.find(d.body[0], (e) => e.props['aria-label'] === '이름');
  d.button(d.body[0], '저장').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /이름을 적어 주세요/);
  name.props.oninput({ target: { value: '책장 정리' } });
  d.find(d.body[0], (e) => e.props['aria-label'] === '기한').props.oninput({ target: { value: '2026-10-25' } });
  d.button(d.body[0], '저장').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['create', { name: '책장 정리', due: '2026-10-25' }]);
  assert.equal(d.body.length, 0, '저장하면 창이 닫힌다');
  assert.equal(changed, 1);
  assert.match(d.text(sec), /「책장 정리」 프로젝트를 만들었어요/);

  // ＋ → 일정에서 가져오기 → 고르기 → 채운 칸(이름·메모·날짜·📅) → 저장
  view.openCreate();
  d.button(d.body[0], '일정에서 가져오기').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /다가오는 일정/);
  assert.match(d.text(d.body[0]), /제품 출시 회의/);
  assert.match(d.text(d.body[0]), /회사 · 3층/);
  d.button(d.body[0], '제품 출시 회의').props.onclick();
  const f = d.body[0];
  assert.match(d.text(f), /일정으로 프로젝트 만들기/);
  assert.match(d.text(f), /📅 일정에서 · 회사/);
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '이름').value, '제품 출시 회의');
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '메모').value, '안건\n장소: 3층');
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '시작').value, '2026-10-20');
  d.find(f, (e) => e.props['aria-label'] === '이름').props.oninput({ target: { value: '제품 출시' } });
  d.button(f, '저장').props.onclick();
  await flush();
  const [, body] = calls.pop();
  assert.deepEqual(body, { name: '제품 출시', note: '안건\n장소: 3층', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '제품 출시 회의' } });

  // 캘린더 안 붙음 → 안내 + 설정 열기
  pick = { ok: true, data: { connected: false, ok: false, events: [] } };
  view.openCreate();
  d.button(d.body[0], '일정에서 가져오기').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /설정에서 캘린더를 연결하면 일정에서 가져올 수 있어요/);
  d.button(d.body[0], '설정 열기').props.onclick();
  assert.equal(settings, 1);
  assert.equal(d.body.length, 0);
});

test('화면: 카드 — 📅 표시·기한·할 일 수·묶인 할 일, 할 일 추가·기존 할 일 넣기·빼기·끝내기, 지우기는 확인 한 번', async () => {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const calls = [];
  const ok = { ok: true, status: 200, data: {} };
  const cy = {
    todoAdd: async (b) => { calls.push(['add', b]); return ok; },
    todoEdit: async (id, p) => { calls.push(['edit', id, p]); return ok; },
    todoDone: async (id) => { calls.push(['done', id]); return ok; },
    projectEdit: async (id, p) => { calls.push(['pedit', id, p]); return ok; },
    projectDelete: async (id) => { calls.push(['pdel', id]); return ok; },
  };
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
  const raw = {
    manualProjects: [{ id: 'proj:a', name: '가을 행사', note: '장소 섭외', due: '2026-10-30', status: 'open', todos: 2, openTodos: 1, source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } }],
    todos: [{ id: 't1', title: '현수막', priority: 2, projectId: 'proj:a' }, { id: 't2', title: '견적 회신', priority: 1 }],
  };
  const vm = shapeDashboard(raw, NOW);
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  const t = d.text(sec);
  for (const want of ['가을 행사', '📅 일정에서 · 회사', '10월 30일(금)까지 · D-13', '할 일 1개 남음 · 모두 2개', '장소 섭외', '현수막']) assert.ok(t.includes(want), want);
  assert.ok(!t.includes('아직 만든 프로젝트가 없어요'));

  // 할 일 추가(Enter)
  const input = d.find(sec, (e) => e.tag === 'input' && e.props['aria-label'] === '할 일 추가: 가을 행사');
  input.value = '  포스터   만들기 ';
  input.props.onkeydown({ key: 'Enter', isComposing: false, preventDefault() {}, target: input });
  await flush();
  assert.deepEqual(calls.pop(), ['add', { title: '포스터 만들기', priority: 2, projectId: 'proj:a' }]);
  // 기존 할 일 넣기(이 프로젝트에 없는 것만 고를 수 있다)
  const sel = d.find(sec, (e) => e.tag === 'select');
  assert.deepEqual(sel.kids.slice(1).map((o) => o.props.value), ['t2']);
  sel.props.onchange({ target: { value: 't2' } });
  await flush();
  assert.deepEqual(calls.pop(), ['edit', 't2', { projectId: 'proj:a' }]);
  // 빼기·끝내기
  d.find(sec, (e) => e.props['aria-label'] === '프로젝트에서 빼기: 현수막').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['edit', 't1', { projectId: null }]);
  d.find(sec, (e) => e.props['aria-label'] === '끝내기: 현수막').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['done', 't1']);
  // 프로젝트 끝내기
  d.button(sec, '끝내기').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pedit', 'proj:a', { status: 'done' }]);
  // 지우기: 한 번 누르면 확인, 취소하면 그대로, 다시 눌러 확인하면 지운다
  d.button(sec, '지우기').props.onclick();
  assert.match(d.text(sec), /지울까요\? 묶인 할 일 2개는 남아요/);
  assert.equal(calls.length, 0);
  d.button(sec, '취소').props.onclick();
  assert.ok(!d.text(sec).includes('지울까요'));
  d.button(sec, '지우기').props.onclick();
  d.find(sec, (e) => e.tag === 'button' && e.cls.includes('danger')).props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pdel', 'proj:a']);
  assert.match(d.text(sec), /「가을 행사」 프로젝트를 지웠어요/);
  // 고치기 → 칸에 지금 값 → 메모 지우고 저장하면 바뀐 것만
  d.button(sec, '고치기').props.onclick();
  const f = d.body.at(-1);
  assert.match(d.text(f), /프로젝트 고치기/);
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '이름').value, '가을 행사');
  d.find(f, (e) => e.props['aria-label'] === '메모').props.oninput({ target: { value: '' } });
  d.button(f, '저장').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pedit', 'proj:a', { note: null }]);
});

test('패널 연결: 프로젝트 탭이 위에 직접 만든 것, 아래 「코드 작업에서 모은 것」, 할 일 줄에 📁 칩, IPC 와 프리로드', () => {
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /projectsView\.section\(vm, renderProjects\)/);
  assert.match(panel, /코드 작업에서 모은 것/);
  assert.match(panel, /projectChip\(t\)/);
  assert.match(readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8'), /projects\.css/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  for (const ch of ['projects-manual', 'project-create', 'project-edit', 'project-delete', 'project-calendar-events']) assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch);
  assert.match(main, /request\('PATCH', `\/projects\/manual\//);
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  for (const k of ['projectsManual', 'projectCreate', 'projectEdit', 'projectDelete', 'projectCalendarEvents']) assert.ok(pre.includes(`${k}:`), k);
});
