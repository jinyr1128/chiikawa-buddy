// 말 고치기(패널 ✏️): 마지막 사용자 말만, 답하는 중이면 멈추고 다시, 줄 선 말은 글만, 뒤 답은 숨김(지우지 않음), 그 턴의 대기 카드는 취소
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ChatTurn } from "./store.ts";
import { loadConfig } from "./config.ts";
import { Chat, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";
import { Agent } from "./core.ts";
import { Bus, type BusHandlers } from "./bus.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));
const waitFor = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };
const reply = (t: string): ChatReply => ({ reply_md: t, bubble: "", show: null, proposals: [] });
const sent = (r: ReturnType<Chat["send"]>) => { if ("error" in r) throw new Error(r.error); return r; };
const ok = <T extends object>(r: T): Exclude<T, { error: string }> => { if ("error" in r) throw new Error(String((r as any).error)); return r as Exclude<T, { error: string }>; };
// 멈출 때까지 매달리는 답(text 에 "오래" 가 있으면)
const hanging: (seen: { text: string; history: ChatTurn[] }[]) => Converse = (seen) => async (_c, _s, history, text, _o, _sum, _f, _t, _m, abort) => {
  seen.push({ text, history });
  if (text.includes("오래")) await new Promise<void>((_r, rej) => abort?.signal.addEventListener("abort", () => rej(new Error("멈췄어요"))));
  return reply(`답:${text}`);
};

function setup(converse: Converse, ports: Partial<ConstructorParameters<typeof Chat>[2]> = {}) {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const chat = new Chat(loadConfig(), store, { emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined, ...ports }, converse);
  return { store, chat, events };
}
const lines = (s: Store, threadId: string) => s.threadMessages(threadId).map((m) => `${m.role}:${m.text}`);

test("고치기: 마지막 사용자 말만 — 앞 말·없는 말은 not_latest, 그 뒤에 줄 선 말이 있으면 그것이 마지막", async () => {
  const seen: { text: string; history: ChatTurn[] }[] = [];
  const s = setup(hanging(seen));
  const a = sent(s.chat.send("첫 물음"));
  await s.chat.idle();
  sent(s.chat.send("둘째 물음", { threadId: a.threadId }));
  await s.chat.idle();
  const [u1, , u2] = s.store.threadMessages(a.threadId);
  assert.deepEqual(await s.chat.edit(a.threadId, u1.n!, "고침"), { error: "not_latest" });
  assert.deepEqual(await s.chat.edit(a.threadId, 99999, "고침"), { error: "not_latest" });
  assert.deepEqual(await s.chat.edit("nope", u2.n!, "고침"), { error: "no_thread" });
  // 답하는 중 + 그 뒤에 줄 선 말 → 기록된 말은 더 이상 마지막이 아니다
  const r = sent(s.chat.send("오래 걸리는 물음", { threadId: a.threadId }));
  const q = sent(s.chat.send("줄 선 말", { threadId: a.threadId }));
  await waitFor(() => seen.some((x) => x.text === "오래 걸리는 물음"));
  const running = s.store.lastUserMessage(a.threadId)!;
  assert.deepEqual(await s.chat.edit(a.threadId, running.n!, "고침"), { error: "not_latest" });
  assert.deepEqual(s.chat.editQueued(r.chatId, "x"), { error: "not_queued" }); // 이미 도는 말은 글만 못 바꾼다
  s.chat.stop(r.chatId);
  s.chat.stop(q.chatId);
  await s.chat.idle();
});

test("고치기: 답하는 중이면 멈추고, 그 말·뒤 줄은 숨기고(기록엔 남김), 고친 글로 다시 — 모델은 숨긴 말을 못 본다", async () => {
  const seen: { text: string; history: ChatTurn[] }[] = [];
  const s = setup(hanging(seen));
  const a = sent(s.chat.send("README 봐줘"));
  await s.chat.idle();
  const r1 = sent(s.chat.send("오래 걸리는 물음: 버튼 색", { threadId: a.threadId, clientId: "c-1" }));
  await waitFor(() => seen.length === 2);
  const old = s.store.lastUserMessage(a.threadId)!;
  const e = ok(await s.chat.edit(a.threadId, old.n!, "버튼 색 파랑으로 바꿔줘", { clientId: "c-2" }));
  assert.equal(e.replaced, old.n);
  assert.equal(e.queued, false);
  assert.equal(e.clientId, "c-2");
  await s.chat.idle();
  assert.deepEqual(s.events.filter((x) => x.chatId === r1.chatId).map((x) => x.status), ["thinking", "stopped"]);
  const edited = s.events.find((x) => x.status === "edited") as any;
  assert.deepEqual([edited.chatId, edited.n, edited.text, edited.replaces], [e.chatId, old.n, "버튼 색 파랑으로 바꿔줘", r1.chatId]);
  assert.deepEqual(s.events.filter((x) => x.chatId === e.chatId).map((x) => x.status), ["thinking", "edited", "done"]);
  // 보이는 기록: 멈춘 턴(물음·"답을 멈췄어요")은 빠지고 고친 말·새 답
  assert.deepEqual(lines(s.store, a.threadId), ["user:README 봐줘", "assistant:답:README 봐줘", "user:버튼 색 파랑으로 바꿔줘", "assistant:답:버튼 색 파랑으로 바꿔줘"]);
  const now = s.store.lastUserMessage(a.threadId)!;
  assert.ok(now.edited, "「수정됨」 표시");
  assert.equal((now as any).original, undefined, "고치기 전 글은 API 로 안 나간다");
  // 기록(감사): 고치기 전 글·숨긴 줄은 store 에 남는다
  assert.deepEqual(s.store.chatOriginal(now.n!), { text: "버튼 색 파랑으로 바꿔줘", original: "오래 걸리는 물음: 버튼 색", edited: now.edited });
  assert.ok(s.store.chatOriginal(old.n!)!.hidden);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) AS c FROM chat WHERE thread_id = ?").get(a.threadId) as any).c, 6);
  // 다시 돈 턴의 모델 맥락엔 숨긴 말이 없다
  assert.deepEqual(seen.at(-1)!.history.map((t) => t.text), ["README 봐줘", "답:README 봐줘"]);
  assert.equal(s.store.thread(a.threadId)!.count, 4);
});

test("고치기: 끝난 턴이면 그 답을 숨기고 다시 — 대화 목록 미리보기·옛 /chat/history 에서도 빠진다", async () => {
  const s = setup(async (_c, _s, _h, text) => reply(`답:${text}`));
  const a = sent(s.chat.send("오늘 일정"));
  await s.chat.idle();
  const u = s.store.lastUserMessage(a.threadId)!;
  ok(await s.chat.edit(a.threadId, u.n!, "내일 일정"));
  await s.chat.idle();
  assert.deepEqual(lines(s.store, a.threadId), ["user:내일 일정", "assistant:답:내일 일정"]);
  assert.equal(s.store.thread(a.threadId)!.preview, "답:내일 일정");
  assert.deepEqual(s.store.chatHistory().map((t) => t.text), ["내일 일정", "답:내일 일정"]);
  assert.deepEqual(s.store.danglingTurns(), []);
});

test("고치기: 줄 선 말은 글만 바꾼다(차례 그대로) — 맨 뒤에 줄 선 말만", async () => {
  const seen: { text: string; history: ChatTurn[] }[] = [];
  const s = setup(hanging(seen));
  const a = sent(s.chat.send("오래 걸리는 첫 물음"));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId }));
  const c = sent(s.chat.send("셋째", { threadId: a.threadId }));
  assert.deepEqual(s.chat.editQueued(b.chatId, "둘째 고침"), { error: "not_latest" });
  assert.deepEqual(s.chat.editQueued(c.chatId, "셋째 고침"), { ok: true, chatId: c.chatId, threadId: a.threadId });
  assert.equal(s.chat.queueState().find((q) => q.chatId === c.chatId)!.text, "셋째 고침");
  const q = s.events.filter((e) => e.chatId === c.chatId).at(-1) as any;
  assert.deepEqual([q.status, q.text], ["queued", "셋째 고침"]);
  assert.ok(s.events.some((e) => e.chatId === c.chatId && e.status === "edited"));
  await waitFor(() => seen.length === 1);
  s.chat.stop(a.chatId);
  await s.chat.idle();
  assert.deepEqual(seen.map((x) => x.text), ["오래 걸리는 첫 물음", "둘째", "셋째 고침"]);
  assert.equal(s.store.lastUserMessage(a.threadId)!.text, "셋째 고침");
  assert.equal(s.store.lastUserMessage(a.threadId)!.edited, undefined); // 보내기 전에 고친 건 「수정됨」이 아니다
});

test("고치기: 그 턴이 띄운 백그라운드 에이전트가 돌면 agents_running — 멈추겠다고 하면 멈추고 고친다", async () => {
  const agents = [{ toolUseId: "toolu_1", description: "PR 점검" }];
  const stopped: string[][] = [], sinces: string[] = [];
  const s = setup(async (_c, _s, _h, text) => reply(`답:${text}`), {
    turnAgents: (_t, since) => { sinces.push(since); return stopped.length ? [] : agents; },
    stopAgents: (ids) => { stopped.push(ids); },
  });
  const a = sent(s.chat.send("에이전트로 점검해"));
  await s.chat.idle();
  const u = s.store.lastUserMessage(a.threadId)!;
  assert.deepEqual(await s.chat.edit(a.threadId, u.n!, "다시"), { error: "agents_running", agents });
  assert.deepEqual(lines(s.store, a.threadId).length, 2, "거절하면 아무것도 안 바꾼다");
  const e = ok(await s.chat.edit(a.threadId, u.n!, "다시", { stopAgents: true }));
  assert.equal(e.stoppedAgents, 1);
  assert.deepEqual(stopped, [["toolu_1"]]);
  assert.equal(sinces[0], u.at);
  await s.chat.idle();
});

// ---- 데몬: 그 턴의 아직 결정 안 된 카드는 취소, 결정된 건 기록으로 남는다 · 엔드포인트 ----
function agentSetup() {
  const events: ChatEvent[] = [];
  let agent!: Agent;
  const converse: Converse = async (_c, _s, _h, text, _o, _sum, _f, threadId) => {
    const card = (title: string) => agent.actions.requestPermission({ toolName: "mcp__relay__invoke", card: { icon: "🔧", title, verb: "실행", question: "?", notice: "" }, fields: [], origin: { via: "chat", threadId, runId: `run-${title}` } });
    if (text === "메일 두 통 보내줘") { card("메일 A"); card("메일 B"); }
    return reply(`답:${text}`);
  };
  const bus = new Bus();
  bus.setMood = () => {};
  bus.chat = (ev) => { events.push(ev as ChatEvent); };
  bus.bubble = () => "x";
  const root = mkdtempSync(join(tmpdir(), "cy-edit-"));
  agent = new Agent({ ...loadConfig(), repoRoots: [root], claudeProjectsDir: "/none", codexSessionsDir: "/none" } as any, new Store(":memory:"), bus, undefined, { converse, git: async () => [], useBroker: false });
  return { agent, events };
}

test("데몬 고치기: 그 턴의 대기 카드는 취소, 이미 결정한 카드는 그대로(제 시각 자리) — 뒤 답은 숨김", async () => {
  const s = agentSetup();
  const a = s.agent.chat("메일 두 통 보내줘") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  const cards = s.agent.actions.list({ threadId: a.threadId, limit: 10 });
  assert.equal(cards.length, 2);
  const first = cards.find((c) => c.card.title === "메일 A")!, second = cards.find((c) => c.card.title === "메일 B")!;
  await s.agent.actions.confirm(first.id); // 하나는 허용(결정됨)
  const u = s.agent.threadMessages(a.threadId)!.messages.find((m) => m.role === "user")!;
  ok(await s.agent.chatEdit(a.threadId, u.n!, "메일 한 통만 보내줘"));
  await s.agent.chatIdle();
  assert.equal(s.agent.actions.get(first.id)!.status, "done");
  assert.equal(s.agent.actions.get(second.id)!.status, "cancelled");
  const msgs = s.agent.threadMessages(a.threadId)!.messages.map((m) => `${m.role}:${m.text}`);
  assert.deepEqual(msgs, ["user:메일 한 통만 보내줘", "assistant:답:메일 한 통만 보내줘"]);
});

test("bus: POST /chat/threads/:id/messages/:n/edit · /chat/:chatId/edit — 202·404·409·400·503", async () => {
  const bus = new Bus();
  const calls: unknown[] = [];
  const handlers: Partial<BusHandlers> = {
    chatEdit: async (threadId, n, text, o) => { calls.push([threadId, n, text, o]); return threadId === "gone" ? { error: "no_thread" } : n === 1 ? { error: "not_latest" } : { chatId: "c", threadId, replaced: n }; },
    chatEditQueued: (chatId, text) => (chatId.startsWith("0") ? { ok: true, chatId, threadId: "t" } : { error: "not_queued", text }),
  };
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "x", chatHistory: () => [], ...handlers } as any);
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/chat/threads/t1/messages/5/edit", { text: "고침" }, {})).status, 403);
    const r = await post("/chat/threads/t1/messages/5/edit", { text: " 고침 ", stopAgents: true, clientId: "c-1" });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { chatId: "c", threadId: "t1", replaced: 5 });
    assert.deepEqual(calls[0], ["t1", 5, "고침", { stopAgents: true, clientId: "c-1" }]);
    assert.equal((await post("/chat/threads/t1/messages/1/edit", { text: "고침" })).status, 409);
    assert.equal((await post("/chat/threads/gone/messages/5/edit", { text: "고침" })).status, 404);
    assert.equal((await post("/chat/threads/t1/messages/5/edit", { text: " " })).status, 400);
    assert.equal((await post("/chat/threads/t1/messages/5/edit", { text: "a", stopAgents: "yes" })).status, 400);
    const id = "0b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10";
    assert.equal((await post(`/chat/${id}/edit`, { text: "새 글" })).status, 200);
    assert.equal((await post("/chat/1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10/edit", { text: "새 글" })).status, 409);
  } finally { bus.close(); }
  const none = new Bus();
  await none.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "x", chatHistory: () => [] } as any);
  try {
    const r = await fetch(`http://127.0.0.1:${(none.server!.address() as any).port}/chat/threads/t1/messages/5/edit`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ text: "a" }) });
    assert.equal(r.status, 503);
  } finally { none.close(); }
});
