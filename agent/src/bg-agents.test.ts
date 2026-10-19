// 백그라운드 에이전트: 채팅이 띄운 서브에이전트는 답과 떼어 따로 — 답은 바로 끝나고 다음 말이 기다리지 않으며, 결과는 끝나면 그 대화에 새 답으로.
// 진짜 SDK 는 부르지 않는다 — 훅 입력(PreToolUse)을 흉내 내 승인 브로커를 직접 부르고, 백그라운드 run 은 가짜(deps.bgRun)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundAgents, BG_MARK, type BgAgent } from "./bg-agents.ts";
import { PermissionBroker, PermissionRules, type PermQueue, type PermCtx } from "./permissions.ts";
import { RepoLocks } from "./repo-lock.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { toolOptions } from "./brain.ts";
import { RunRegistry } from "./runs.ts";
import { agentsForThread } from "./thread-agents.ts";
import type { ChatEvent, Converse } from "./chat.ts";

const root = mkdtempSync(join(tmpdir(), "cy-bg-"));
const repo = join(root, "ax", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
const cfg = () => ({ ...loadConfig(), repoRoots: [join(root, "ax")], claudeProjectsDir: "/none", codexSessionsDir: "/none", localAutoAllow: false });
const pctx = (o: Partial<PermCtx> = {}): PermCtx => ({ roots: [join(root, "ax")], brainDir: join(root, "brain"), cwd: repo, ...o });
const pre = (tool_name: string, tool_input: unknown, tool_use_id = "tu1", agent_id?: string) =>
  ({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "/x", cwd: repo, tool_use_id, ...(agent_id ? { agent_id, agent_type: "general-purpose" } : {}) }) as any;
const decision = (o: any) => o?.hookSpecificOutput?.permissionDecision;
const reason = (o: any) => String(o?.hookSpecificOutput?.permissionDecisionReason ?? "");
const tick = () => new Promise((r) => setTimeout(r, 1));
const waitFor = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };

// 손으로 끝내는 가짜 run: release(id, 결과) / fail(id)
function gate() {
  const open = new Map<string, { res: (v: string) => void; rej: (e: Error) => void }>();
  const started: string[] = [];
  const run = (job: Readonly<BgAgent>, onRun: (id: string) => void) => new Promise<string>((res, rej) => {
    started.push(job.toolUseId);
    onRun(`run-${job.toolUseId}`);
    open.set(job.toolUseId, { res, rej });
    job.abort.signal.addEventListener("abort", () => rej(new Error("멈췄어요")));
  });
  return { run, started, release: (id: string, v: string) => open.get(id)!.res(v), fail: (id: string, e: string) => open.get(id)!.rej(new Error(e)) };
}

function bgRig() {
  const g = gate();
  const posts: [string, string, string][] = [];
  const changed: string[] = [];
  const bg = new BackgroundAgents({ run: g.run, post: (t, role, text) => posts.push([t, role, text]), changed: (t) => changed.push(t) });
  return { g, posts, changed, bg };
}
const req = (id: string, threadId = "t1") => ({ toolUseId: id, threadId, via: "chat" as const, description: `점검 ${id}`, prompt: `PR 점검 ${id}` });

test("BackgroundAgents: 상한·대기 줄 없이 부르는 대로 전부 바로 시작 — 결과는 그 대화에 새 답", async () => {
  const { g, posts, bg } = bgRig();
  const m1 = bg.request(req("a"));
  assert.ok(m1.startsWith(BG_MARK));
  assert.match(m1, /실패가 아니에요/);
  assert.match(m1, /기다리거나 짐작해서 말하지 말고/);
  assert.match(m1, /개수 상한 없음/);
  bg.request(req("b"));
  const m3 = bg.request(req("c"));
  assert.doesNotMatch(m3, /대기|줄 섰/);
  assert.deepEqual(g.started, ["a", "b", "c"]);
  assert.equal(bg.runningCount(), 3);
  assert.ok(bg.isRun("run-a"));
  assert.ok(!bg.isRun("run-zzz"));
  // 같은 호출이 또 와도 두 번 돌리지 않는다
  assert.match(bg.request(req("a")), /이미 시작했어요/);
  g.release("a", "결론: 머지해도 돼요");
  g.fail("b", "SDK 오류");
  g.release("c", "");
  await bg.idle();
  assert.equal(bg.get("a")!.status, "done");
  assert.deepEqual(posts[0].slice(0, 2), ["t1", "assistant"]);
  assert.match(posts.find((p) => p[2].includes("점검 a"))![2], /🤖 에이전트 「점검 a」 끝났어요\n\n결론: 머지해도 돼요/);
  assert.equal(bg.get("b")!.status, "failed");
  assert.match(posts.find((p) => p[2].includes("점검 b"))![2], /끝까지 못 했어요 — SDK 오류/);
  assert.match(posts.find((p) => p[2].includes("점검 c"))![2], /남긴 글이 없어요/);
  assert.equal(bg.runningCount(), 0);
});

test("BackgroundAgents: 20개를 한꺼번에 불러도 전부 바로 돈다(대기 0)", async () => {
  const { g, bg } = bgRig();
  for (let i = 0; i < 20; i++) assert.doesNotMatch(bg.request(req(`n${i}`)), /너무 많|대기/);
  assert.equal(g.started.length, 20);
  assert.equal(bg.runningCount(), 20);
  assert.ok(bg.list().every((j) => j.status === "running"));
  for (let i = 0; i < 20; i++) g.release(`n${i}`, "ok");
  await bg.idle();
  assert.ok(bg.list().every((j) => j.status === "done"));
});

test("BackgroundAgents: 멈추기 — 돌고 있으면 abort(시스템 줄), 끝난 건 false", async () => {
  const { g, posts, bg } = bgRig();
  bg.request(req("a"));
  assert.equal(bg.stop("a"), true);
  await bg.idle();
  assert.equal(bg.get("a")!.status, "stopped");
  assert.deepEqual(posts.at(-1), ["t1", "system", "에이전트 「점검 a」 을(를) 멈췄어요"]);
  assert.equal(bg.stop("a"), false);
  assert.equal(bg.stop("nope"), false);
  assert.deepEqual(g.started, ["a"]);
});

function brokerRig(sink?: (r: any) => string | null) {
  const asked: any[] = [];
  const queue: PermQueue = { requestPermission(r) { asked.push(r); return { action: {} as any, decision: Promise.resolve({ behavior: "allow", always: false } as any) }; } };
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue);
  const calls: any[] = [];
  if (sink !== undefined) broker.onBackgroundAgent = (r) => { calls.push(r); return sink(r); };
  return { broker, calls, asked };
}

test("훅: 패널·캐릭터 대화의 Agent 호출은 백그라운드로 넘기고 모델에는 「시작했어요」(거부 자리) — 그 밖은 예전처럼 포그라운드", async () => {
  const { broker, calls } = brokerRig(() => `${BG_MARK} 시작했어요`);
  const chat = broker.hook(pctx(), { via: "chat", threadId: "t1" });
  const o = await chat(pre("Agent", { description: "PR #271 코드 점검", prompt: "점검해", subagent_type: "general-purpose" }, "toolu_1"), "toolu_1", { signal: new AbortController().signal });
  assert.equal(decision(o), "deny");
  assert.ok(reason(o).startsWith(BG_MARK));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolUseId, "toolu_1");
  assert.equal(calls[0].origin.threadId, "t1");
  assert.equal(calls[0].input.prompt, "점검해");
  assert.equal(calls[0].cwd, repo);
  // 캐릭터 대화도
  const hover = await broker.hook(pctx(), { via: "hover", threadId: "t2" })(pre("Task", { description: "d", prompt: "p" }, "tu2"), "tu2", { signal: new AbortController().signal });
  assert.equal(decision(hover), "deny");
  // 파일을 고쳐야 해서 run_in_background: false 로 부르면 예전처럼 포그라운드(허용 + 고친 입력)
  const fg = await chat(pre("Agent", { description: "d", prompt: "p", run_in_background: false }, "tu3"), "tu3", { signal: new AbortController().signal });
  assert.equal(decision(fg), "allow");
  // 할 일 팝오버·Slack DM(대화 스레드가 없는 곳)·서브에이전트 안 호출은 그대로
  for (const [origin, agentId] of [[{ via: "todo", todoId: "x" }, undefined], [{ via: "slack" }, undefined], [{ via: "chat", threadId: "t1" }, "sub-1"]] as const) {
    const r = await broker.hook(pctx(), origin as any)(pre("Agent", { description: "d", prompt: "p" }, "tu4", agentId), "tu4", { signal: new AbortController().signal });
    assert.equal(decision(r), "allow", JSON.stringify(origin));
  }
  // isolation "worktree" 는 백그라운드로 넘기며 표시(자기 워크트리에서), "remote" 는 거부
  const iso = await chat(pre("Agent", { description: "d", prompt: "p", isolation: "worktree" }, "tu5"), "tu5", { signal: new AbortController().signal });
  assert.ok(reason(iso).startsWith(BG_MARK));
  assert.equal(calls.at(-1).isolation, "worktree");
  assert.equal(calls.at(-1).input.isolation, undefined);
  const remote = await chat(pre("Agent", { description: "d", prompt: "p", isolation: "remote" }, "tu6"), "tu6", { signal: new AbortController().signal });
  assert.equal(decision(remote), "deny");
  assert.ok(!reason(remote).startsWith(BG_MARK));
  assert.equal(calls.length, 3);
  // 넘길 곳이 없으면(null) 포그라운드
  const none = brokerRig(() => null);
  const r = await none.broker.hook(pctx(), { via: "chat", threadId: "t1" })(pre("Agent", { description: "d", prompt: "p" }), "tu1", { signal: new AbortController().signal });
  assert.equal(decision(r), "allow");
});

test("백그라운드 에이전트는 채팅 답과 같은 권한: 파일 쓰기·쓰기 셸은 승인 카드(그 대화)·같은 작업 폴더 잠금, 서브에이전트는 포그라운드로", async () => {
  const locks = new RepoLocks();
  const asked: any[] = [];
  const queue: PermQueue = { requestPermission(r) { asked.push(r); return { action: {} as any, decision: Promise.resolve({ behavior: "allow", always: false } as any) }; } };
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue, undefined, locks);
  broker.onBackgroundAgent = () => "x";
  const origin = { via: "chat" as const, threadId: "t1", runId: "bg-run" };
  const h = broker.hook(pctx({ background: true }), origin);
  const run = (tool: string, input: unknown, id = "tu") => h(pre(tool, input, id), id, { signal: new AbortController().signal });
  // 쓰기: 거부가 아니라 승인 카드(ask) — 그리고 이 run 이 그 레포 작업 폴더를 잡는다
  assert.equal(decision(await run("Edit", { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" })), "ask");
  assert.equal(locks.holder(repo)?.key, "bg-run");
  assert.equal(decision(await run("Bash", { command: "npm test" })), "ask");
  const c = await broker.canUseTool(origin, pctx({ background: true }))("Write", { file_path: join(repo, "b.ts"), content: "x" }, { signal: new AbortController().signal } as any);
  assert.equal((c as any).behavior, "allow");
  assert.equal(asked.at(-1).origin.threadId, "t1");
  // 같은 작업 폴더를 고치려는 다른 답은 이 에이전트가 끝날 때까지 기다린다
  const other = broker.hook(pctx(), { via: "chat", threadId: "t2", runId: "chat-run" })(pre("Edit", { file_path: join(repo, "c.ts"), old_string: "a", new_string: "b" }, "tu9"), "tu9", { signal: new AbortController().signal });
  let settled = false; void other.then(() => { settled = true; });
  await tick(); await tick();
  assert.equal(settled, false);
  locks.release("bg-run");
  assert.equal(decision(await other), "ask");
  assert.equal(locks.holder(repo)?.key, "chat-run");
  locks.release("chat-run");
  // 읽기는 그대로 허용, 하드 차단은 그대로
  assert.equal(decision(await run("Bash", { command: "git log --oneline -5" })), "allow");
  assert.match(reason(await run("Bash", { command: "git push origin main" })), /차단됨/);
  // 서브에이전트: 다시 백그라운드로 넘기지 않고 포그라운드(허용)
  const ag = await run("Agent", { description: "d", prompt: "p" }, "tu-sub");
  assert.equal(decision(ag), "allow");
  assert.ok(!reason(ag).startsWith(BG_MARK));
  // SDK 옵션: 막힌 도구 없음, 서브에이전트 켬
  const t = toolOptions(cfg() as any, { interactive: { origin: { via: "chat", threadId: "t1" }, broker }, code: { roots: [join(root, "ax")], cwd: repo }, background: { toolUseId: "tu", description: "d" } });
  assert.deepEqual(t.disallowedTools, []);
  assert.equal(t.subagents, true);
});

test("대화 속 카드: 넘긴 Agent 줄은 백그라운드 run 의 카드 하나로 — run 이 아직 없으면 데몬이 아는 상태(워크트리 포함), run 이 생기면 그 run 카드(background)", () => {
  const reg = new RunRegistry();
  const chat = reg.startRun({ kind: "chat", title: "채팅: 점검", ref: "t1", origin: { type: "thread", threadId: "t1" } });
  chat.log({ type: "user", text: "점검해" });
  chat.log({ type: "tool_use", name: "Agent", input: "PR #271 코드 점검", toolUseId: "tu1" });
  chat.log({ type: "tool_result", toolUseId: "tu1", output: `${BG_MARK} 「PR #271 코드 점검」 — 지금 백그라운드로 시작했어요`, isError: true });
  chat.end("done");
  let st = "running";
  const wt = { path: "/w/app-atu1", branch: "cy/agent-pr-271-tu1" };
  const look = (id: string) => (id === "tu1" ? { status: st, worktree: wt } : undefined);
  let list = agentsForThread(reg, "t1", look);
  assert.deepEqual(list.map((a) => [a.runId, a.status, a.background, a.worktree]), [[chat.id, "running", true, wt]]);
  // 시작 → 백그라운드 run(맨 위 Agent 줄 background, 안쪽은 parent)
  st = "running";
  const bg = reg.startRun({ kind: "chat", title: "에이전트: PR #271 코드 점검", ref: "t1", origin: { type: "thread", threadId: "t1" } });
  bg.log({ type: "tool_use", name: "Agent", input: "PR #271 코드 점검", toolUseId: "tu1", background: true });
  bg.log({ type: "user", text: "점검해", parent: "tu1" });
  bg.log({ type: "tool_use", name: "Bash", input: "gh pr diff 271", toolUseId: "b1", parent: "tu1" });
  list = agentsForThread(reg, "t1", look);
  assert.deepEqual(list.map((a) => [a.runId, a.status, a.tools, a.background, a.worktree]), [[bg.id, "running", 1, true, wt]]);
  bg.log({ type: "tool_result", toolUseId: "tu1", output: "결론: 괜찮아요" });
  bg.end("done");
  st = "done";
  list = agentsForThread(reg, "t1", look);
  assert.deepEqual(list.map((a) => [a.runId, a.status]), [[bg.id, "done"]]);
  // 데몬이 다시 떠서 모르면: run 카드가 있으면 그것, 없으면 넘긴 줄은 결과 없음
  assert.deepEqual(agentsForThread(reg, "t1").map((a) => [a.runId, a.status]), [[bg.id, "done"]]);
});

test("대화 속 카드: SDK 가 훅 이유 앞에 「PreToolUse:Agent hook error: 」를 붙여도 넘김 — 실패 ✗ 카드가 따로 안 뜬다", () => {
  const reg = new RunRegistry();
  const chat = reg.startRun({ kind: "chat", title: "채팅: 정리", ref: "t2", origin: { type: "thread", threadId: "t2" } });
  chat.log({ type: "tool_use", name: "Agent", input: "#283 refine 충돌 정리", toolUseId: "tu2" });
  chat.log({ type: "tool_result", toolUseId: "tu2", output: `PreToolUse:Agent hook error: ${BG_MARK} 「#283 refine 충돌 정리」 — 지금 백그라운드로 시작했어요`, isError: true });
  chat.end("done");
  const bg = reg.startRun({ kind: "chat", title: "에이전트: #283 refine 충돌 정리", ref: "t2", origin: { type: "thread", threadId: "t2" } });
  bg.log({ type: "tool_use", name: "Agent", input: "#283 refine 충돌 정리", toolUseId: "tu2", background: true });
  const list = agentsForThread(reg, "t2", (id) => (id === "tu2" ? { status: "running" } : undefined));
  assert.deepEqual(list.map((a) => [a.runId, a.status]), [[bg.id, "running"]]);
  // 진짜 실패(넘김 표시 없는 오류)는 그대로 실패
  const c2 = reg.startRun({ kind: "chat", title: "채팅: 또", ref: "t3", origin: { type: "thread", threadId: "t3" } });
  c2.log({ type: "tool_use", name: "Agent", input: "x", toolUseId: "tu3" });
  c2.log({ type: "tool_result", toolUseId: "tu3", output: "PreToolUse:Agent hook error: 막혔어요", isError: true });
  c2.end("done");
  assert.deepEqual(agentsForThread(reg, "t3").map((a) => a.status), ["failed"]);
});

// ---- 채팅 + 데몬 전체: 서브에이전트가 도는 동안 답은 끝나고, 다음 말은 바로 답하며, 결과는 나중에 그 대화에 ----
function core() {
  const g = gate();
  const events: ChatEvent[] = [];
  let agent!: Agent;
  const converse: Converse = async (_c, _s, _h, text, _o, _sum, _f, threadId) => {
    if (text.includes("서브에이전트")) {
      // 모델이 Agent 도구를 부름 → SDK 가 우리 PreToolUse 훅을 부른다(흉내)
      const o = await agent.broker.hook(pctx(), { via: "chat", threadId })(pre("Agent", { description: "PR #271 코드 점검", prompt: "PR #271 을 점검해" }, "toolu_bg"), "toolu_bg", { signal: new AbortController().signal });
      assert.equal(decision(o), "deny");
      assert.ok(reason(o).startsWith(BG_MARK));
      return { reply_md: "PR #271 점검을 에이전트로 시작했어요 — 끝나면 이 대화에 결과를 올릴게요.", bubble: "", show: null, proposals: [] };
    }
    return { reply_md: `답: ${text}`, bubble: "", show: null, proposals: [] };
  };
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  bus.chat = (ev) => { events.push(ev as ChatEvent); };
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return "x"; };
  agent = new Agent(cfg() as any, store, bus, undefined, { converse, git: async () => [], useBroker: false, bgRun: g.run });
  return { agent, store, events, g, bubbles };
}

test("채팅: 서브에이전트가 도는 동안 그 답은 끝나고, 다음 말은 기다리지 않고 바로 답한다 — 결과는 끝나면 같은 대화에 새 답", async () => {
  const s = core();
  const a = s.agent.chat("코드점검 서브에이전트로 한 번 굴리고 다시 물어") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  // 답은 이미 끝났다(서브에이전트는 아직 도는 중)
  assert.equal(s.events.filter((e) => e.chatId === a.chatId).at(-1)!.status, "done");
  assert.deepEqual(s.g.started, ["toolu_bg"]);
  assert.equal(s.agent.bgAgents.get("toolu_bg")!.status, "running");
  // 다음 말: 줄 서지 않고 바로(queued 없음) 답한다
  const b = s.agent.chat("엥? SPEAKER_SPLIT_VOICEPRINT=log 라고? 1이 아니라?", { threadId: a.threadId }) as { chatId: string; queued?: boolean };
  assert.equal(b.queued, false);
  await s.agent.chatIdle();
  assert.deepEqual(s.events.filter((e) => e.chatId === b.chatId).map((e) => e.status), ["thinking", "done"]);
  assert.equal(s.agent.bgAgents.get("toolu_bg")!.status, "running");
  // 서브에이전트가 끝나면 결과가 같은 대화에 새 답으로(+ 캐릭터 말풍선)
  s.g.release("toolu_bg", "결론: log 가 맞아요 — 1 은 예전 값");
  await s.agent.bgAgents.idle();
  const msgs = s.store.threadMessages(a.threadId).map((m) => `${m.role}:${m.text.split("\n")[0]}`);
  assert.deepEqual(msgs, [
    "user:코드점검 서브에이전트로 한 번 굴리고 다시 물어",
    "assistant:PR #271 점검을 에이전트로 시작했어요 — 끝나면 이 대화에 결과를 올릴게요.",
    "user:엥? SPEAKER_SPLIT_VOICEPRINT=log 라고? 1이 아니라?",
    "assistant:답: 엥? SPEAKER_SPLIT_VOICEPRINT=log 라고? 1이 아니라?",
    "assistant:🤖 에이전트 「PR #271 코드 점검」 끝났어요",
  ]);
  assert.match(s.store.threadMessages(a.threadId).at(-1)!.text, /결론: log 가 맞아요/);
  assert.ok(s.bubbles.some((x) => x.open?.id === a.threadId && /끝났어요/.test(x.text)));
});

test("채팅: 백그라운드 에이전트가 띄운 승인 카드는 그 사이 돈 채팅 답에 붙지 않는다", async () => {
  const s = core();
  const a = s.agent.chat("코드점검 서브에이전트로 굴려") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  // 백그라운드 run 이 그 대화에 승인 카드를 띄움(runId = 그 run)
  s.agent.actions.requestPermission({ toolName: "mcp__relay__invoke", card: { icon: "🔧", title: "x", verb: "실행", question: "?", notice: "" }, fields: [], origin: { via: "chat", threadId: a.threadId, runId: "run-toolu_bg" } });
  const b = s.agent.chat("다른 질문", { threadId: a.threadId }) as { chatId: string };
  await s.agent.chatIdle();
  const done = s.events.find((e) => e.chatId === b.chatId && e.status === "done") as any;
  assert.equal(done.actions, undefined);
  s.g.release("toolu_bg", "끝");
  await s.agent.bgAgents.idle();
});
