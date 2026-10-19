import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodaySources } from '../renderer/today-sources.js';
const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children, replaceChildren(...xs) { this.children = xs; } });
test('오늘 일정은 자정부터, 종일·지난 일정도 포함하고 노션 할 일 및 부분 실패를 표시', async () => {
  let query;
  const view = createTodaySources({ h, goto() {}, cy: {
    calendarEvents: async (q) => { query = q; return { ok: true, data: { connected: true, ok: false, calendars: [{ id: 'bad', name: '네이버', enabled: true, phase: 'failed', reason: '로그인 필요' }], events: [{ id: '1', title: '아침 회의', start: '2026-10-19T00:00:00Z' }, { id: '2', title: '종일 업무', allDay: true, start: '2026-10-18T15:00:00Z' }] } }; },
    notionStatus: async () => ({ ok: true, data: { connected: true, phase: 'ok', at: 'now', tasks: [{ title: '보고서', page: '업무', url: 'https://notion.so/test', due: null }] } }),
  } });
  await view.refresh();
  assert.equal(new Date(query.from).getHours(), 0);
  assert.equal(new Date(query.to).getHours(), 0);
  const text = JSON.stringify(view.el);
  for (const title of ['아침 회의', '종일 업무', '로그인 필요', '보고서']) assert.ok(text.includes(title));
});
test('읽기 실패를 할 일이 없다는 성공 메시지로 표시하지 않는다', async () => {
  const view = createTodaySources({ h, goto() {}, cy: { calendarEvents: async () => { throw Error('offline'); }, notionStatus: async () => ({ ok: false }) } });
  await view.refresh();
  assert.match(JSON.stringify(view.el), /가져오지 못했어요/);
  assert.doesNotMatch(JSON.stringify(view.el), /오늘 등록된 일정이 없어요/);
});
