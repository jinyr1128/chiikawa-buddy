// 확인 후 실행하는 쓰기 동작(시험용 종류 note_add — 실제 종류는 비어 있다): 검증 · 실행 가드 · 멱등 확인 · 만료 · 취소 · 라우트/CSRF · 채팅/팝오버/DM 카드
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Actions, TYPES, actionBubbleOf, actionStatusLine, cardLine, isApprovedCall, kstWhen, meetingsContext, onceGuard, parseProposal, type ActionType, type ExecuteCall, type ToolCall } from "./actions.ts";
import { RunRegistry } from "./runs.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig } from "./config.ts";
import { CalendarSync } from "./calendar-sync.ts";
import { actionBlocks } from "./slack/blocks.ts";

const EV = "AAMkAGI2TG93AAA=";
const NOW = new Date("2026-10-12T01:00:00.000Z"); // 10:00 KST
const cfg = () => ({ ...loadConfig(), repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" });

// 시험용 확인 동작: 메모 서버(notes)의 add_note 를 승인 뒤 한 번. text 가 "bad" 면 검증 실패
type Note = { text: string; at?: string };
const noteAdd: ActionType<Note> = {
  type: "note_add",
  keys: ["type", "text", "summary"],
  parse(raw) {
    if (typeof raw.text !== "string" || !raw.text.trim()) return { ok: false, error: "text 가 비었어요" };
    return { ok: true, value: { text: raw.text.trim() } };
  },
  async verify(p, ctx) {
    if (p.text === "bad") return { ok: false, error: "그 메모는 못 남겨요" };
    return { ok: true, value: { ...p, at: ctx.now.toISOString() } };
  },
  call: (p) => ({ service: "notes", tool: "add_note", args: { text: p.text } }),
  card: (p) => ({ icon: "📝", title: `〈${p.text}〉`, verb: "남기기", question: "**메모**로 남길까요?", notice: "메모 앱에 저장돼요" }),
  result: (raw) => ((raw as any)?.error ? { ok: false, message: `저장 실패: ${(raw as any).error}` } : { ok: true, message: "메모로 남겼어요" }),
};
TYPES[noteAdd.type] = noteAdd;
const NOTE = (text = "주간 회의 준비", extra: Record<string, unknown> = {}) => ({ type: "note_add", text, ...extra });

function withMeetings(store: Store) {
  new CalendarSync(cfg(), store, { source: null }); // 표 만들기만
  const ins = store.db.prepare("INSERT INTO meetings (id, subject, start, end, fetched_at, response) VALUES (?, ?, ?, ?, '', ?)");
  ins.run(EV, "주간 회의", "2026-10-15T01:00:00.000Z", "2026-10-15T02:00:00.000Z", "notresponded");
  ins.run("AAMkOWNED00000=", "내가 연 회의", "2026-10-13T01:00:00.000Z", "2026-10-13T02:00:00.000Z", "organizer");
  ins.run("AAMkPAST000000=", "지난 회의", "2026-10-11T01:00:00.000Z", "2026-10-11T02:00:00.000Z", "accepted");
}

function harness(o: { execute?: ExecuteCall } = {}) {
  const store = new Store(":memory:");
  withMeetings(store);
  let now = NOW;
  const calls: ToolCall[] = [];
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const execute: ExecuteCall = o.execute ?? (async (_c, call) => { calls.push(call); await new Promise((r) => setTimeout(r, 20)); return { called: true, raw: { ok: true } }; });
  const actions = new Actions(cfg(), store, {
    now: () => now, execute, runs: reg,
  });
  const changes: any[] = [];
  actions.onChange = (a) => changes.push(a);
  return { store, actions, calls, reg, changes, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test("검증: 모르는 종류·모르는 키·모양이 틀린 값은 거부, 맞으면 정리", () => {
  assert.match((parseProposal({ type: "mail_send", to: "x" }) as any).error, /모르는 동작/);
  assert.match((parseProposal({ type: "calendar_respond", eventId: EV, response: "accept" }) as any).error, /모르는 동작/); // 예전 회의 응답은 없다
  assert.match((parseProposal(NOTE("x", { mailbox: "boss@x" })) as any).error, /모르는 키: mailbox/);
  assert.match((parseProposal(NOTE("  ")) as any).error, /비었어요/);
  assert.equal((parseProposal(NOTE("x".repeat(5000))) as any).ok, true);
  assert.equal(parseProposal([1]).ok, false);
  const ok = parseProposal(NOTE("  메모  ", { summary: "요약" }));
  assert.ok(ok.ok);
  assert.deepEqual((ok as any).value.params, { text: "메모" });
});

test("실행 가드: 승인된 도구·인자 그대로만, 한 번만 — 다른 인자·도구·서버는 거부", () => {
  const call: ToolCall = { service: "notes", tool: "add_note", args: { text: "a", tags: ["x"] } };
  const tool = "mcp__notes__add_note";
  assert.equal(isApprovedCall(tool, { tags: ["x"], text: "a" }, call).allow, true); // 키 순서는 상관없음
  assert.equal(isApprovedCall(tool, { text: "b", tags: ["x"] }, call).allow, false);
  assert.equal(isApprovedCall(tool, { text: "a", tags: ["x"], extra: null }, call).allow, false);
  assert.equal(isApprovedCall("mcp__notes__delete_note", call.args, call).allow, false);
  assert.equal(isApprovedCall("mcp__other__add_note", call.args, call).allow, false);
  assert.equal(isApprovedCall("Bash", { command: "curl" }, call).allow, false);
  const once = onceGuard(call);
  assert.equal(once("mcp__notes__delete_note", {}).allow, false); // 거부는 횟수에 안 셈
  assert.equal(once(tool, { ...call.args }).allow, true);
  assert.equal(once(tool, { ...call.args }).allow, false);
});

test("제안: 맞으면 대기 카드(데몬이 쓴 글), 검증 실패는 이유만, 같은 호출은 하나로·최대 3개", async () => {
  const h = harness();
  const r = await h.actions.propose([NOTE("주간 회의 준비", { summary: "모델이 쓴 요약은 카드에 안 씀" }), NOTE("bad")], { via: "chat", threadId: "t1" });
  assert.equal(r.created.length, 1);
  const a = r.created[0];
  assert.equal(a.status, "pending");
  assert.equal(a.card.title, "〈주간 회의 준비〉");
  assert.equal(a.summary, "📝 〈주간 회의 준비〉 — **메모**로 남길까요? 메모 앱에 저장돼요");
  assert.equal(a.expiresAt, "2026-10-12T01:30:00.000Z");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /준비하지 못했어요: 그 메모는 못 남겨요/);
  const many = await h.actions.propose(Array(5).fill(NOTE("같은 메모")), { via: "chat" });
  assert.equal(many.created.length, 1); // 같은 호출은 하나로, 최대 3개
  assert.match(many.errors.at(-1)!, /3개까지/);
  assert.ok(h.changes.length >= 2);
});

test("확인: 멱등(동시에 두 번 눌러도 호출 하나), 정확한 인자, run kind action", async () => {
  const h = harness();
  const { created: [a] } = await h.actions.propose([NOTE("늦을 수 있어요")], { via: "chat" });
  const [r1, r2] = await Promise.all([h.actions.confirm(a.id), h.actions.confirm(a.id)]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { service: "notes", tool: "add_note", args: { text: "늦을 수 있어요" } });
  assert.ok(r1.ok && r2.ok);
  assert.equal((r1 as any).action.status, "done");
  assert.equal((r2 as any).already, true);
  const r3 = await h.actions.confirm(a.id);
  assert.ok(r3.ok && r3.already);
  assert.equal(h.calls.length, 1);
  assert.equal(h.actions.get(a.id)!.result!.message, "메모로 남겼어요");
  assert.deepEqual(h.changes.filter((x) => x.id === a.id).map((x) => x.status), ["pending", "running", "done"]);
  const run = h.reg.listRuns({ limit: 5 }).find((x) => x.kind === "action")!;
  assert.equal(run.status, "done");
  assert.equal(run.ref, a.id);
  assert.equal(run.routine, false); // 사용자 작업
  assert.equal((await h.actions.cancel(a.id) as any).status, 409); // 끝난 건 취소 못 함
  assert.equal((await h.actions.confirm("nope") as any).status, 404);
});

test("취소·만료: 취소하면 실행 409, 30분 지나면 expired(호출 없음), 실패는 failed", async () => {
  const h = harness();
  const { created: [a, b] } = await h.actions.propose([NOTE("하나"), NOTE("둘")], { via: "chat" });
  assert.equal(h.actions.cancel(a.id).ok, true);
  assert.equal(h.actions.get(a.id)!.status, "cancelled");
  assert.equal((h.actions.cancel(a.id) as any).already, true);
  const c = await h.actions.confirm(a.id);
  assert.equal(c.ok, false);
  assert.equal((c as any).status, 409);
  h.tick(31 * 60e3);
  const expired = h.actions.expireDue();
  assert.deepEqual(expired.map((x) => x.id), [b.id]);
  assert.equal((await h.actions.confirm(b.id) as any).status, 409);
  assert.equal(h.actions.get(b.id)!.status, "expired");
  assert.equal(h.calls.length, 0);
  assert.match(actionStatusLine(h.actions.get(b.id)!), /만료/);

  const f = harness({ execute: async () => ({ called: false, error: "MCP 연결 끊김" }) });
  const { created: [x] } = await f.actions.propose([NOTE()], { via: "chat" });
  const r = await f.actions.confirm(x.id);
  assert.ok(r.ok);
  assert.equal((r as any).action.status, "failed");
  assert.match((r as any).action.result.message, /보내지 못했어요: MCP 연결 끊김/);
  assert.equal((await f.actions.confirm(x.id) as any).status, 409); // 실패한 건 다시 보내지 않는다(새로 말해야)
  const g = harness({ execute: async () => ({ called: true, raw: { error: "NotFound" } }) });
  const { created: [y] } = await g.actions.propose([NOTE()], { via: "chat" });
  assert.match(((await g.actions.confirm(y.id)) as any).action.result.message, /저장 실패: NotFound/);
});

test("데몬 재시작: 실행 중이던 건 failed 로(다시 보내지 않음)", async () => {
  const h = harness({ execute: () => new Promise(() => {}) });
  const { created: [a] } = await h.actions.propose([NOTE()], { via: "chat" });
  void h.actions.confirm(a.id);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.actions.get(a.id)!.status, "running");
  const again = new Actions(cfg(), h.store, { now: () => NOW, execute: async () => ({ called: true }), runs: h.reg });
  assert.equal(again.get(a.id)!.status, "failed");
});

test("맥락·도우미: meetingsContext 에 eventId·시간·내 응답, kstWhen", () => {
  const h = harness();
  const ctx = meetingsContext(h.store, NOW);
  assert.match(ctx, new RegExp(`eventId=${EV} \\| 10/15 목 10:00–11:00 \\| 〈주간 회의〉 \\| 내 응답: 미응답`));
  assert.doesNotMatch(ctx, /지난 회의/);
  // 표가 없어도 괜찮고, 비어 있으면 캘린더 상태 한 줄(연결 안 됨)을 적는다
  assert.match(meetingsContext(new Store(":memory:"), NOW), /^## 다가오는 회의 \(오늘·내일\)\n\(캘린더가 연결돼 있지 않다/);
  assert.equal(kstWhen("2026-10-15T01:00:00.000Z"), "10/15 목 10:00");
});

test("실행 run 의 원래 화면: 팝오버 카드 → 그 할 일(+스레드), 채팅 카드 → 그 대화, 대화 없으면 없음", async () => {
  const h = harness();
  h.store.upsertTodo({ id: "mail:1", title: "주간 회의 초대", source: "mail", priority: 2 });
  const todoThread = h.store.createThread({ title: "할 일: 주간 회의 초대", kind: "todo", todoId: "mail:1" });
  const chatThread = h.store.createThread({ title: "회의 얘기" });
  const prop = (via: "todo" | "chat" | "slack", threadId?: string) => h.actions.propose([NOTE(via)], { via, ...(threadId ? { threadId } : {}) });
  const [a] = (await prop("todo", todoThread.id)).created;
  const [b] = (await prop("chat", chatThread.id)).created;
  const [c] = (await prop("slack")).created;
  for (const x of [a, b, c]) await h.actions.confirm(x.id);
  const origin = (id: string) => h.reg.listRuns().find((r) => r.kind === "action" && r.ref === id)!.origin;
  assert.deepEqual(origin(a.id), { type: "todo", todoId: "mail:1", threadId: todoThread.id });
  assert.deepEqual(origin(b.id), { type: "thread", threadId: chatThread.id });
  assert.equal(origin(c.id), undefined);
});

// ── Agent 경로: 채팅·호버·팝오버·DM, 라우트·CSRF ──

function agentSetup(o: { converse?: any; askTodo?: any; think?: any; execute?: ExecuteCall } = {}) {
  const store = new Store(":memory:");
  withMeetings(store);
  const bus = new Bus();
  bus.setMood = () => {};
  const sse: any[] = [];
  (bus as any).send = (event: string, data: unknown) => sse.push([event, data]);
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  const posts: any[] = [], updates: any[] = [];
  let n = 0;
  const slack: SlackPort = {
    post: async (blocks, text, thread) => { posts.push({ blocks, text, thread }); return { channel: "D1", ts: String(++n) }; },
    update: async (_c, ts, blocks, text) => { updates.push({ ts, blocks, text }); },
  };
  const calls: ToolCall[] = [];
  const agent = new Agent(cfg(), store, bus, slack, {
    git: async () => [], ...(o.converse ? { converse: o.converse } : {}), ...(o.askTodo ? { askTodo: o.askTodo } : {}), ...(o.think ? { think: o.think } : {}),
    actions: { now: () => NOW, runs: new RunRegistry(new DatabaseSync(":memory:")),
      execute: o.execute ?? (async (_c, call) => { calls.push(call); return { called: true, raw: { ok: true } }; }) },
  });
  return { agent, store, bus, sse, bubbles, posts, updates, calls };
}

const reply = (extra: Record<string, unknown> = {}) => ({ reply_md: "메모 카드를 띄웠어요", bubble: "카드", show: null, proposals: [], todo_ops: [], rule: null, ...extra });

test("채팅: actions → 답 아래 카드(msgN), done 이벤트에 카드, 스레드 말에 actions, 실행하면 기록 한 줄", async () => {
  const s = agentSetup({ converse: async () => reply({ actions: [NOTE("주간 회의 준비", { summary: "메모" }), NOTE("bad")] }) });
  const sent = s.agent.chat("회의 준비 메모해줘") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  assert.equal(done.actions.length, 1);
  const msgs = s.agent.threadMessages(sent.threadId)!;
  const answer = msgs.messages.find((m) => m.role === "assistant")!;
  assert.match(answer.text, /⚠️ 요청한 동작은 준비하지 못했어요: 그 메모는 못 남겨요/);
  assert.equal(done.actions[0].msgN, answer.n);
  assert.deepEqual(msgs.actions.map((a) => [a.id, a.msgN, a.status]), [[done.actions[0].id, answer.n, "pending"]]);
  assert.ok(s.sse.some(([e, d]) => e === "action" && d.action.id === done.actions[0].id));
  const bub = s.bubbles.filter((b) => b.actions === "action"); // 패널 대화도 캐릭터 말풍선 [실행]/[취소] — 한 번만
  assert.deepEqual(bub.map((b) => [b.id, b.actionId, b.kind]), [[`action:${done.actions[0].id}`, done.actions[0].id, "proposal"]]);
  assert.deepEqual(bub[0].open, { section: "chat", id: sent.threadId });
  assert.equal(s.calls.length, 0); // 절대 자동 실행 안 함
  await s.agent.confirmAction(done.actions[0].id);
  assert.equal(s.calls.length, 1);
  const after = s.agent.threadMessages(sent.threadId)!;
  assert.match(after.messages.at(-1)!.text, /✅ 메모로 남겼어요 — 〈주간 회의 준비〉/);
  assert.equal(after.actions[0].status, "done");
});

test("캐릭터 대화(hover): ✓/✗ 말풍선 카드 → 실행하면 같은 말풍선이 결과로", async () => {
  const s = agentSetup({ converse: async () => reply({ actions: [NOTE("거절 메모")] }) });
  s.agent.chat("메모 남겨줘", { kind: "hover" });
  await s.agent.chatIdle();
  const card = s.bubbles.find((b) => b.actions === "action");
  assert.equal(card.kind, "proposal");
  assert.match(card.text, /\*\*메모\*\*로 남길까요\? 메모 앱에 저장돼요/);
  const r = await s.agent.confirmAction(card.actionId);
  assert.ok(r.ok);
  const last = s.bubbles.filter((b) => b.id === card.id).at(-1);
  assert.equal(last.kind, "done");
  assert.equal(last.actions, undefined);
  assert.match(last.text, /✅ 메모로 남겼어요/);
});

test("할 일 팝오버: actions → 응답에 카드, 그 할 일 대화의 답에 붙음", async () => {
  const s = agentSetup({ askTodo: async () => ({ reply: "남길까요?", todo_ops: [], rule: null, actions: [NOTE("초대 응답 메모")] }) });
  const t = s.agent.addTodo({ title: "주간 회의 초대 응답" });
  const r = await s.agent.askTodo(t.id, "메모해줘");
  assert.equal(r!.actions.length, 1);
  assert.equal(r!.actions[0].via, "todo");
  assert.equal(r!.actions[0].threadId, r!.threadId);
  const msgs = s.agent.threadMessages(r!.threadId)!;
  assert.equal(r!.actions[0].msgN, msgs.messages.find((m) => m.role === "assistant")!.n);
  assert.equal(s.calls.length, 0);
});

test("Slack DM: 실행/취소 버튼 카드를 올리고, 실행하면 그 메시지가 결과로 바뀐다(정기 브리핑은 제안 못 함)", async () => {
  const thought = (actions: unknown[]) => ({ bubble: "b", reply_md: "카드 올렸어요", todos: [], done_todo_ids: [], proposals: [], todo_ops: [], rule: null, actions });
  const s = agentSetup({ think: async (_c: any, _s: any, task: string) => thought(task.startsWith("정기") ? [NOTE("브리핑 메모")] : [NOTE("DM 메모")]) });
  await s.agent.handleRequest("메모 남겨줘", "111.1");
  const card = s.posts.find((p) => JSON.stringify(p.blocks).includes("cy_action:confirm"));
  assert.ok(card);
  assert.equal(card.thread, "111.1");
  const id = card.blocks[1].elements[0].value;
  assert.equal(s.agent.getAction(id)!.via, "slack");
  await s.agent.confirmAction(id);
  const upd = s.updates.filter((u) => u.ts === "2");
  assert.ok(upd.some((u) => /보내는 중/.test(JSON.stringify(u.blocks))));
  assert.match(JSON.stringify(upd.at(-1).blocks), /✅ 메모로 남겼어요/);
  assert.doesNotMatch(JSON.stringify(upd.at(-1).blocks), /cy_action:confirm/); // 버튼 걷힘
  const before = s.agent.listActions().length;
  await s.agent.runBriefing();
  assert.equal(s.agent.listActions().length, before); // 정기 브리핑의 actions 는 무시
});

test("Slack 블록: 대기면 [실행]/[취소], 처리되면 결과 한 줄", () => {
  const card = { icon: "📅", title: "〈주간 회의〉", when: "10/15 목 10:00", verb: "수락", question: "**수락**으로 응답할까요?", notice: "주최자에게 알림이 가요", comment: "참석" };
  const base = { id: "a1", type: "calendar_respond", summary: cardLine(card), card, via: "slack" as const, created: "", expiresAt: "" };
  const p = actionBlocks({ ...base, status: "pending" });
  assert.match(p[0].text.text, /📅 \*〈주간 회의〉\* \(10\/15 목 10:00\)\n\*수락\*으로 응답할까요\? 주최자에게 알림이 가요\n> 메모: 참석/);
  assert.deepEqual(p[1].elements.map((e: any) => [e.action_id, e.value]), [["cy_action:confirm", "a1"], ["cy_action:cancel", "a1"]]);
  const d = actionBlocks({ ...base, status: "cancelled" });
  assert.equal(d.some((b) => b.type === "actions"), false);
  assert.match(d[1].elements[0].text, /취소했어요/);
});

test("HTTP: /actions 목록·하나·confirm·cancel, CSRF 403, 404·409·400", async () => {
  const s = agentSetup();
  const { created: [a, b] } = await s.agent.actions.propose([NOTE("하나"), NOTE("둘")], { via: "chat", threadId: "t1" });
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    actions: { list: (o) => s.agent.listActions(o), get: (id) => s.agent.getAction(id), confirm: (id) => s.agent.confirmAction(id), cancel: (id) => s.agent.cancelAction(id) },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  try {
    const list = await (await fetch(`${base}/actions?threadId=t1&status=pending`)).json();
    assert.equal(list.actions.length, 2);
    assert.equal((await fetch(`${base}/actions?status=weird`)).status, 400);
    assert.equal((await fetch(`${base}/actions?limit=0`)).status, 400);
    assert.equal((await (await fetch(`${base}/actions/${a.id}`)).json()).action.id, a.id);
    assert.equal((await fetch(`${base}/actions/nope`)).status, 404);
    assert.equal((await post(`/actions/${a.id}/confirm`, {})).status, 403);
    assert.equal((await post(`/actions/${a.id}/confirm`, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal(s.calls.length, 0);
    const ok = await post(`/actions/${a.id}/confirm`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.action.status, "done");
    assert.equal((await (await post(`/actions/${a.id}/confirm`)).json()).already, true);
    assert.equal(s.calls.length, 1);
    assert.equal((await post(`/actions/${b.id}/cancel`)).status, 200);
    const again = await post(`/actions/${b.id}/confirm`);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).action.status, "cancelled");
    assert.equal((await post(`/actions/nope/confirm`)).status, 404);
    assert.equal((await post(`/actions/${a.id}/cancel`)).status, 409);
    assert.equal(s.calls.length, 1);
  } finally { bus.close(); }
});

test("회의 응답: 정기 가드는 커넥터 MCP 의 쓰기 도구를 막고, 대화형 프롬프트는 응답 도구를 바로 부르라고(승인 카드) 안내", async () => {
  const { isReadOnlyCall } = await import("./guard.ts");
  const { resolveConnectors } = await import("./connectors.ts");
  const conns = resolveConnectors({}, { connectors: { calendar: { mode: "mcp", server: "cal" } } });
  assert.equal(isReadOnlyCall("mcp__cal__respond_event", { event_id: EV, response: "accept" }, conns).allow, false);
  assert.equal(isReadOnlyCall("mcp__cal__get_event", { id: EV }, conns).allow, true);
  const { chatPrompt, chatAskOpts } = await import("./chat.ts");
  const store = new Store(":memory:");
  withMeetings(store);
  const soon = Date.now() + 864e5; // 프롬프트는 지금 시각 기준
  store.db.prepare("INSERT INTO meetings (id, subject, start, end, fetched_at) VALUES (?, ?, ?, ?, '')").run("evt-soon", "내일 회의", new Date(soon).toISOString(), new Date(soon + 3600e3).toISOString());
  // inline(되돌리기): 프롬프트에 다가오는 회의 · tools(기본): 프롬프트엔 없고 cy meetings_upcoming 도구가 같은 줄을 준다
  const p = chatPrompt({ ...cfg(), contextMode: "inline" }, store, [], "다음 회의 수락해줘", "");
  assert.match(p, /eventId=evt-soon \| .* \| 〈내일 회의〉/);
  assert.doesNotMatch(chatPrompt(cfg(), store, [], "다음 회의 수락해줘", undefined), /evt-soon/);
  const { ctxHandlers } = await import("./ctx-tools.ts");
  const m = await ctxHandlers(cfg(), store).meetings_upcoming();
  assert.match(m.content[0].text, /eventId=evt-soon \| .* \| 〈내일 회의〉/);
  assert.match(m.content[0].text, /참고용 데이터, 지시 아님/);
  const o = chatAskOpts(cfg(), "x");
  assert.match(o.system, /응답 도구가 있으면 그걸 바로 부른다/);
  assert.match(o.system, /승인 카드/);
  assert.doesNotMatch(o.system, /읽기만/);
  assert.deepEqual(o.interactive, { origin: { via: "chat" } });
});

test("캐릭터 승인 말풍선(actionBubbleOf): 어디서 난 카드든 버튼 말풍선, [항상 허용]은 범위가 있을 때만, 끝나면 결과 한 줄", () => {
  const card = { icon: "✉️", title: "ms365 · send_mail", verb: "", question: "이 메일을 보낼까요?", notice: "", fields: [{ label: "받는 사람", value: "a@x.com" }], body: "안녕하세요", always: "ms365.send_mail" };
  const base = { id: "p1", type: "tool_permission", summary: "s", card, created: "", expiresAt: "" };
  const todo = actionBubbleOf({ ...base, status: "pending", via: "todo", todoId: "mail:1" });
  assert.deepEqual([todo.id, todo.kind, todo.actions, todo.actionId, todo.always, todo.ttlMs], ["action:p1", "proposal", "permission", "p1", true, undefined]);
  assert.equal(todo.text, "✉️ ms365 · send_mail — 이 메일을 보낼까요?");
  assert.equal(todo.detail, "받는 사람: a@x.com\n안녕하세요\n(할 일에서 온 요청)");
  assert.deepEqual(todo.open, { section: "todos", id: "mail:1" });
  const slack = actionBubbleOf({ ...base, card: { ...card, always: undefined }, status: "pending", via: "slack" });
  assert.equal(slack.always, undefined); // 범위 없으면 [항상 허용] 없음
  assert.match(slack.detail!, /Slack DM에서 온 요청/);
  assert.equal(slack.open, undefined);
  const hover = actionBubbleOf({ ...base, status: "pending", via: "hover" });
  assert.doesNotMatch(hover.detail!, /에서 온 요청/);
  const done = actionBubbleOf({ ...base, status: "done", via: "chat", result: { ok: true, message: "허용했어요" } });
  assert.deepEqual([done.kind, done.actions, done.text], ["done", undefined, "✅ 허용했어요 — ms365 · send_mail"]);
  const cal = { icon: "📅", title: "〈주간 회의〉", when: "10/15 목 10:00", verb: "수락", question: "**수락**으로 응답할까요?", notice: "주최자에게 알림이 가요", comment: "참석" };
  const c = actionBubbleOf({ id: "c1", type: "calendar_respond", summary: cardLine(cal), card: cal, status: "pending", via: "slack", created: "", expiresAt: "" });
  assert.deepEqual([c.actions, c.always, c.text], ["action", undefined, cardLine(cal)]);
  assert.match(c.detail!, /^메모: 참석\n\(Slack DM에서 온 요청\)$/);
});

test("버스: 기다리는 버튼 말풍선은 다시 붙은 오버레이에도(결정·걷힘 전까지), 최근 3개 밖이어도", async () => {
  const bus = new Bus();
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const replay = async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    const until = Date.now() + 300;
    while (Date.now() < until && !text.includes("event: bubble\ndata: {\"id\":\"i4\"")) {
      const r = await Promise.race([reader.read(), new Promise<any>((ok) => setTimeout(() => ok({ value: undefined }), 50))]);
      if (r.value) text += new TextDecoder().decode(r.value);
    }
    ac.abort();
    return [...text.matchAll(/event: bubble\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).id);
  };
  try {
    bus.bubble({ id: "action:a", text: "허용할까요?", kind: "proposal", actions: "permission", actionId: "a" });
    bus.bubble({ id: "action:b", text: "실행할까요?", kind: "proposal", actions: "action", actionId: "b" });
    for (const i of [1, 2, 3, 4]) bus.bubble({ id: `i${i}`, text: "x", kind: "info" });
    assert.deepEqual(await replay(), ["action:a", "action:b", "i2", "i3", "i4"]);
    bus.bubble({ id: "action:a", text: "✅ 허용했어요", kind: "done" }); // 결정 → 기다림에서 빠짐(결과는 최근 목록으로)
    bus.clear("action:b");
    bus.bubble({ id: "i4", text: "x", kind: "info" });
    assert.deepEqual(await replay(), ["i3", "action:a", "i4"]);
  } finally { await bus.close?.(); }
});
