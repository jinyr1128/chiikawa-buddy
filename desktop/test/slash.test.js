// 슬래시 명령 자동완성: 목록 거르기 · 맞추기(앞부분 먼저) · 키 · 캐시 · IPC 배선
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanCommands, slashQuery, matchCommands, completion, closedMenu, menuFor, menuKey, applyMenuKey, createCommandCache, MENU_MAX,
} from '../src/slash.js';

const CMDS = cleanCommands({ commands: [
  { name: 'code-review', description: '리뷰', argumentHint: '[high]' },
  { name: 'docs', description: '문서' },
  { name: 'review-pr', description: 'PR 리뷰', argumentHint: '' },
  { name: 'security-review', description: '보안', argumentHint: '' },
  { name: 'docs', description: '겹침' },
  { name: 'bad name', description: '' },
  { name: '', description: '' },
  null,
] });

test('cleanCommands: 모양이 틀린 줄·겹치는 이름은 버린다', () => {
  assert.deepEqual(CMDS.map((c) => c.name), ['code-review', 'docs', 'review-pr', 'security-review']);
  assert.deepEqual(CMDS[1], { name: 'docs', description: '문서', argumentHint: '' });
  assert.deepEqual(cleanCommands(null), []);
  assert.deepEqual(cleanCommands([{ name: 'a' }]).map((c) => c.name), ['a']);
});

test('slashQuery: / 로 시작하고 공백 전까지만', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/rev'), 'rev');
  assert.equal(slashQuery('/review '), null);
  assert.equal(slashQuery('/review\n'), null);
  assert.equal(slashQuery('안녕 /rev'), null);
  assert.equal(slashQuery(' /rev'), null);
  assert.equal(slashQuery(undefined), null);
});

test('matchCommands: 앞부분이 맞는 것 먼저, 그다음 들어 있는 것, 대소문자 무시, 최대 개수', () => {
  assert.deepEqual(matchCommands(CMDS, 'rev').map((c) => c.name), ['review-pr', 'code-review', 'security-review']);
  assert.deepEqual(matchCommands(CMDS, 'DOC').map((c) => c.name), ['docs']);
  assert.deepEqual(matchCommands(CMDS, '').map((c) => c.name), CMDS.map((c) => c.name));
  assert.deepEqual(matchCommands(CMDS, 'zzz'), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, description: '', argumentHint: '' }));
  assert.equal(matchCommands(many, 'c').length, MENU_MAX);
  assert.equal(completion('docs'), '/docs ');
});

test('menuFor: 열기·닫기·고른 자리 지키기·Esc 로 닫은 그대로면 다시 안 뜬다', () => {
  let m = menuFor(closedMenu(), '/', CMDS);
  assert.equal(m.open, true);
  assert.equal(m.items.length, 4);
  m = applyMenuKey(m, 'down', '/').menu; // 두 번째(docs)
  assert.equal(m.items[m.index].name, 'docs');
  m = menuFor(m, '/d', CMDS); // docs 가 남으면 그대로 고른 것
  assert.equal(m.items[m.index].name, 'docs');
  m = menuFor(m, '/re', CMDS);
  assert.equal(m.index, 0);
  assert.equal(menuFor(m, '/re ', CMDS).open, false);
  assert.equal(menuFor(m, '/zzz', CMDS).open, false);
  assert.equal(menuFor(m, '/re', []).open, false); // 목록이 없으면 안 뜬다
  const closed = applyMenuKey(m, 'close', '/re').menu;
  assert.equal(closed.open, false);
  assert.equal(menuFor(closed, '/re', CMDS).open, false);
  assert.equal(menuFor(closed, '/rev', CMDS).open, true);
});

test('menuKey·applyMenuKey: ↑/↓ 돌고, Tab·Enter 는 넣기, Shift+Enter·조합 중·닫힌 메뉴는 손대지 않음', () => {
  const m = menuFor(closedMenu(), '/rev', CMDS);
  assert.equal(menuKey({ key: 'ArrowDown' }, m), 'down');
  assert.equal(menuKey({ key: 'ArrowUp' }, m), 'up');
  assert.equal(menuKey({ key: 'Tab' }, m), 'complete');
  assert.equal(menuKey({ key: 'Enter' }, m), 'complete');
  assert.equal(menuKey({ key: 'Escape' }, m), 'close');
  assert.equal(menuKey({ key: 'Enter', shiftKey: true }, m), null);
  assert.equal(menuKey({ key: 'Enter', isComposing: true }, m), null);
  assert.equal(menuKey({ key: 'Enter', keyCode: 229 }, m), null);
  assert.equal(menuKey({ key: 'ArrowDown', metaKey: true }, m), null);
  assert.equal(menuKey({ key: 'a' }, m), null);
  assert.equal(menuKey({ key: 'Enter' }, closedMenu()), null);
  assert.equal(applyMenuKey(m, 'up', '/rev').menu.index, 2); // 맨 위에서 ↑ → 맨 아래
  assert.equal(applyMenuKey({ ...m, index: 2 }, 'down', '/rev').menu.index, 0);
  const done = applyMenuKey({ ...m, index: 1 }, 'complete', '/rev');
  assert.equal(done.insert, '/code-review ');
  assert.equal(done.menu.open, false);
});

test('createCommandCache: 한 번만 부르고(동시에도) 10분 캐시, 실패·빈 목록은 1분 뒤 다시', async () => {
  let t = 0, calls = 0, reply = { ok: false };
  const c = createCommandCache(async () => { calls++; return reply; }, { now: () => t });
  assert.deepEqual(await c.load(), []);
  assert.equal(calls, 1);
  await c.load(); assert.equal(calls, 1);
  t = 60_000; reply = { ok: true, data: { commands: [{ name: 'docs', description: 'd' }] } };
  const [a, b] = await Promise.all([c.load(), c.load()]);
  assert.equal(calls, 2);
  assert.equal(a, b);
  assert.deepEqual(c.get().map((x) => x.name), ['docs']);
  t = 60_000 + 9 * 60_000; await c.load(); assert.equal(calls, 2);
  t = 60_000 + 10 * 60_000; reply = null; await c.load(); assert.equal(calls, 3);
  assert.deepEqual(c.get().map((x) => x.name), ['docs'], '실패해도 예전 목록');
  const thrower = createCommandCache(async () => { throw new Error('x'); });
  assert.deepEqual(await thrower.load(), []);
});

test('IPC 배선: 패널·세션 창 listCommands → slash-commands → GET /commands, 입력창에 메뉴', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js'), ps = read('preload-session.cjs'), pp = read('preload-panel.cjs'), panel = read('renderer/panel.js'), sess = read('renderer/session.js');
  assert.match(main, /ipcMain\.handle\('slash-commands', \(e\) => \(fromOurs\(e\) \? request\('GET', '\/commands'/);
  assert.match(ps, /listCommands: \(\) => ipcRenderer\.invoke\('slash-commands'\)/);
  assert.match(pp, /listCommands: \(\) => ipcRenderer\.invoke\('slash-commands'\)/);
  assert.match(panel, /attachSlashMenu\(chatInput, \{ listCommands: \(\) => cy\.listCommands\(\) \}\)/);
  assert.match(sess, /attachSlashMenu\(input, \{ listCommands: \(\) => cy\.listCommands\(\), extra: \[BTW_COMMAND\] \}\)/); // 세션 창은 /btw 를 맨 앞에
  // 메뉴가 Enter 를 보내기보다 먼저 가로채도록 캡처 단계에서
  assert.match(read('renderer/slash-menu.js'), /stopImmediatePropagation\(\);[\s\S]*\}, true\);/);
});
