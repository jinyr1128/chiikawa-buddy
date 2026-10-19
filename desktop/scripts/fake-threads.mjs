// 가짜 데몬용 대화 스레드(agent/src/chat.ts·store.ts 흉내). docs/contract.md "채팅" 경로 전부.
// 스레드마다 말 배열을 따로 두고, 모델 흉내(chat 함수)는 그 배열을 history 로 받는다.
import { randomUUID } from 'node:crypto';

const KINDS = ['chat', 'todo', 'hover'];
const okId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

export function threadTitle(text, max = 30) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const plain = line.replace(/[#>*_`~[\]]/g, '').replace(/\s+/g, ' ').trim();
  const chars = [...plain];
  if (!chars.length) return '새 대화';
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : plain;
}

// legacy: 예전 /chat/history 대본(있으면 "이전 대화"로). emit: SSE
export function createFakeThreads(emit, { legacy = [], seed = true, actionsFor, agentsFor } = {}) {
  const threads = new Map(); // id → { id, title, kind, todoId?, created, updated, archived }
  const msgs = new Map(); // id → [{ n, role, text, at, todoId?, todoTitle? }]
  const sessions = new Map(); // id → 대화 속 작업 세션 카드(GET …/agents 의 sessions — 데몬 thread-agents.ts sessionsForThread 흉내)
  let n = 0;
  const now = () => new Date().toISOString();
  const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

  const view = (t) => {
    const list = msgs.get(t.id) ?? [];
    const last = [...list].reverse().find((m) => m.role !== 'system');
    return { ...t, count: list.length, ...(last ? { preview: last.text.replace(/\s+/g, ' ').trim().slice(0, 120) } : {}) };
  };
  const signal = (t) => emit('threads', { thread: view(t) });

  function create({ title = '새 대화', kind = 'chat', todoId, at = now(), id = randomUUID() } = {}) {
    const t = { id, title: title.slice(0, 200), kind, ...(todoId ? { todoId } : {}), created: at, updated: at, archived: false };
    threads.set(id, t);
    msgs.set(id, []);
    return t;
  }
  function add(id, role, text, extra = {}) {
    const t = threads.get(id);
    if (!t) return;
    const at = extra.at ?? now();
    msgs.get(id).push({ n: ++n, role, text, at, ...(extra.todoId ? { todoId: extra.todoId, todoTitle: extra.todoTitle ?? '' } : {}) });
    if (at > t.updated) t.updated = at;
    return n;
  }
  function todoThread(todo) {
    let t = [...threads.values()].find((x) => x.kind === 'todo' && x.todoId === todo.id);
    if (t) { t.archived = false; return t; }
    t = create({ title: `할 일: ${todo.title}`.slice(0, 80), kind: 'todo', todoId: todo.id });
    return t;
  }

  // ---- 데모 대화 ----
  if (legacy.length) {
    const t = create({ id: 'legacy', title: '이전 대화', at: legacy[0].at });
    for (const m of legacy) add(t.id, m.role, m.text, m);
  }
  if (seed) {
    const a = create({ title: '오늘 회의 정리', at: ago(30) });
    add(a.id, 'user', '오늘 회의 몇 개야?', { at: ago(30) });
    add(a.id, 'assistant', '오늘은 **2개**예요. 10분 뒤 디자인 리뷰, 오후에 1:1.', { at: ago(29) });
    const hv = create({ title: '배포 끝났어?', kind: 'hover', at: ago(60 * 26) });
    add(hv.id, 'user', '배포 끝났어?', { at: ago(60 * 26) });
    add(hv.id, 'assistant', '네, 배포 끝났어요 ✅', { at: ago(60 * 26 - 1) });
    const w = create({ title: 'CY-12 접근성 점검 범위', at: ago(60 * 24 * 3) });
    add(w.id, 'user', 'CY-12 접근성 점검 범위가 어디까지야?', { at: ago(60 * 24 * 3) });
    add(w.id, 'assistant', '패널·오버레이 키보드 이동이랑 대비(4.5:1)까지예요.', { at: ago(60 * 24 * 3 - 1) });
    const old = create({ title: '지난달 회고', at: ago(60 * 24 * 12) });
    add(old.id, 'user', '지난달 회고에서 반복된 블로커 뭐였지?', { at: ago(60 * 24 * 12) });
    add(old.id, 'assistant', 'VPN 끊김으로 MCP가 안 붙던 게 세 번이었어요.', { at: ago(60 * 24 * 12 - 1) });
    // 채팅이 긴 코드 작업을 작업 세션으로 넘긴 대화 — 돌고 있는 것 하나(마지막 줄이 몇 초마다 바뀜) + 사흘 전에 끝난 것 하나
    const pr = create({ title: '다음 PR(과소분리 나누기)', at: ago(12) });
    add(pr.id, 'user', '지난번 PR 이어서 과소분리된 거 나눠 줘', { at: ago(60 * 24 * 3 + 5) });
    add(pr.id, 'assistant', '"공용 훅 정리" 작업 시작했어요. 진행은 작업 세션 창에서 볼 수 있어요.', { at: ago(60 * 24 * 3 + 4) });
    add(pr.id, 'user', '다음 PR 도 해 줘', { at: ago(12) });
    add(pr.id, 'assistant', '다음 PR(과소분리 나누기) 작업 시작했어요. 진행은 작업 세션 창에서 볼 수 있어요.', { at: ago(11) });
    const lines = ['Read(desktop/renderer/panel.js)', 'Grep(placeAgents in desktop/src)', 'Edit(desktop/src/agents.js)', 'Bash(cd desktop && npm test)', '테스트 229개 통과 — 커밋 메시지 정리하는 중이에요'];
    const live = { runId: 'fake-split-run', title: '다음 PR(과소분리 나누기)', repo: 'cy-agent', branch: 'cy/split-under-separated-3f9a1c', status: 'running', last: lines[0], startedAt: ago(11), askedAt: ago(11.5) };
    sessions.set(pr.id, [
      { runId: 'fake-hooks-run', title: '공용 훅 정리', repo: 'cy-agent', branch: 'cy/shared-hooks-8d2e01', status: 'done', last: 'PR https://github.com/my-name/cy-agent/pull/7', startedAt: ago(60 * 24 * 3 + 4), endedAt: ago(60 * 24 * 3 - 20), askedAt: ago(60 * 24 * 3 + 4.5), prUrl: 'https://github.com/my-name/cy-agent/pull/7' },
      live,
    ]);
    let k = 0;
    setInterval(() => { k = (k + 1) % lines.length; live.last = lines[k]; emit('agents', { threadId: pr.id }); }, 4000).unref?.();
    const ar = create({ title: '보관한 대화(예시)', at: ago(60 * 24 * 20) });
    add(ar.id, 'user', '예전에 물어본 것', { at: ago(60 * 24 * 20) });
    ar.archived = true;
  }

  const list = ({ archived = false, limit = 50, before } = {}) => [...threads.values()]
    .filter((t) => t.archived === archived && (!before || t.updated < before))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .slice(0, limit).map(view);

  return {
    get: (id) => threads.get(id),
    messages: (id) => msgs.get(id),
    create, add, todoThread, signal, view,
    findTodoThread: (todoId) => [...threads.values()].find((x) => x.kind === 'todo' && x.todoId === todoId), // 만들지 않고 찾기만
    byTitle: (title) => [...threads.values()].find((x) => x.title === title),
    // /chat/history(예전 모양): 할 일 스레드·시스템 줄 빼고 최근 50
    history: () => [...threads.values()].filter((t) => t.kind !== 'todo').flatMap((t) => msgs.get(t.id))
      .filter((m) => m.role !== 'system').sort((a, b) => a.n - b.n).slice(-50).map(({ n: _n, ...m }) => m),

    // POST /chat 의 스레드 고르기 → { thread, fresh } | { status, error }
    resolve(body, findTodo) {
      const { threadId, todoId, kind } = body;
      if (threadId !== undefined && !okId(threadId)) return { status: 400, error: 'threadId must be a thread id' };
      if (kind !== undefined && kind !== 'chat' && kind !== 'hover') return { status: 400, error: 'kind must be chat|hover' };
      if (threadId) {
        const t = threads.get(threadId);
        if (!t) return { status: 404, error: 'no such thread' };
        t.archived = false;
        return { thread: t, fresh: false };
      }
      if (todoId) {
        const todo = findTodo(todoId);
        if (!todo) return { status: 404, error: 'no such todo' };
        const had = [...threads.values()].some((x) => x.kind === 'todo' && x.todoId === todoId);
        return { thread: todoThread(todo), fresh: !had };
      }
      return { thread: create({ title: threadTitle(body.text), kind: kind === 'hover' ? 'hover' : 'chat' }), fresh: true };
    },

    // GET /chat/threads* · POST /chat/threads* — 처리했으면 true
    handle(req, res, url, body, json, findTodo) {
      const p = url.pathname;
      if (!p.startsWith('/chat/threads')) return false;
      if (req.method === 'GET') {
        if (p === '/chat/threads') {
          const limit = url.searchParams.get('limit'), before = url.searchParams.get('before'), archived = url.searchParams.get('archived');
          const lim = limit === null ? 50 : Number(limit);
          if (!Number.isInteger(lim) || lim < 1 || lim > 200) return json(res, 400, { error: 'limit must be 1..200' }), true;
          if (archived !== null && archived !== '0' && archived !== '1') return json(res, 400, { error: 'archived must be 0|1' }), true;
          return json(res, 200, { threads: list({ archived: archived === '1', limit: lim, ...(before ? { before } : {}) }) }), true;
        }
        const ag = p.match(/^\/chat\/threads\/([\w-]{1,64})\/agents$/);
        if (ag) return threads.has(ag[1]) ? json(res, 200, { agents: agentsFor?.(ag[1]) ?? [], sessions: sessions.get(ag[1]) ?? [] }) : json(res, 404, { error: 'no such thread' }), true;
        const m = p.match(/^\/chat\/threads\/([\w-]{1,64})\/messages$/);
        if (!m) return false;
        const t = threads.get(m[1]);
        if (!t) return json(res, 404, { error: 'no such thread' }), true;
        const lim = Number(url.searchParams.get('limit') ?? 100);
        const before = url.searchParams.get('before') === null ? Infinity : Number(url.searchParams.get('before'));
        const rows = msgs.get(t.id).filter((x) => x.n < before);
        const page = rows.slice(-lim);
        return json(res, 200, { thread: view(t), messages: page, more: rows.length > page.length, actions: actionsFor?.(t.id) ?? [] }), true;
      }
      if (req.method !== 'POST') return false;
      const m = p.match(/^\/chat\/threads(?:\/([\w-]{1,64})(?:\/(delete))?)?$/);
      if (!m) return false;
      if (!m[1]) {
        if (body.kind !== undefined && !KINDS.includes(body.kind)) return json(res, 400, { error: 'kind must be chat|todo|hover' }), true;
        if (body.kind === 'todo' && !body.todoId) return json(res, 400, { error: 'todoId required for todo threads' }), true;
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) return json(res, 400, { error: 'bad title' }), true;
        let t;
        if (body.kind === 'todo' || (body.todoId && !body.kind)) {
          const todo = findTodo(body.todoId);
          if (!todo) return json(res, 404, { error: 'no such todo' }), true;
          t = todoThread(todo);
        } else t = create({ title: body.title?.trim() || '새 대화', kind: body.kind === 'hover' ? 'hover' : 'chat' });
        signal(t);
        return json(res, 201, { thread: view(t) }), true;
      }
      const t = threads.get(m[1]);
      if (!t) return json(res, 404, { error: 'no such thread' }), true;
      if (m[2] === 'delete') {
        threads.delete(t.id);
        msgs.delete(t.id);
        emit('threads', { deleted: t.id });
        return json(res, 200, { ok: true }), true;
      }
      for (const k of Object.keys(body)) if (k !== 'title' && k !== 'archived') return json(res, 400, { error: `unknown key: ${k}` }), true;
      if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) return json(res, 400, { error: 'bad title' }), true;
      if (body.archived !== undefined && typeof body.archived !== 'boolean') return json(res, 400, { error: 'archived must be boolean' }), true;
      if (body.title === undefined && body.archived === undefined) return json(res, 400, { error: 'nothing to change' }), true;
      if (/실패/.test(body.title ?? '')) return json(res, 500, { error: '가짜 실패' }), true;
      if (body.title !== undefined) t.title = body.title.trim();
      if (body.archived !== undefined) t.archived = body.archived;
      signal(t);
      return json(res, 200, { ok: true, thread: view(t) }), true;
    },
  };
}
