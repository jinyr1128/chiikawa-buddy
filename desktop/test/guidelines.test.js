import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeGuidelineAdd, sanitizeGuidelinePatch, okGuidelineId, shapeGuidelines, countText, mountGuidelines, SCOPES } from '../src/guidelines.js';
import { setupSettings } from '../src/settings-window.js';

// 아주 작은 가짜 DOM: 그리기·이벤트만
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; }
  append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } if (this.tagName === 'SELECT') { const sel = n.find((c) => c.selected); if (sel) this.value = sel.value; else if (!this.value && this.children[0]) this.value = this.children[0].value; } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  querySelector(sel) { return this.byClass(sel.replace(/^\./, ''))[0] ?? null; }
  focus() {}
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
function fakeDoc() {
  const ids = {};
  for (const [id, tag] of [['gl-list', 'div'], ['gl-count', 'span'], ['gl-add-text', 'input'], ['gl-add-scope', 'select'], ['gl-add', 'button']]) ids[id] = new Node(tag);
  return { ids, getElementById: (id) => ids[id] ?? null, createElement: (t) => new Node(t) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const G = [
  { id: 'gl-b', text: '표 쓰지 마', scope: 'chat', active: true, updated: '2026-10-02T00:00:00Z', sourceThread: 't1' },
  { id: 'gl-a', text: '답은 짧게', scope: 'all', active: false, updated: '2026-10-01T00:00:00Z' },
];

test('IPC 인자 거르기: 추가·고치기·id', () => {
  assert.deepEqual(sanitizeGuidelineAdd({ text: '  답은\n짧게 ' }), { text: '답은 짧게', scope: 'all' });
  assert.deepEqual(sanitizeGuidelineAdd({ text: 'x', scope: 'code' }), { text: 'x', scope: 'code' });
  for (const bad of [null, [], {}, { text: '' }, { text: 'x', scope: 'slack' }, { text: 'x', active: true }]) assert.equal(sanitizeGuidelineAdd(bad), null, JSON.stringify(bad));
  assert.deepEqual(sanitizeGuidelinePatch({ active: false }), { active: false });
  assert.deepEqual(sanitizeGuidelinePatch({ text: ' a ', scope: 'briefing' }), { text: 'a', scope: 'briefing' });
  for (const bad of [null, {}, { active: 'no' }, { scope: 'x' }, { text: '' }, { id: 'x' }]) assert.equal(sanitizeGuidelinePatch(bad), null, JSON.stringify(bad));
  assert.ok(okGuidelineId('gl-1a2b3c4d'));
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 3]) assert.equal(okGuidelineId(bad), false);
});

test('shapeGuidelines·countText: 오래된 → 최근(프롬프트와 같은 순서), 깨진 것 빼기', () => {
  const s = shapeGuidelines([...G, { id: '../x', text: 'bad' }, null, { id: 'gl-c', text: '' }]);
  assert.deepEqual(s.map((g) => [g.id, g.scope, g.active, g.fromChat]), [['gl-a', 'all', false, false], ['gl-b', 'chat', true, true]]);
  assert.equal(countText(s), '1/2개 켜짐');
  assert.equal(countText(s.filter((g) => g.active)), '1개');
  assert.equal(countText([]), '');
});

test('설정 창 「행동 지침」 그리기: 목록·범위·켜기/끄기·고치기·지우기·직접 넣기', async () => {
  const doc = fakeDoc();
  const calls = [];
  let data = structuredClone(G);
  const res = () => ({ ok: true, data: { guidelines: data } });
  const cy = {
    getGuidelines: async () => res(),
    addGuideline: async (g) => { calls.push(['add', g]); data.push({ id: 'gl-n', ...g, active: true, updated: '2026-10-03T00:00:00Z' }); return res(); },
    editGuideline: async (id, p) => { calls.push(['edit', id, p]); data = data.map((g) => (g.id === id ? { ...g, ...p } : g)); return res(); },
    deleteGuideline: async (id) => { calls.push(['del', id]); data = data.filter((g) => g.id !== id); return res(); },
  };
  const flashes = [];
  const ui = mountGuidelines(doc, cy, (t, err) => flashes.push([t, !!err]));
  // 빈 목록 안내 · 추가 범위 선택지
  assert.match(doc.ids['gl-list'].text, /아직 없어요/);
  assert.deepEqual(doc.ids['gl-add-scope'].children.map((o) => o.value), SCOPES);
  assert.equal(await ui.load(), true);
  const rows = () => doc.ids['gl-list'].byClass('gl-row');
  assert.deepEqual(rows().map((r) => r.dataset.id), ['gl-a', 'gl-b']);
  assert.ok(rows()[0].className.includes('off'));
  assert.equal(rows()[1].byClass('gl-scope')[0].value, 'chat');
  assert.equal(rows()[1].byClass('gl-src')[0].textContent, '대화에서');
  assert.equal(doc.ids['gl-count'].textContent, '1/2개 켜짐');
  // 켜기
  const cb = rows()[0].byClass('gl-active')[0];
  cb.checked = true;
  cb.fire('change');
  await tick();
  assert.deepEqual(calls.at(-1), ['edit', 'gl-a', { active: true }]);
  assert.equal(doc.ids['gl-count'].textContent, '2개');
  // 범위 바꾸기
  const sel = rows()[1].byClass('gl-scope')[0];
  sel.value = 'code';
  sel.fire('change');
  await tick();
  assert.deepEqual(calls.at(-1), ['edit', 'gl-b', { scope: 'code' }]);
  // 글 눌러 고치기 → Enter
  rows()[0].byClass('gl-text')[0].fire('click');
  const input = rows()[0].byClass('gl-edit')[0];
  assert.equal(input.value, '답은 짧게');
  input.value = '답은 세 줄 이내';
  input.fire('keydown', { key: 'Enter' });
  await tick();
  assert.deepEqual(calls.at(-1), ['edit', 'gl-a', { text: '답은 세 줄 이내' }]);
  assert.equal(rows()[0].byClass('gl-edit').length, 0);
  assert.match(rows()[0].text, /답은 세 줄 이내/);
  // 빈 글로 고치기는 안 보낸다
  rows()[0].byClass('gl-text')[0].fire('click');
  rows()[0].byClass('gl-edit')[0].value = '  ';
  rows()[0].byClass('gl-edit')[0].fire('keydown', { key: 'Enter' });
  assert.equal(calls.length, 3);
  assert.deepEqual(flashes.at(-1), ['지침을 적어 주세요', true]);
  rows()[0].byClass('gl-edit')[0].fire('keydown', { key: 'Escape' });
  // 지우기
  rows()[1].byClass('gl-del')[0].fire('click');
  await tick();
  assert.deepEqual(calls.at(-1), ['del', 'gl-b']);
  assert.deepEqual(rows().map((r) => r.dataset.id), ['gl-a']);
  // 직접 넣기
  doc.ids['gl-add-text'].value = '인사는 반말로';
  doc.ids['gl-add-scope'].value = 'chat';
  doc.ids['gl-add'].fire('click');
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['add', { text: '인사는 반말로', scope: 'chat' }]);
  assert.equal(doc.ids['gl-add-text'].value, '');
  assert.deepEqual(rows().map((r) => r.dataset.id), ['gl-a', 'gl-n']);
  // 실패하면 알림
  cy.deleteGuideline = async () => ({ ok: false, status: 404, data: { error: 'no such guideline' } });
  rows()[0].byClass('gl-del')[0].fire('click');
  await tick();
  assert.deepEqual(flashes.at(-1), ['저장 못 했어요: no such guideline', true]);
  assert.equal(rows().length, 2);
});

test('설정 창 IPC: 행동 지침은 이 창에서만, 인자는 걸러서 데몬으로', async () => {
  const handlers = {}, requests = [];
  const fakeWin = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false };
  class BW { constructor() { return fakeWin; } }
  const ui = setupSettings({
    BrowserWindow: BW, ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: () => {} }, shell: { openExternal: async () => {} },
    request: async (...a) => { requests.push(a); return { ok: true }; }, fromOurs: () => false, preload: 'p', html: 'h',
  });
  ui.show();
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  const bad = { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } };
  await handlers['guidelines-get'](mine);
  await handlers['guidelines-add'](mine, { text: '표 쓰지 마', scope: 'chat' });
  await handlers['guidelines-edit'](mine, 'gl-1', { active: false });
  await handlers['guidelines-delete'](mine, 'gl-1');
  assert.deepEqual(await handlers['guidelines-get'](other), bad);
  assert.deepEqual(await handlers['guidelines-add'](mine, { text: '' }), bad);
  assert.deepEqual(await handlers['guidelines-edit'](mine, '../x', { active: false }), bad);
  assert.deepEqual(await handlers['guidelines-edit'](mine, 'gl-1', { evil: 1 }), bad);
  assert.deepEqual(await handlers['guidelines-delete'](other, 'gl-1'), bad);
  assert.deepEqual(requests.map((r) => r.slice(0, 3)), [
    ['GET', '/guidelines'], ['POST', '/guidelines', { text: '표 쓰지 마', scope: 'chat' }], ['PUT', '/guidelines/gl-1', { active: false }], ['DELETE', '/guidelines/gl-1'],
  ]);
  // 화면·프리로드·헤더
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  for (const id of ['gl-list', 'gl-count', 'gl-add-text', 'gl-add-scope', 'gl-add']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, />행동 지침</);
  const pre = readFileSync(new URL('../preload-settings.cjs', import.meta.url), 'utf8');
  for (const c of ['guidelines-get', 'guidelines-add', 'guidelines-edit', 'guidelines-delete']) assert.match(pre, new RegExp(`'${c}'`));
  assert.match(readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8'), /mountGuidelines\(document, cy, flash\)/);
  assert.match(readFileSync(new URL('../main.js', import.meta.url), 'utf8'), /else if \(method === 'DELETE'\) headers\['X-CY-Agent'\] = '1';/);
});
