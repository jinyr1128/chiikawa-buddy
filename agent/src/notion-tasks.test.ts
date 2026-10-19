import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotionTasks } from './notion.ts';
const page = (id: string, done = false) => ({ id, url: `https://notion.so/${id}`, properties: { Name: { type: 'title', title: [{ plain_text: id }] }, State: { type: 'status', status: { name: done ? '완료' : '진행 중' } } } });
test('노션 전체 공유 페이지: 페이지 넘김, 완료 제외, 하위 체크리스트 및 블록 페이지 넘김', async () => {
  const calls: string[] = [];
  const f = (async (url: any, init: any) => {
    const u = String(url); calls.push(u);
    let data: any = { results: [] };
    if (u.endsWith('/search')) data = JSON.parse(init.body).start_cursor ? { results: [page('b', true)] } : { results: [page('a')], has_more: true, next_cursor: 'next' };
    else if (u.includes('/blocks/a/')) data = u.includes('start_cursor') ? { results: [{ id: 'done', type: 'to_do', to_do: { checked: true } }] } : { results: [{ id: 'nested', type: 'toggle', has_children: true }], has_more: true, next_cursor: 'more' };
    else if (u.includes('/blocks/nested/')) data = { results: [{ id: 'task', type: 'to_do', to_do: { checked: false, rich_text: [{ plain_text: '하위 할 일' }] } }] };
    return new Response(JSON.stringify(data));
  }) as typeof fetch;
  const r = await collectNotionTasks('fake', f);
  assert.deepEqual(r.tasks.map((t) => t.title), ['a', '하위 할 일']);
  assert.equal(r.pages.length, 2);
  assert.equal(r.warning, undefined);
  assert.ok(calls.some((u) => u.includes('start_cursor=more')));
});
test('노션 일부 조회 실패는 빈 성공이 아니라 경고, 최초 인증 실패는 오류', async () => {
  const f = (async (url: any) => new Response(JSON.stringify(String(url).endsWith('/search') ? { results: [page('a')] } : { code: 'restricted_resource' }), { status: String(url).endsWith('/search') ? 200 : 403 })) as typeof fetch;
  const r = await collectNotionTasks('fake', f);
  assert.match(r.warning!, /403/);
  assert.equal(r.tasks.length, 1);
  await assert.rejects(collectNotionTasks('fake', (async () => new Response('{}', { status: 401 })) as typeof fetch), /열쇠/);
});
