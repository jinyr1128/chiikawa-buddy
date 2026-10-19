// 대화 속 서브에이전트 목록(GET /chat/threads/:id/agents) + SSE agents 디바운스
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunRegistry } from "./runs.ts";
import { Bus } from "./bus.ts";
import { agentsOfRun, agentsForThread, AgentsNotifier, threadAgents, sessionLast, sessionOfRun, sessionsForThread, type AgentRow } from "./thread-agents.ts";

const T0 = "2026-10-12T01:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

test("agentsOfRun: 맨 위 Agent 줄만 · 도구 수 · 마지막 줄 · 결과로 완료/실패 · 결과 없으면 돌면 진행 중, 아니면 멈춤", () => {
  const rows: AgentRow[] = [
    { seq: 1, at: at(0), type: "assistant", text: "찾아볼게요" },
    { seq: 2, at: at(1), type: "tool_use", name: "Agent", input: "STT 구성 조사", toolUseId: "A1" },
    { seq: 3, at: at(2), type: "tool_use", name: "Task", input: "레포 훑기", toolUseId: "A2", via: "cli" },
    { seq: 4, at: at(3), type: "tool_use", name: "Grep", input: "whisper in src", toolUseId: "g1", parent: "A1" },
    { seq: 5, at: at(4), type: "tool_result", toolUseId: "g1", parent: "A1" },
    { seq: 6, at: at(5), type: "tool_use", name: "Bash", input: "ls -la\n  config", toolUseId: "b1", parent: "A1" },
    { seq: 7, at: at(6), type: "tool_use", name: "Agent", input: "안쪽 에이전트", toolUseId: "N1", parent: "A1" },
    { seq: 8, at: at(7), type: "tool_use", name: "Read", input: "x.ts", toolUseId: "r1", parent: "N1" },
    { seq: 9, at: at(8), type: "assistant", text: "다 봤어요\n정리하면", parent: "A2" },
    { seq: 10, at: at(9), type: "tool_result", toolUseId: "A2", isError: 1 },
    { seq: 11, at: at(10), type: "tool_use", name: "Agent", input: "세 번째", toolUseId: "A3" },
    { seq: 12, at: at(11), type: "tool_result", toolUseId: "A3", isError: null },
  ];
  const running = agentsOfRun({ id: "r", status: "running" }, rows);
  assert.deepEqual(running.map((a) => [a.toolUseId, a.status, a.tools, a.last]), [
    ["A1", "running", 3, "Agent(안쪽 에이전트)"],
    ["A2", "failed", 0, "다 봤어요 정리하면"],
    ["A3", "done", 0, ""],
  ]);
  assert.equal(running[0].description, "STT 구성 조사");
  assert.equal(running[0].startedAt, at(1));
  assert.equal(running[0].endedAt, undefined);
  assert.equal(running[1].via, "cli");
  assert.equal(running[1].endedAt, at(9));
  assert.equal(running[0].via, undefined);
  // 끝난 run: 결과 없는 건 멈춤, 터미널 기록을 지켜보는 중이면 진행 중
  assert.equal(agentsOfRun({ id: "r", status: "done" }, rows)[0].status, "stopped");
  assert.equal(agentsOfRun({ id: "r", status: "failed", watching: true }, rows)[0].status, "running");
  // Agent 줄이 없으면 빈 목록
  assert.deepEqual(agentsOfRun({ id: "r", status: "running" }, [rows[0]]), []);
  // 긴 입력은 한 줄로 자른다
  const long = agentsOfRun({ id: "r", status: "running" }, [
    { seq: 1, at: at(0), type: "tool_use", name: "Agent", input: "x".repeat(500), toolUseId: "L" },
    { seq: 2, at: at(1), type: "tool_use", name: "Bash", input: "y".repeat(500), toolUseId: "b", parent: "L" },
  ])[0];
  assert.ok(long.description.length <= 200 && long.description.endsWith("…"));
  assert.ok(long.last.length <= 120 && long.last.startsWith("Bash(") && long.last.endsWith(")"));
});

test("threadAgents: 여러 run 을 시작 순으로 합침", () => {
  const a = { run: { id: "r1", status: "done" as const }, rows: [{ seq: 1, at: at(5), type: "tool_use", name: "Agent", input: "늦은", toolUseId: "X" }] };
  const b = { run: { id: "r2", status: "done" as const }, rows: [{ seq: 1, at: at(1), type: "tool_use", name: "Agent", input: "이른", toolUseId: "Y" }] };
  assert.deepEqual(threadAgents([a, b]).map((x) => [x.runId, x.description]), [["r2", "이른"], ["r1", "늦은"]]);
});

test("agentsForThread: 레지스트리 기록에서 — 대화 run(origin·채팅 ref)만, SDK 세션 없어도", () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const chat = reg.startRun({ kind: "chat", title: "채팅", ref: "th1" });
  chat.log({ type: "user", text: "STT 봐 줘" });
  chat.log({ type: "tool_use", name: "Agent", input: "STT 구성 확인", toolUseId: "toolu_1" });
  chat.log({ type: "user", text: "지시", parent: "toolu_1" });
  chat.log({ type: "tool_use", name: "Bash", input: "git log --oneline", toolUseId: "t2", parent: "toolu_1" });
  chat.log({ type: "tool_result", toolUseId: "t2", output: "abc", parent: "toolu_1" });
  const fix = reg.startRun({ kind: "fix", title: "수정", origin: { type: "proposal", proposalId: "p1", threadId: "th1" } });
  fix.log({ type: "tool_use", name: "Agent", input: "테스트 고치기", toolUseId: "toolu_9" });
  fix.log({ type: "tool_result", toolUseId: "toolu_9", output: "끝", isError: true });
  fix.end("failed");
  const other = reg.startRun({ kind: "chat", title: "다른", ref: "th2" });
  other.log({ type: "tool_use", name: "Agent", input: "딴 대화", toolUseId: "toolu_x" });

  const list = agentsForThread(reg, "th1");
  assert.deepEqual(list.map((a) => [a.runId, a.toolUseId, a.description, a.status, a.tools, a.last]), [
    [chat.id, "toolu_1", "STT 구성 확인", "running", 1, "Bash(git log --oneline)"],
    [fix.id, "toolu_9", "테스트 고치기", "failed", 0, ""],
  ]);
  chat.end("stopped");
  assert.equal(agentsForThread(reg, "th1")[0].status, "stopped");
  chat.log({ type: "tool_result", toolUseId: "toolu_1", output: "결과", via: "cli" }); // 터미널 task-notification 으로 온 결과
  assert.equal(agentsForThread(reg, "th1")[0].status, "done");
  assert.deepEqual(agentsForThread(reg, "none"), []);
});

test("AgentsNotifier: 서브에이전트 변화만 대화별로 모아 한 번", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const got: string[] = [];
  const n = new AgentsNotifier(reg, (t) => got.push(t), 20);
  try {
    const r = reg.startRun({ kind: "chat", title: "채팅", ref: "th1" });
    r.log({ type: "assistant", text: "그냥 글" });
    r.log({ type: "tool_use", name: "Read", input: "a", toolUseId: "x" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, []); // 서브에이전트와 상관없는 줄은 알리지 않는다
    r.log({ type: "tool_use", name: "Agent", input: "조사", toolUseId: "A" });
    r.log({ type: "tool_use", name: "Bash", input: "ls", toolUseId: "b", parent: "A" });
    r.log({ type: "tool_result", toolUseId: "b", parent: "A" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1"]);
    r.log({ type: "tool_result", toolUseId: "A", output: "끝" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1"]);
    const lone = reg.startRun({ kind: "briefing", title: "브리핑" }); // 대화 밖 run 은 알리지 않음
    lone.log({ type: "tool_use", name: "Agent", input: "x", toolUseId: "Z" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1"]);
  } finally { n.close(); }
});

test("GET /chat/threads/:id/agents → { agents } · 없는 대화 404 · 핸들러 없으면 503", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const r = reg.startRun({ kind: "chat", title: "채팅", ref: "th1" });
  r.log({ type: "tool_use", name: "Agent", input: "조사", toolUseId: "A" });
  const base = { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [], runs: reg,
    chatThreads: { list: () => [], create: () => ({}), edit: () => ({}), remove: () => true, messages: () => undefined } };
  const bus = new Bus();
  await bus.listen(0, { ...base, threadAgents: (id) => (id === "th1" ? agentsForThread(reg, id) : undefined) });
  const bus2 = new Bus();
  await bus2.listen(0, base);
  try {
    const url = (b: Bus, p: string) => `http://127.0.0.1:${(b.server!.address() as any).port}${p}`;
    const ok = await (await fetch(url(bus, "/chat/threads/th1/agents"))).json();
    assert.deepEqual(ok.agents.map((a: any) => [a.toolUseId, a.status, a.description]), [["A", "running", "조사"]]);
    assert.equal((await fetch(url(bus, "/chat/threads/nope/agents"))).status, 404);
    assert.equal((await fetch(url(bus2, "/chat/threads/th1/agents"))).status, 503);
    assert.equal(ok.sessions, undefined); // 작업 세션 핸들러가 없으면 sessions 없음(예전 모양)
  } finally { bus.close(); bus2.close(); }
});

test("sessionLast: 최근 줄(새것 먼저)에서 첫 보일 줄 — 도구는 이름(입력), 글은 한 줄, 빈 글 건너뜀", () => {
  assert.equal(sessionLast([]), "");
  assert.equal(sessionLast([
    { seq: 3, at: at(2), type: "assistant", text: "  \n " },
    { seq: 2, at: at(1), type: "tool_use", name: "Bash", input: "npm test\n  --silent" },
    { seq: 1, at: at(0), type: "assistant", text: "옛 글" },
  ]), "Bash(npm test --silent)");
  assert.equal(sessionLast([{ seq: 1, at: at(0), type: "system", text: "🚀 cy/x 푸시 완료" }]), "🚀 cy/x 푸시 완료");
  assert.ok(sessionLast([{ seq: 1, at: at(0), type: "assistant", text: "가".repeat(400) }]).length <= 140);
});

test("sessionOfRun: 레포 이름·브랜치·상태·askedAt(이어서 한 run 은 continued, askedAt 없음)", () => {
  const run = { id: "r1", title: "PR 과소분리 나누기", status: "running" as const, startedAt: at(5), repo: "/Users/me/code/cy-agent", cwd: "/Users/me/.cy-agent/worktrees/cy-agent-abc", branch: "cy/split-abc123" };
  const s = sessionOfRun(run, [{ seq: 1, at: at(6), type: "tool_use", name: "Read", input: "a.ts" }], at(0));
  assert.deepEqual(s, { runId: "r1", title: "PR 과소분리 나누기", repo: "cy-agent", status: "running", last: "Read(a.ts)", startedAt: at(5), branch: "cy/split-abc123", askedAt: at(0) });
  const done = sessionOfRun({ ...run, status: "done", endedAt: at(60), prUrl: "https://github.com/o/r/pull/9", parentId: "r0" }, [], at(0));
  assert.equal(done.continued, true);
  assert.equal(done.askedAt, undefined);
  assert.equal(done.endedAt, at(60));
  assert.equal(done.prUrl, "https://github.com/o/r/pull/9");
  assert.equal(sessionOfRun({ ...run, repo: undefined }, [], "이상한 시각").repo, "cy-agent-abc"); // 레포 없으면 cwd 이름, 이상한 askedAt 은 버림
  assert.equal(sessionOfRun({ ...run, repo: undefined }, [], "이상한 시각").askedAt, undefined);
});

test("sessionsForThread: 그 대화의 수정 run 만(이어서 한 것도) · 마지막 줄은 맨 위 줄(서브에이전트 안쪽 제외) · askedAt 은 제안에서", () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const chat = reg.startRun({ kind: "chat", title: "채팅", ref: "th1" });
  chat.log({ type: "assistant", text: "작업 시작했어요" });
  const fix = reg.startRun({ kind: "fix", title: "다음 PR(과소분리 나누기)", repo: "/Users/me/code/cy-agent", branch: "cy/split-1", ref: "p1", origin: { type: "proposal", proposalId: "p1", threadId: "th1" } });
  fix.log({ type: "user", text: "계획…" });
  fix.log({ type: "tool_use", name: "Bash", input: "npm test", toolUseId: "b1" });
  fix.log({ type: "tool_use", name: "Agent", input: "조사", toolUseId: "A" });
  fix.log({ type: "tool_use", name: "Grep", input: "안쪽", toolUseId: "g", parent: "A" }); // 안쪽 줄은 마지막 줄로 안 씀
  const other = reg.startRun({ kind: "fix", title: "딴 대화", origin: { type: "proposal", proposalId: "p2", threadId: "th2" } });
  other.log({ type: "assistant", text: "x" });
  const asked = (pid: string) => (pid === "p1" ? at(-30) : undefined);

  let list = sessionsForThread(reg, "th1", asked);
  assert.deepEqual(list.map((s) => [s.runId, s.title, s.repo, s.branch, s.status, s.last, s.askedAt]), [
    [fix.id, "다음 PR(과소분리 나누기)", "cy-agent", "cy/split-1", "running", "Agent(조사)", at(-30)],
  ]);
  fix.log({ type: "system", text: "🚀 cy/split-1 푸시 완료" });
  fix.end("done");
  list = sessionsForThread(reg, "th1", asked);
  assert.equal(list[0].status, "done");
  assert.equal(list[0].last, "🚀 cy/split-1 푸시 완료"); // 끝남 status 줄은 마지막 줄로 안 씀
  assert.ok(list[0].endedAt);
  // 이어서 한 run: 원래 화면을 물려받아 같은 대화, continued
  const cont = reg.startRun({ kind: "fix", title: "다음 PR(과소분리 나누기) · 이어서", parentId: fix.id, ref: "p1" });
  list = sessionsForThread(reg, "th1", asked);
  assert.deepEqual(list.map((s) => [s.runId, s.continued, s.askedAt]), [[fix.id, undefined, at(-30)], [cont.id, true, undefined]]);
  assert.deepEqual(sessionsForThread(reg, "none"), []);
});

test("AgentsNotifier: 대화의 수정 run 은 진행 줄·시작·끝마다(≈모아서) 알린다 — 대화 밖 수정 run 은 안 알림", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const got: string[] = [];
  const n = new AgentsNotifier(reg, (t) => got.push(t), 20);
  try {
    const fix = reg.startRun({ kind: "fix", title: "수정", origin: { type: "proposal", proposalId: "p1", threadId: "th1" } });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1"]); // 시작
    fix.log({ type: "assistant", text: "보는 중" });
    fix.log({ type: "tool_use", name: "Read", input: "a", toolUseId: "x" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1"]);
    fix.log({ type: "tool_result", toolUseId: "x", output: "…" }); // 결과 줄은 카드가 안 바뀜
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1"]);
    fix.end("done");
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1", "th1"]);
    const lone = reg.startRun({ kind: "fix", title: "세션 창 새 작업" }); // 대화 밖
    lone.log({ type: "assistant", text: "x" });
    await new Promise((ok) => setTimeout(ok, 40));
    assert.deepEqual(got, ["th1", "th1", "th1"]);
  } finally { n.close(); }
});

test("GET /chat/threads/:id/agents → threadSessions 가 있으면 { agents, sessions }", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const fix = reg.startRun({ kind: "fix", title: "수정", repo: "/x/cy-agent", origin: { type: "proposal", proposalId: "p1", threadId: "th1" } });
  fix.log({ type: "assistant", text: "고치는 중" });
  const bus = new Bus();
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [], runs: reg,
    chatThreads: { list: () => [], create: () => ({}), edit: () => ({}), remove: () => true, messages: () => undefined },
    threadAgents: (id) => (id === "th1" ? agentsForThread(reg, id) : undefined),
    threadSessions: (id) => (id === "th1" ? sessionsForThread(reg, id) : undefined) });
  try {
    const r = await (await fetch(`http://127.0.0.1:${(bus.server!.address() as any).port}/chat/threads/th1/agents`)).json();
    assert.deepEqual(r.agents, []);
    assert.deepEqual(r.sessions.map((s: any) => [s.runId, s.repo, s.status, s.last]), [[fix.id, "cy-agent", "running", "고치는 중"]]);
  } finally { bus.close(); }
});
