import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig } from "./config.ts";
import { deterministicCompletions, detectCompletions, runAfterSlackIngest, slackRefOf, type Completion } from "./todo-auto.ts";
import { autoDoneBlocks, revertedAutoLine, todoRef } from "./slack/blocks.ts";
import { handleRevertAuto } from "./slack/app.ts";
import { buildDashboard } from "./dashboard.ts";

const ME = "UME";
const NOW = new Date("2026-10-08T06:00:00Z");
const ts = (minAgo: number, frac = "000100") => `${Math.floor(NOW.getTime() / 1000) - minAgo * 60}.${frac}`;
const iso = (t: string) => new Date(Math.round(Number(t) * 1000)).toISOString();

function msg(store: Store, ch: string, t: string, o: { me?: boolean; thread?: string; text?: string; dm?: boolean; mention?: boolean; author?: string } = {}) {
  const id = `message:${ch}:${t}`;
  store.upsertNode(id, "message", "x", {
    channel: ch, ts: t, ...(o.thread ? { thread_ts: o.thread } : {}), text: o.text ?? "…",
    author: o.me ? ME : (o.author ?? "UOTHER"), authorName: o.me ? "김지우" : "동료", isDM: o.dm ?? ch.startsWith("D"),
    mentionsMe: !!o.mention, fromMe: !!o.me,
  }, iso(t));
  return id;
}

function setup() {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  store.db.prepare("INSERT INTO slack_meta (key, value) VALUES ('teamUrl', 'https://team.slack.com/')").run();
  store.upsertNode("channel:D1", "channel", "DM with 동료", { isDM: true });
  store.upsertNode("channel:C1", "channel", "#dev", { isDM: false });
  const cfg = loadConfig();
  const bus = new Bus();
  const bubbles: any[] = [], signals: string[] = [];
  bus.bubble = (b) => { bubbles.push(b); return "b"; };
  bus.dashboardChanged = () => { signals.push("dashboard"); };
  const posts: any[] = [];
  const slack: SlackPort = {
    post: async (blocks, text) => { posts.push({ blocks, text }); return { channel: "D0", ts: "1", permalink: "https://team.slack.com/archives/D0/p1" }; },
    update: async () => {},
  };
  const agent = new Agent(cfg, store, bus, slack, { think: async () => { throw new Error("no"); }, git: async () => [] });
  const changes: number[] = [];
  agent.onChange(() => changes.push(1));
  return { store, cfg, agent, bubbles, signals, posts, changes };
}

// 가짜 모델: 프롬프트를 받아 결정 함수가 낸 completions를 돌려준다
function fakeQuery(decide: (prompt: string) => any[]) {
  const calls: string[] = [];
  const q = ((args: any) => {
    calls.push(args.prompt);
    assert.deepEqual(args.options.settingSources, []);
    assert.equal(args.options.persistSession, false);
    assert.deepEqual(args.options.tools, []);
    return (async function* () { yield { type: "result", subtype: "success", structured_output: { completions: decide(args.prompt) }, total_cost_usd: 0.01 }; })();
  }) as any;
  return { q, calls };
}
const alias = (prompt: string, needle: string) => new RegExp(`\\[(m\\d+)\\][^\\n]*${needle}`).exec(prompt)?.[1];
const todoAlias = (prompt: string, title: string) => new RegExp(`\\[(t\\d+)\\] ${title}`).exec(prompt)?.[1];

test("slackRefOf: id 우선, permalink(스레드 포함)도 해석", () => {
  assert.deepEqual(slackRefOf({ id: "slack:C1:1791446451.725529" }), { channel: "C1", ts: "1791446451.725529" });
  assert.deepEqual(slackRefOf({ id: "mail:1", link: "https://t.slack.com/archives/C9/p1791446451725529?thread_ts=1791440000.000100&cid=C9" }),
    { channel: "C9", ts: "1791446451.725529", threadTs: "1791440000.000100" });
  assert.deepEqual(slackRefOf({ id: "slack:C9:1791446451.725529", link: "https://t.slack.com/archives/C9/p1791446451725529?thread_ts=1791440000.000100&cid=C9" }),
    { channel: "C9", ts: "1791446451.725529", threadTs: "1791440000.000100" });
  assert.equal(slackRefOf({ id: "jira:X-1", link: "https://x.atlassian.net/browse/X-1" }), undefined);
});

test("결정 규칙: 같은 스레드·DM 최상위에 그 뒤 내 답이 있으면 완료, 채널 최상위 딴소리·이전 답·내 메시지 할 일은 아님", () => {
  const { store } = setup();
  // 1) 채널 스레드 안 질문 → 같은 스레드에 내 답
  const root = ts(60), q1 = ts(50);
  msg(store, "C1", root); msg(store, "C1", q1, { thread: root, mention: true }); msg(store, "C1", ts(40), { me: true, thread: root });
  // 2) DM 최상위 → 그 뒤 DM 최상위에 내 메시지
  const d1 = ts(30); msg(store, "D1", d1); msg(store, "D1", ts(29), { me: true });
  // 3) 채널 최상위 멘션 → 같은 채널 최상위에 내가 딴 얘기(스레드 답 아님)
  const c2 = ts(20); msg(store, "C1", c2, { mention: true }); msg(store, "C1", ts(19), { me: true });
  // 4) 내 답이 질문보다 먼저
  const c3 = ts(10); msg(store, "C1", ts(11), { me: true, thread: c3 }); msg(store, "C1", c3, { mention: true });
  // 5) 내가 쓴 메시지에서 나온 할 일
  const c4 = ts(8); msg(store, "C1", c4, { me: true }); msg(store, "C1", ts(7), { me: true, thread: c4 });
  for (const [id, t] of [["a", q1], ["b", d1], ["c", c2], ["d", c3], ["e", c4]] as const)
    store.upsertTodo({ id: `slack:${id === "b" ? "D1" : "C1"}:${t}`, title: id, source: "slack", priority: 2 });
  const got = deterministicCompletions(store);
  assert.deepEqual(got.map((c) => c.id).sort(), [`slack:C1:${q1}`, `slack:D1:${d1}`].sort());
  const th = got.find((c) => c.id === `slack:C1:${q1}`)!;
  assert.match(th.evidence.permalink!, /^https:\/\/team\.slack\.com\/archives\/C1\/p\d+\?thread_ts=/);
  assert.equal(th.rule, "reply");
});

test("자동 완료 적용: 말풍선·Slack 알림(되돌리기 버튼)·학습 신호·변경 알림, 패널 recentDone에 자동 표시", async () => {
  const s = setup();
  const q = ts(30); msg(s.store, "D1", q); msg(s.store, "D1", ts(29), { me: true });
  s.store.upsertTodo({ id: `slack:D1:${q}`, title: "견적 회신", source: "slack", priority: 1 });
  const { q: query, calls } = fakeQuery(() => []);
  const r = await runAfterSlackIngest(s.agent, s.cfg, s.store, { query, now: NOW, log: () => {} });
  assert.equal(r?.deterministic, 1);
  const t = s.store.getTodo(`slack:D1:${q}`)!;
  assert.equal(t.status, "done");
  assert.equal(t.doneBy, "auto");
  assert.match(t.autoEvidence!.permalink!, /archives\/D1\//);
  assert.equal(s.bubbles.at(-1).text, "'견적 회신' 끝난 걸로 처리했어요");
  assert.equal(s.bubbles.at(-1).kind, "done");
  const blocks = s.posts.at(-1).blocks;
  const line = blocks.find((b: any) => b.accessory?.action_id === "cy_todo:revert_auto");
  assert.equal(line.accessory.value, todoRef(t.id));
  assert.match(line.text.text, /근거 메시지/);
  assert.ok(s.changes.length && s.signals.includes("dashboard"));
  const fb = s.store.db.prepare("SELECT kind, ref FROM profile_feedback").all() as any[];
  assert.deepEqual(fb.map((f) => f.kind), ["todo_auto_done"]);
  assert.equal(r?.model?.skipped, "no_todos"); // 남은 할 일이 없으면 모델을 부르지 않는다
  assert.equal(calls.length, 0);
  const d = await buildDashboard(s.cfg, s.store, { git: async () => [], now: new Date() });
  const rd = d.recentDone.find((x) => x.id === t.id)!;
  assert.equal(rd.doneBy, "auto");
  assert.match(rd.autoReason!, /답장/);
  assert.match(rd.autoEvidence!, /^https:/);
  assert.equal(d.todos.some((x) => x.id === t.id), false);
});

test("되돌리기: 다시 열고 기억 — 결정 규칙·모델·브리핑 모두 다시 끝내지 않음, 학습 신호", async () => {
  const s = setup();
  const q = ts(30); msg(s.store, "D1", q); msg(s.store, "D1", ts(29), { me: true });
  const id = `slack:D1:${q}`;
  s.store.upsertTodo({ id, title: "견적 회신", source: "slack", priority: 1 });
  await s.agent.autoCompleteTodos(deterministicCompletions(s.store));
  assert.equal(s.store.getTodo(id)!.status, "done");
  const r = s.agent.revertAutoTodo(id);
  assert.equal(typeof r === "object" && r.status, "open");
  assert.equal(s.agent.revertAutoTodo(id), "not_auto");
  assert.equal(s.agent.revertAutoTodo("nope"), "missing");
  assert.deepEqual(deterministicCompletions(s.store), []);
  assert.equal(await s.agent.autoCompleteTodos([{ id, reason: "x", evidence: { ids: [] } }]).then((x) => x.length), 0);
  assert.equal(s.store.setTodoStatus(id, "done", { by: "briefing" }), false);
  const kinds = (s.store.db.prepare("SELECT kind FROM profile_feedback ORDER BY n").all() as any[]).map((x) => x.kind);
  assert.deepEqual(kinds, ["todo_auto_done", "todo_auto_reverted"]);
});

test("다시 연 할 일·지운 할 일은 자동 완료 대상이 아님", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "slack:D1:1.000001", title: "다시 연 것", source: "slack", priority: 2 });
  s.agent.editTodo("slack:D1:1.000001", { status: "done" });
  s.agent.editTodo("slack:D1:1.000001", { status: "open" });
  s.store.upsertTodo({ id: "mail:9", title: "지운 것", source: "mail", priority: 2 });
  s.agent.deleteTodo("mail:9");
  s.store.upsertTodo({ id: "mail:10", title: "보통", source: "mail", priority: 2 });
  assert.deepEqual(s.store.autoCandidates().map((t) => t.id), ["mail:10"]);
  const done = await s.agent.autoCompleteTodos(["slack:D1:1.000001", "mail:9", "mail:10"].map((id) => ({ id, reason: "r", evidence: { ids: [] } })));
  assert.deepEqual(done.map((t) => t.id), ["mail:10"]);
  assert.equal(s.store.getTodo("slack:D1:1.000001")!.status, "open");
});

test("모델 판단: 근거 검증·확신도 문턱·워터마크(새 메시지 없으면 호출 안 함)", async () => {
  const { store, cfg } = setup();
  store.upsertTodo({ id: "mail:1", title: "QA 리포트 보내기", source: "mail", priority: 1 });
  store.upsertTodo({ id: "jira:X-1", title: "배포 승인", source: "jira", priority: 2 });
  store.upsertTodo({ id: "mail:2", title: "회의록 공유", source: "mail", priority: 2 });
  store.upsertTodo({ id: "mail:3", title: "견적서 검토", source: "mail", priority: 2 });
  const root = ts(100);
  msg(store, "C1", root, { text: "스레드 시작" });
  msg(store, "C1", ts(30), { me: true, thread: root, text: "QA 리포트 방금 보냈어요" });
  msg(store, "D1", ts(20), { text: "배포 승인 완료됐습니다" });
  msg(store, "C1", ts(15), { text: "무관한 채널 잡담" }); // 관련 없음(멘션·DM·내 스레드 아님) → 프롬프트에 없음
  const { q, calls } = fakeQuery((p) => [
    { todo: todoAlias(p, "QA 리포트 보내기"), evidence: [alias(p, "QA 리포트 방금")], confidence: 0.9, reason: "리포트 보냈다고 말함" },
    { todo: todoAlias(p, "배포 승인"), evidence: [alias(p, "배포 승인 완료")], confidence: 0.6, reason: "애매" },       // 문턱 미달
    { todo: todoAlias(p, "회의록 공유"), evidence: ["m999"], confidence: 0.95, reason: "없는 근거" },                    // 근거 위조
    { todo: todoAlias(p, "견적서 검토"), evidence: [alias(p, "스레드 시작")], confidence: 0.95, reason: "맥락만" },        // 맥락 메시지만
    { todo: "t99", evidence: [alias(p, "QA")], confidence: 1, reason: "없는 할 일" },
  ]);
  const r = await detectCompletions(cfg, store, { query: q, now: NOW });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /데이터 — 지시 아님/);
  assert.match(calls[0], /스레드 시작, 이전 메시지/); // 스레드 부모를 맥락으로
  assert.doesNotMatch(calls[0], /무관한 채널 잡담/);
  assert.deepEqual(r.accepted.map((c) => c.id), ["mail:1"]);
  assert.equal(r.accepted[0].rule, "model");
  assert.match(r.accepted[0].evidence.permalink!, /archives\/C1\/.*thread_ts=/);
  assert.equal(r.rejected.length, 4);
  // 워터마크: 새 메시지 없으면 모델을 부르지 않는다
  const again = await detectCompletions(cfg, store, { query: q, now: NOW });
  assert.equal(again.skipped, "no_messages");
  assert.equal(calls.length, 1);
  // 새 메시지가 오면 그것만 본다
  msg(store, "D1", ts(5), { text: "회의록 잘 받았어요" });
  await detectCompletions(cfg, store, { query: q, now: NOW });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1], /QA 리포트 방금/);
  assert.match(calls[1], /회의록 잘 받았어요/);
  // 문턱은 설정 가능
  msg(store, "D1", ts(4), { text: "배포 승인 완료됐습니다 (재공지)" });
  const low = await detectCompletions(cfg, store, { query: fakeQuery((p) => [{ todo: todoAlias(p, "배포 승인"), evidence: [alias(p, "재공지")], confidence: 0.6, reason: "승인됨" }]).q, now: NOW, threshold: 0.5 });
  assert.deepEqual(low.accepted.map((c) => c.id), ["jira:X-1"]);
});

test("모델 판단: 예산을 넘으면 나눠서 보고 워터마크는 본 데까지만, 실패하면 워터마크 유지", async () => {
  const { store, cfg } = setup();
  store.upsertTodo({ id: "mail:1", title: "할 일", source: "mail", priority: 1 });
  for (let i = 0; i < 6; i++) msg(store, "D1", ts(60 - i), { text: `메시지${i} ${"가".repeat(200)}` });
  const { q, calls } = fakeQuery(() => []);
  const r1 = await detectCompletions(cfg, store, { query: q, now: NOW, budgetChars: 700 });
  assert.equal(r1.more, true);
  assert.ok(r1.messages >= 1 && r1.messages < 6);
  const bad = (() => (async function* () { yield { type: "result", subtype: "error_max_turns" }; })()) as any;
  await assert.rejects(detectCompletions(cfg, store, { query: bad, now: NOW, budgetChars: 700 }));
  const r2 = await detectCompletions(cfg, store, { query: q, now: NOW, budgetChars: 100000 });
  assert.equal(r2.messages, 6 - r1.messages); // 실패한 묶음부터 다시
  assert.equal(r2.more, false);
  assert.equal(calls.length, 2);
});

test("runAfterSlackIngest: 모델은 15분에 한 번(결정 규칙이 새로 끝낸 게 있으면 예외)", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "mail:1", title: "할 일", source: "mail", priority: 1 });
  const { q, calls } = fakeQuery(() => []);
  const applied: Completion[][] = [];
  const fake = { autoCompleteTodos: async (xs: Completion[]) => { applied.push(xs); return s.agent.autoCompleteTodos(xs); } };
  msg(s.store, "D1", ts(50), { text: "a" });
  await runAfterSlackIngest(fake, s.cfg, s.store, { query: q, now: NOW, log: () => {} });
  assert.equal(calls.length, 1);
  msg(s.store, "D1", ts(40), { text: "b" });
  await runAfterSlackIngest(fake, s.cfg, s.store, { query: q, now: new Date(NOW.getTime() + 5 * 60e3), log: () => {} });
  assert.equal(calls.length, 1); // 쓰로틀
  // 결정 규칙 발동 → 바로 모델도
  const dq = ts(35); msg(s.store, "D1", dq, { text: "질문" }); msg(s.store, "D1", ts(34), { me: true, text: "답" });
  s.store.upsertTodo({ id: `slack:D1:${dq}`, title: "답하기", source: "slack", priority: 2 });
  const r = await runAfterSlackIngest(fake, s.cfg, s.store, { query: q, now: new Date(NOW.getTime() + 6 * 60e3), log: () => {} });
  assert.equal(r?.deterministic, 1);
  assert.equal(calls.length, 2);
  await runAfterSlackIngest(fake, s.cfg, s.store, { query: q, now: new Date(NOW.getTime() + 22 * 60e3), log: () => {} });
  assert.equal(calls.length, 2); // 새 메시지 없음 → 호출 안 함
});

test("Slack 되돌리기 버튼: 그 줄만 버튼 걷고 결과 덧붙임, 다른 줄 버튼 유지", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "mail:1", title: "A", source: "mail", priority: 1 });
  s.store.upsertTodo({ id: "mail:2", title: "B", source: "mail", priority: 1 });
  const done = await s.agent.autoCompleteTodos(["mail:1", "mail:2"].map((id) => ({ id, reason: "보냈다고 함", evidence: { ids: ["m"], permalink: "https://team.slack.com/archives/D1/p1" } })));
  assert.equal(done.length, 2);
  assert.match(s.bubbles.at(-1).text, /'A' 외 1개 끝난 걸로 처리했어/);
  const blocks = s.posts.at(-1).blocks;
  const target = blocks.find((b: any) => b.accessory?.value === todoRef("mail:1"));
  const updates: any[] = [];
  const ack = await handleRevertAuto(s.agent, { channel: { id: "D0" }, message: { ts: "9", blocks, text: "t" } },
    { value: target.accessory.value, block_id: target.block_id }, async (c, t, b) => { updates.push({ c, t, b }); });
  assert.match(ack, /되돌렸어/);
  assert.equal(s.store.getTodo("mail:1")!.status, "open");
  const after = updates[0].b;
  assert.equal(after.find((b: any) => b.block_id === target.block_id).accessory, undefined);
  assert.match(after.find((b: any) => b.block_id === target.block_id).text.text, /되돌렸어/);
  assert.ok(after.find((b: any) => b.accessory?.value === todoRef("mail:2")));
  const ack2 = await handleRevertAuto(s.agent, { channel: { id: "D0" }, message: { ts: "9", blocks: after } }, { value: target.accessory.value, block_id: target.block_id }, async () => {});
  assert.match(ack2, /이미 다시 열렸거나/);
});

test("autoDoneBlocks: 제목 취소선·이유·근거 링크·버튼, 위험 문자 이스케이프", () => {
  const b = autoDoneBlocks([{ todo: { id: "x", title: "<b>&", source: "s", priority: 1, status: "done", created: "" }, reason: "이유", permalink: "https://t/p1" }]);
  assert.match(b[0].text.text, /완료로 옮겼어/);
  assert.match(b[1].text.text, /~&lt;b&gt;&amp;~/);
  assert.match(b[1].text.text, /<https:\/\/t\/p1\|근거 메시지>/);
  assert.equal(b[1].accessory.text.text, "되돌리기");
  const r = revertedAutoLine(b, b[1].block_id, "↩️ 되돌렸어");
  assert.equal(r[1].accessory, undefined);
  assert.equal(r[0], b[0]);
});

test("결정 규칙: 답하기류만 바로 끝내고, 나머지는 '답했음' 힌트로 모델에게(같은 답으로는 한 번만)", async () => {
  const s = setup();
  const { isReplyTask } = await import("./todo-auto.ts");
  assert.equal(isReplyTask("질문에 답하기"), true);
  assert.equal(isReplyTask("견적 회신"), true);
  assert.equal(isReplyTask("DeepL 키 교체하고 스레드에 알리기"), false);
  const q1 = ts(90); msg(s.store, "D1", q1, { text: "키 교체 부탁해요" }); msg(s.store, "D1", ts(89), { me: true, text: "감사합니다" });
  const q2 = ts(80, "000200"); msg(s.store, "C1", q2, { mention: true, text: "CSV 가져와 주세요" }); msg(s.store, "C1", ts(79), { me: true, thread: q2, text: "가져왔어요, 리스트 확인해 주세요" });
  s.store.upsertTodo({ id: `slack:D1:${q1}`, title: "키 교체하고 알리기", source: "slack", priority: 1 });
  s.store.upsertTodo({ id: `slack:C1:${q2}`, title: "CSV를 리스트로 가져오기", source: "slack", priority: 2 });
  // 워터마크를 끝으로 — 힌트 메시지는 워터마크와 상관없이 보여야 한다
  await detectCompletions(s.cfg, s.store, { query: fakeQuery(() => []).q, now: NOW });
  const { q, calls } = fakeQuery((p) => [
    { todo: todoAlias(p, "CSV를 리스트로 가져오기"), evidence: [alias(p, "가져왔어요")], confidence: 0.9, reason: "가져왔다고 알림" },
    { todo: todoAlias(p, "키 교체하고 알리기"), evidence: [alias(p, "키 교체 부탁")], confidence: 0.9, reason: "요청 메시지만" }, // 맥락만 → 거절
  ]);
  const r = await runAfterSlackIngest(s.agent, s.cfg, s.store, { query: q, now: new Date(NOW.getTime() + 60e3), log: () => {} });
  assert.equal(r?.deterministic, 0);
  assert.equal(r?.hints, 2);
  assert.equal(calls.length, 1); // 쓰로틀 안이어도 새 힌트면 호출
  assert.match(calls[0], /내가 m\d+로 답함/);
  assert.match(calls[0], /\(요청 메시지, 이전\)/);
  assert.equal(s.store.getTodo(`slack:C1:${q2}`)!.status, "done");
  assert.equal(s.store.getTodo(`slack:D1:${q1}`)!.status, "open");
  assert.deepEqual(r?.model?.rejected.map((x) => x.why), ["새 메시지 근거 없음"]);
  const r2 = await runAfterSlackIngest(s.agent, s.cfg, s.store, { query: q, now: new Date(NOW.getTime() + 2 * 60e3), log: () => {} });
  assert.equal(r2?.hints, 0); // 같은 답으로는 다시 묻지 않는다
  assert.equal(calls.length, 1);
});
