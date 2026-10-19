// 대화 스레드: 저장소 이전(옛 기록 → "이전 대화"), HTTP 경로·CSRF, SSE threads·chat 의 threadId
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store, LEGACY_THREAD } from "./store.ts";
import { loadConfig } from "./config.ts";
import type { Converse } from "./chat.ts";

test("저장소: 스레드 전 기록은 '이전 대화' 하나로 옮기고, 두 번 열어도 그대로", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cy-threads-")), "cy.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, todo_id TEXT, todo_title TEXT)");
  old.prepare("INSERT INTO chat (role, text, at) VALUES (?, ?, ?)").run("user", "예전 말", "2026-10-01T00:00:00.000Z");
  old.prepare("INSERT INTO chat (role, text, at) VALUES (?, ?, ?)").run("assistant", "예전 답", "2026-10-01T00:00:05.000Z");
  old.close();
  const s = new Store(path);
  const [legacy] = s.threads();
  assert.deepEqual([legacy.id, legacy.title, legacy.kind, legacy.created, legacy.updated, legacy.count, legacy.preview],
    [LEGACY_THREAD, "이전 대화", "chat", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:05.000Z", 2, "예전 답"]);
  assert.deepEqual(s.threadMessages(LEGACY_THREAD).map((m) => [m.role, m.text]), [["user", "예전 말"], ["assistant", "예전 답"]]);
  const t = s.createThread({ title: "새거", at: "2026-10-02T00:00:00.000Z" });
  s.addChat("user", "안녕", "2026-10-02T00:00:01.000Z", undefined, t.id);
  const again = new Store(path);
  assert.deepEqual(again.threads().map((x) => [x.title, x.count]), [["새거", 1], ["이전 대화", 2]]);
  assert.equal(again.threadMessages(t.id).length, 1);
});

test("저장소: 보관·삭제·페이지(updated 커서, 메시지 n 커서)", () => {
  const s = new Store(":memory:");
  const ids = [1, 2, 3].map((i) => s.createThread({ title: `t${i}`, at: `2026-10-0${i}T00:00:00.000Z` }).id);
  assert.deepEqual(s.threads({ limit: 2 }).map((t) => t.title), ["t3", "t2"]);
  assert.deepEqual(s.threads({ before: "2026-10-02T00:00:00.000Z" }).map((t) => t.title), ["t1"]);
  s.editThread(ids[0], { archived: true });
  assert.deepEqual(s.threads().map((t) => t.title), ["t3", "t2"]);
  assert.deepEqual(s.threads({ archived: true }).map((t) => t.title), ["t1"]);
  for (let i = 0; i < 5; i++) s.addChat("user", `m${i}`, undefined, undefined, ids[1]);
  const last2 = s.threadMessages(ids[1], { limit: 2 });
  assert.deepEqual(last2.map((m) => m.text), ["m3", "m4"]);
  assert.deepEqual(s.threadMessages(ids[1], { limit: 2, before: last2[0].n }).map((m) => m.text), ["m1", "m2"]);
  assert.equal(s.deleteThread(ids[1]), true);
  assert.equal(s.deleteThread(ids[1]), false);
  assert.equal(s.threadMessages(ids[1]).length, 0);
  assert.equal(s.editThread("nope", { title: "x" }), undefined);
  const long = "제목".repeat(1000); // 사용자가 붙인 대화 이름은 자르지 않는다
  assert.equal(s.createThread({ title: long }).title, long);
  assert.equal(s.editThread(ids[0], { title: `${long}!` })?.title, `${long}!`);
});

function setup(converse: Converse) {
  const cfg = { ...loadConfig(), repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" };
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  const agent = new Agent(cfg, store, bus, undefined, { converse, git: async () => [] });
  return { agent, store, bus };
}

test("HTTP: /chat/threads 목록·만들기·이름·보관·삭제·메시지, /chat threadId·kind, CSRF·400·404, SSE threads", async () => {
  const s = setup(async (_c, _s, history, text) => ({ reply_md: `답(${history.length}):${text}`, bubble: "", show: null, proposals: [] }));
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  await s.bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true,
    chat: (text, o) => s.agent.chat(text, o ?? {}), todoExists: (id) => !!s.store.getTodo(id), chatHistory: () => s.store.chatHistory(),
    chatThreads: {
      list: (o) => s.agent.threads(o), create: (t) => s.agent.createThread(t), edit: (id, p) => s.agent.editThread(id, p),
      remove: (id) => s.agent.deleteThread(id), messages: (id, o) => s.agent.threadMessages(id, o),
    },
  });
  const base = `http://127.0.0.1:${(s.bus.server!.address() as any).port}`;
  const post = (path: string, body?: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
  const ac = new AbortController();
  const sse = await fetch(`${base}/events`, { signal: ac.signal });
  const reader = sse.body!.getReader();
  let buf = "";
  try {
    // CSRF
    assert.equal((await post("/chat/threads", {}, {})).status, 403);
    assert.equal((await post("/chat/threads", {}, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/chat", { text: "hi" }, {})).status, 403);

    // threadId 없이 → 새 스레드, 답은 그 스레드로
    const r1 = await post("/chat", { text: "내 이름은 테스트야" });
    assert.equal(r1.status, 202);
    const a = await r1.json() as any;
    assert.ok(a.chatId && a.threadId);
    await s.agent.chatIdle();
    const hv = await (await post("/chat", { text: "호버에서", kind: "hover" })).json() as any;
    await s.agent.chatIdle();
    const b = await (await post("/chat", { text: "내 이름 뭐라고 했지?", threadId: hv.threadId })).json() as any;
    await s.agent.chatIdle();
    assert.equal(b.threadId, hv.threadId);
    const mb = await get(`/chat/threads/${hv.threadId}/messages`);
    assert.equal(mb.status, 200);
    assert.equal(mb.body.thread.kind, "hover");
    assert.deepEqual(mb.body.messages.map((m: any) => m.text), ["호버에서", "답(0):호버에서", "내 이름 뭐라고 했지?", "답(2):내 이름 뭐라고 했지?"]);
    assert.equal(mb.body.more, false);
    const page = await get(`/chat/threads/${hv.threadId}/messages?limit=1&before=${mb.body.messages[3].n}`);
    assert.deepEqual([page.body.messages.map((m: any) => m.text), page.body.more], [["내 이름 뭐라고 했지?"], true]);

    // 400·404
    for (const bad of [{ text: "x", threadId: 3 }, { text: "x", threadId: "../x" }, { text: "x", kind: "todo" }]) assert.equal((await post("/chat", bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post("/chat", { text: "x", threadId: "nope" })).status, 404);
    assert.equal((await get("/chat/threads/nope/messages")).status, 404);
    for (const q of ["limit=0", "limit=201", "limit=x", "before=nope", "archived=2"]) assert.equal((await get(`/chat/threads?${q}`)).status, 400, q);
    assert.equal((await get(`/chat/threads/${a.threadId}/messages?before=-1`)).status, 400);

    // 목록: 최근 순
    const list = await get("/chat/threads?limit=10");
    assert.deepEqual(list.body.threads.map((t: any) => [t.title, t.kind]), [["호버에서", "hover"], ["내 이름은 테스트야", "chat"]]);

    // 만들기: chat(제목 기본값) · todo(그 할 일의 스레드, 다시 씀) · 없는 할 일 404 · 잘못된 kind 400
    const c1 = await post("/chat/threads", {});
    assert.equal(c1.status, 201);
    const nt = (await c1.json() as any).thread;
    assert.deepEqual([nt.title, nt.kind, nt.count], ["새 대화", "chat", 0]);
    const td = (await (await post("/chat/threads", { kind: "todo", todoId: "mail:1" })).json() as any).thread;
    assert.deepEqual([td.title, td.kind, td.todoId], ["할 일: 견적 회신", "todo", "mail:1"]);
    assert.equal((await (await post("/chat/threads", { todoId: "mail:1" })).json() as any).thread.id, td.id);
    assert.equal((await post("/chat/threads", { kind: "todo", todoId: "nope" })).status, 404);
    for (const bad of [{ kind: "x" }, { kind: "todo" }, { title: "" }]) assert.equal((await post("/chat/threads", bad)).status, 400, JSON.stringify(bad));

    // 이름·보관
    const ren = await post(`/chat/threads/${nt.id}`, { title: "  회의 준비 " });
    assert.equal((await ren.json() as any).thread.title, "회의 준비");
    assert.equal((await post(`/chat/threads/${nt.id}`, { archived: true })).status, 200);
    assert.ok(!(await get("/chat/threads")).body.threads.some((t: any) => t.id === nt.id));
    assert.deepEqual((await get("/chat/threads?archived=1")).body.threads.map((t: any) => t.id), [nt.id]);
    for (const bad of [{}, { archived: "yes" }, { title: 3 }, { pinned: true }]) assert.equal((await post(`/chat/threads/${nt.id}`, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post("/chat/threads/nope", { title: "x" })).status, 404);
    // 보관한 스레드에 말하면 다시 꺼낸다
    await post("/chat", { text: "다시", threadId: nt.id });
    await s.agent.chatIdle();
    assert.equal(s.store.thread(nt.id)!.archived, false);

    // 삭제
    assert.equal((await post(`/chat/threads/${nt.id}/delete`)).status, 200);
    assert.equal((await post(`/chat/threads/${nt.id}/delete`)).status, 404);
    assert.equal((await get(`/chat/threads/${nt.id}/messages`)).status, 404);

    // SSE: chat 이벤트에 threadId, threads 신호(새 스레드·삭제)
    while (!buf.includes(`"deleted":"${nt.id}"`)) buf += new TextDecoder().decode((await reader.read()).value);
    assert.match(buf, new RegExp(`event: chat\\ndata: \\{"chatId":"${a.chatId}","threadId":"${a.threadId}","status":"thinking"`));
    assert.match(buf, /event: threads\ndata: \{"thread":\{"id":"[\w-]+","title":"내 이름은 테스트야"/);
  } finally {
    ac.abort();
    s.bus.close();
  }
});
