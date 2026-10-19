// 대화 동시 실행: 스레드가 다르면 동시에, 같은 스레드는 한 번에 하나씩, 같은 레포를 고치려 하면 뒤의 답이 기다린다(repo-lock.ts).
// 진짜 SDK 는 부르지 않는다 — 가짜 converse 가 훅 입력(PreToolUse)을 흉내 내 승인 브로커를 직접 부른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { Chat, repoWaitReason, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";
import { RepoLocks } from "./repo-lock.ts";
import { PermissionBroker, PermissionRules, writeRepo, LOCK_TIMEOUT_WHY, type PermCtx, type PermQueue } from "./permissions.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";

const root = mkdtempSync(join(tmpdir(), "cy-conc-"));
const repo = join(root, "ax", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
const brain = join(root, "brain");
const pctx = (o: Partial<PermCtx> = {}): PermCtx => ({ roots: [join(root, "ax")], brainDir: brain, cwd: repo, localAuto: true, ...o });
const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "/x", cwd: repo, tool_use_id: "tu" }) as any;
const decision = (o: any) => o?.hookSpecificOutput?.permissionDecision;
const reasonOf = (o: any) => String(o?.hookSpecificOutput?.permissionDecisionReason ?? "");
const tick = () => new Promise((r) => setTimeout(r, 1));
const waitFor = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };
const reply = (t: string): ChatReply => ({ reply_md: t, bubble: "", show: null, proposals: [] });
const sent = (r: ReturnType<Chat["send"]>) => { if ("error" in r) throw new Error(r.error); return r; };
const noQueue: PermQueue = { requestPermission() { throw new Error("카드는 안 뜬다(로컬 자동 허용)"); } };

// 손으로 여는 문: open(text) 하면 그 말의 답이 끝난다
function gates() {
  const m = new Map<string, () => void>();
  const started: string[] = [];
  const wait = (text: string) => { started.push(text); return new Promise<void>((res) => m.set(text, res)); };
  const open = async (text: string) => { await waitFor(() => m.has(text)); m.get(text)!(); };
  return { wait, open, started };
}

function setup(converse: Converse, locks = new RepoLocks()) {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], moods: boolean[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
    mood: (b) => moods.push(b),
  }, converse, undefined, locks);
  return { store, chat, events, moods, locks };
}

test("동시: 다른 스레드의 말은 앞 답을 기다리지 않고 바로 돈다(queued 없음) — 캐릭터는 마지막 답이 끝날 때까지 바쁨", async () => {
  const g = gates();
  let running = 0, max = 0;
  const s = setup(async (_c, _s, _h, text) => { running++; max = Math.max(max, running); await g.wait(text); running--; return reply(`답:${text}`); });
  const a = sent(s.chat.send("A 질문"));
  const b = sent(s.chat.send("B 질문"));
  assert.equal(b.queued, false);
  await waitFor(() => g.started.length === 2); // 둘 다 모델에 갔다
  assert.deepEqual(s.chat.runningChats().map((r) => r.threadId).sort(), [a.threadId, b.threadId].sort());
  assert.deepEqual(s.chat.queueState(), []);
  assert.deepEqual(s.moods, [true]); // 두 답이 돌아도 바쁨은 한 번
  await g.open("B 질문"); // 뒤에 보낸 게 먼저 끝나도 된다
  await waitFor(() => s.events.some((e) => e.chatId === b.chatId && e.status === "done"));
  assert.deepEqual(s.moods, [true], "A 가 아직 도니 한가해지지 않는다");
  await g.open("A 질문");
  await s.chat.idle();
  assert.equal(max, 2);
  assert.deepEqual(s.moods, [true, false]);
  assert.deepEqual(s.events.filter((e) => e.chatId === b.chatId).map((e) => e.status), ["thinking", "done"]);
});

test("동시: 같은 스레드는 그대로 한 번에 하나씩 — 차례(position)·ahead 는 그 스레드 안에서, GET /chat/queue 모양", async () => {
  const g = gates();
  const s = setup(async (_c, _s, _h, text) => { await g.wait(text); return reply(`답:${text}`); });
  const a = sent(s.chat.send("A1"));
  const x = sent(s.chat.send("X1")); // 다른 스레드 — 바로
  const a2 = sent(s.chat.send("A2", { threadId: a.threadId }));
  const a3 = sent(s.chat.send("A3", { threadId: a.threadId }));
  const x2 = sent(s.chat.send("X2", { threadId: x.threadId }));
  assert.deepEqual([a2.queued, a2.position, a3.position, x2.position], [true, 1, 2, 1]);
  await waitFor(() => g.started.length === 2);
  assert.deepEqual(g.started.sort(), ["A1", "X1"]);
  const q = s.chat.queueState();
  assert.deepEqual(q.map((e) => [e.text, e.position, e.waitFor, e.ahead?.text, e.reason]), [
    ["A2", 1, "thread", "A1", "앞 답(“A1”)이 끝나면 보내요"],
    ["A3", 2, "thread", "A1", "앞 답(“A1”)이 끝나면 보내요"],
    ["X2", 1, "thread", "X1", "앞 답(“X1”)이 끝나면 보내요"],
  ]);
  for (const k of ["chatId", "threadId", "text", "queuedAt", "position", "waitFor", "reason"]) assert.ok(k in q[0], k);
  for (const k of ["chatId", "threadId", "text", "sentAt"]) assert.ok(k in s.chat.runningChats()[0], k);
  await g.open("X1"); await g.open("X2");
  await g.open("A1"); await g.open("A2"); await g.open("A3");
  await s.chat.idle();
  assert.deepEqual(s.store.threadMessages(a.threadId).map((m) => m.text), ["A1", "답:A1", "A2", "답:A2", "A3", "답:A3"]);
});

test("동시: 멈춤은 그 스레드의 답만 — 다른 스레드 답·지금 보내기도 다른 스레드는 건드리지 않는다", async () => {
  const g = gates();
  const s = setup(async (_c, _s, _h, text, _o, _sum, _f, _t, _m, abort) => {
    await Promise.race([g.wait(text), new Promise<void>((_r, rej) => abort?.signal.addEventListener("abort", () => rej(new Error("멈췄어요"))))]);
    return reply(`답:${text}`);
  });
  const a = sent(s.chat.send("A"));
  const b = sent(s.chat.send("B"));
  const a2 = sent(s.chat.send("A 다음", { threadId: a.threadId }));
  await waitFor(() => g.started.length === 2);
  assert.equal(s.chat.stop(a.chatId), true);
  await waitFor(() => g.started.includes("A 다음"));
  assert.ok(s.events.some((e) => e.chatId === a.chatId && e.status === "stopped"));
  assert.equal(s.events.some((e) => e.chatId === b.chatId && e.status === "stopped"), false);
  // 지금 보내기: 같은 스레드에서만 멈춘다
  const b2 = sent(s.chat.send("B 다음", { threadId: b.threadId }));
  assert.equal(s.chat.sendNow(b2.chatId), true);
  await waitFor(() => g.started.includes("B 다음"));
  assert.ok(s.events.some((e) => e.chatId === b.chatId && e.status === "stopped"));
  assert.equal(s.events.some((e) => e.chatId === a2.chatId && e.status === "stopped"), false);
  await g.open("A 다음"); await g.open("B 다음");
  await s.chat.idle();
  assert.deepEqual(s.chat.pending(), []);
});

test("레포 잠금: 같은 레포에 쓰려던 뒤 답은 「앞 대화(…)가 같은 레포(app)를 고치는 중이라 기다려요」로 기다렸다가, 앞 답이 끝나면 이어서", async () => {
  const locks = new RepoLocks();
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), noQueue, undefined, locks);
  const g = gates();
  const order: string[] = [];
  let n = 0;
  // 한 답 = run 하나: 훅으로 Edit 을 부르고(처음 쓸 때 잠금), 끝나면 brain.ts ask 처럼 run 의 잠금을 푼다
  const s = setup(async (_c, _s, _h, text, _o, _sum, _f, threadId) => {
    const runId = `run-${++n}`;
    try {
      const out = await broker.hook(pctx(), { via: "chat", threadId, runId })(pre("Edit", { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" }), "tu", { signal: new AbortController().signal });
      assert.equal(decision(out), "allow");
      order.push(`${text}:쓰기`);
      await g.wait(text);
      return reply(`답:${text}`);
    } finally { locks.release(runId); }
  }, locks);
  const a = sent(s.chat.send("버튼 색 바꿔줘"));
  await waitFor(() => order.length === 1);
  const b = sent(s.chat.send("README 고쳐줘"));
  assert.equal(b.queued, false); // 다른 스레드라 바로 모델에 — 쓰려는 순간에 기다린다
  await waitFor(() => s.events.some((e) => e.chatId === b.chatId && e.status === "queued"));
  const q = s.events.find((e) => e.chatId === b.chatId && e.status === "queued") as any;
  assert.equal(q.waitFor, "repo");
  assert.equal(q.repo, "app");
  assert.equal(q.reason, "앞 대화(“버튼 색 바꿔줘”)가 같은 레포(app)를 고치는 중이라 기다려요");
  assert.equal(q.reason, repoWaitReason("버튼 색 바꿔줘", repo));
  assert.deepEqual(q.ahead, { chatId: a.chatId, threadId: a.threadId, text: "버튼 색 바꿔줘" });
  const held = s.chat.runningChats().find((r) => r.chatId === b.chatId)!;
  assert.equal(held.held?.repo, "app");
  assert.equal(held.held?.reason, q.reason);
  assert.deepEqual(order, ["버튼 색 바꿔줘:쓰기"]);
  await g.open("버튼 색 바꿔줘");
  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["버튼 색 바꿔줘:쓰기", "README 고쳐줘:쓰기"]);
  assert.equal(s.chat.runningChats().find((r) => r.chatId === b.chatId)?.held, undefined);
  await g.open("README 고쳐줘");
  await s.chat.idle();
  assert.deepEqual(s.events.filter((e) => e.chatId === b.chatId).map((e) => e.status), ["thinking", "queued", "thinking", "done"]);
  assert.equal(locks.holder(repo), undefined);
});

test("레포 잠금: 읽기만 하는 답·레포 없는 답(brain)은 서로 막지 않는다 — 같은 run 은 다시 잡아도 통과", async () => {
  const locks = new RepoLocks();
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), noQueue, undefined, locks);
  const sig = { signal: new AbortController().signal };
  // A 가 레포를 고치는 중
  const w = await broker.hook(pctx(), { via: "chat", threadId: "A", runId: "rA" })(pre("Write", { file_path: join(repo, "x.md"), content: "x" }), "tu", sig);
  assert.equal(decision(w), "allow");
  assert.equal(locks.holder(repo)?.key, "rA");
  // B: 같은 레포라도 읽기는 기다리지 않는다
  for (const [tool, input] of [["Read", { file_path: join(repo, "x.md") }], ["Bash", { command: "git status" }], ["Grep", { pattern: "x" }]] as const) {
    const o = await broker.hook(pctx(), { via: "chat", threadId: "B", runId: "rB" })(pre(tool, input), "tu", sig);
    assert.equal(decision(o), "allow", tool);
  }
  // C: 레포 없는 대화(cwd brain)는 쓰기여도 잠그지 않는다
  const c = await broker.hook(pctx({ cwd: brain }), { via: "chat", threadId: "C", runId: "rC" })(pre("Bash", { command: "echo hi > note.txt" }), "tu", sig);
  assert.equal(decision(c), "allow");
  assert.equal(writeRepo("Bash", { command: "echo hi > note.txt" }, pctx({ cwd: brain })), undefined);
  // A 가 또 써도(서브에이전트 포함 같은 run) 바로 통과
  const again = await broker.hook(pctx(), { via: "chat", threadId: "A", runId: "rA" })(pre("Bash", { command: "npm install" }), "tu", sig);
  assert.equal(decision(again), "allow");
  assert.deepEqual(locks.waits(), []);
  locks.release("rA");
  assert.equal(locks.holder(repo), undefined);
});

test("레포 잠금: 기다리는 중 멈추면 거부(카드·쓰기 없이), 너무 오래면 이유를 담아 거부", async () => {
  const locks = new RepoLocks();
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), noQueue, undefined, locks);
  await broker.hook(pctx(), { via: "chat", threadId: "A", runId: "rA" })(pre("Edit", { file_path: join(repo, "a"), old_string: "a", new_string: "b" }), "tu", { signal: new AbortController().signal });
  const ac = new AbortController();
  const p = broker.hook(pctx(), { via: "chat", threadId: "B", runId: "rB" })(pre("Edit", { file_path: join(repo, "a"), old_string: "a", new_string: "b" }), "tu", { signal: ac.signal });
  await waitFor(() => locks.waits().length === 1);
  ac.abort();
  assert.equal(decision(await p), "deny");
  assert.deepEqual(locks.waits(), []);
  broker.lockWaitMs = 5;
  const late = await broker.hook(pctx(), { via: "chat", threadId: "C", runId: "rC" })(pre("Bash", { command: "npm test -- -u" }), "tu", { signal: new AbortController().signal });
  assert.equal(decision(late), "deny");
  assert.equal(reasonOf(late), LOCK_TIMEOUT_WHY);
  assert.equal(locks.holder(repo)?.key, "rA");
  locks.release("rA");
});

test("레포 잠금: 풀리면 먼저 기다린 순서대로 넘어가고, 서로 기다리는 원이면 기다리지 않는다", async () => {
  const l = new RepoLocks();
  assert.equal(await l.acquire("/r1", { key: "a" }), true);
  const b = l.acquire("/r1", { key: "b", threadId: "tb" });
  const c = l.acquire("/r1", { key: "c" });
  assert.deepEqual(l.waits().map((w) => [w.owner.key, w.holder.key]), [["b", "a"], ["c", "a"]]);
  l.release("a");
  assert.equal(await b, true);
  assert.equal(l.holder("/r1")?.key, "b");
  assert.deepEqual(l.waits().map((w) => [w.owner.key, w.holder.key]), [["c", "b"]]);
  // b 가 /r2 를 잡은 d 를 기다리고, d 가 /r1(b) 을 원하면 원 — d 는 그냥 지나간다
  assert.equal(await l.acquire("/r2", { key: "d" }), true);
  const bw = l.acquire("/r2", { key: "b" });
  assert.equal(await l.acquire("/r1", { key: "d" }), true);
  l.release("d");
  assert.equal(await bw, true);
  l.release("b");
  assert.equal(await c, true);
  l.release("c");
  assert.deepEqual([l.holder("/r1"), l.holder("/r2"), l.waits()], [undefined, undefined, []]);
});

// ---- 데몬 전체: 두 스레드가 동시에 돌 때 승인 카드는 제 스레드 답에만 붙는다 ----
test("동시: 두 스레드가 동시에 돌며 승인 카드를 띄워도 각자 제 답에만 붙는다(섞이지 않는다)", async () => {
  const g = gates();
  let agent!: Agent;
  const converse: Converse = async (_c, _s, _h, text, _o, _sum, _f, threadId) => {
    agent.actions.requestPermission({ toolName: "mcp__relay__invoke", card: { icon: "🔧", title: `카드:${text}`, verb: "실행", question: "?", notice: "" }, fields: [], origin: { via: "chat", threadId, runId: `run-${text}` } });
    await g.wait(text);
    return { reply_md: `답:${text}`, bubble: "", show: null, proposals: [] };
  };
  const events: ChatEvent[] = [];
  const bus = new Bus();
  bus.setMood = () => {};
  bus.chat = (ev) => { events.push(ev as ChatEvent); };
  bus.bubble = () => "x";
  agent = new Agent({ ...loadConfig(), repoRoots: [join(root, "ax")], claudeProjectsDir: "/none", codexSessionsDir: "/none" } as any, new Store(":memory:"), bus, undefined, { converse, git: async () => [], useBroker: false });
  const a = agent.chat("A 메일 보내줘") as { chatId: string; threadId: string };
  const b = agent.chat("B 일정 잡아줘") as { chatId: string; threadId: string };
  await waitFor(() => g.started.length === 2);
  await g.open("B 일정 잡아줘");
  await g.open("A 메일 보내줘");
  await agent.chatIdle();
  const done = (id: string) => events.find((e) => e.chatId === id && e.status === "done") as any;
  assert.deepEqual(done(a.chatId).actions.map((x: any) => [x.card.title, x.threadId]), [["카드:A 메일 보내줘", a.threadId]]);
  assert.deepEqual(done(b.chatId).actions.map((x: any) => [x.card.title, x.threadId]), [["카드:B 일정 잡아줘", b.threadId]]);
});
