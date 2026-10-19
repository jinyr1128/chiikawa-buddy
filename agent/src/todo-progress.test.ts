// 할 일 진행 확인: 작업 세션·작업 run 을 읽고 끝난 일 자동 완료(되돌리기 가능) · 진척 한 줄 · 새 기록 없으면 모델 안 부름
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig } from "./config.ts";
import { checkProgress, PROGRESS } from "./todo-progress.ts";
import { buildDashboard } from "./dashboard.ts";
import { buildContext } from "./brain.ts";

const NOW = new Date("2026-10-13T06:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60e3).toISOString();

function setup() {
  const store = new Store(":memory:");
  const cfg = loadConfig();
  const bus = new Bus();
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return "b"; };
  bus.dashboardChanged = () => {};
  const slack: SlackPort = { post: async () => ({ channel: "D0", ts: "1" }), update: async () => {} };
  const agent = new Agent(cfg, store, bus, slack, { think: async () => { throw new Error("no"); }, git: async () => [] });
  let changes = 0;
  agent.onChange(() => { changes++; });
  return { store, cfg, agent, bubbles, changes: () => changes };
}
// 가짜 모델: 프롬프트를 받아 결정 함수가 낸 결과를 돌려준다(가벼운 모델·도구 없음 확인)
function fakeQuery(cfg: any, decide: (prompt: string) => { done?: any[]; progress?: any[] }) {
  const calls: string[] = [];
  const q = ((args: any) => {
    calls.push(args.prompt);
    assert.equal(args.options.model, cfg.models.light);
    assert.deepEqual(args.options.tools, []);
    assert.equal(args.options.persistSession, false);
    const out = decide(args.prompt);
    return (async function* () { yield { type: "result", subtype: "success", structured_output: { done: out.done ?? [], progress: out.progress ?? [] }, total_cost_usd: 0.001 }; })();
  }) as any;
  return { q, calls };
}
const tAlias = (p: string, title: string) => new RegExp(`\\[(t\\d+)\\] ${title}`).exec(p)?.[1];
const wAlias = (p: string, needle: string) => new RegExp(`\\[([sr]\\d+)\\][^\\n]*${needle}`).exec(p)?.[1];
const fakeRuns = (list: any[] = [], outputs: Record<string, string> = {}) => ({
  listRuns: () => list,
  getRun: (id: string) => ({ run: list.find((r) => r.id === id), events: outputs[id] ? [{ seq: 1, at: "", type: "assistant", text: outputs[id] }] : [] }),
}) as any;

test("진행 확인: 끝난 일은 자동 완료(일지 by auto, 되돌리기 가능), 하는 중인 일엔 진척 한 줄 — 사용자 필드·휴지통은 그대로", async () => {
  const s = setup();
  s.store.upsertTodo({ id: "gh:pr-12", title: "cy-agent PR 12 머지", source: "session", priority: 1 });
  s.store.upsertTodo({ id: "session:report", title: "주간 보고서 초안 쓰기", source: "session", priority: 2 });
  s.store.editTodo("session:report", { note: "내 메모", title: "주간 보고서 초안 쓰기" });
  s.store.upsertTodo({ id: "mail:x", title: "견적 회신", source: "mail", priority: 2 });
  s.store.editTodo("mail:x", { status: "done" });
  s.store.editTodo("mail:x", { status: "open" }); // 사용자가 상태를 정함 → 자동으로 안 끝냄
  s.store.upsertTodo({ id: "jira:gone", title: "버린 일", source: "jira", priority: 2 });
  s.store.trashTodo("jira:gone");
  s.store.upsertNode("session:abc", "session", "PR 12 머지 마무리", { cwd: "/Users/me/code/cy-agent", lastPrompt: "PR 12 머지해", lastAssistant: "PR #12 머지 완료, main 에 반영됨" }, ago(20));
  s.store.upsertNode("session:def", "session", "보고서 작업", { cwd: "/Users/me/code/docs", lastPrompt: "보고서 1~2장 써줘", lastAssistant: "1·2장 초안 작성, 3장 남음" }, ago(10));
  s.store.upsertNode("session:old", "session", "옛 세션", { cwd: "/x" }, ago(60 * 30)); // lookback 밖
  const runs = fakeRuns([{ id: "R1", kind: "fix", title: "견적 회신 메일 보내기", status: "done", endedAt: ago(5), startedAt: ago(9) }], { R1: "견적 회신 보냄" });
  const { q, calls } = fakeQuery(s.cfg, (p) => ({
    done: [
      { todo: tAlias(p, "cy-agent PR 12 머지"), evidence: [wAlias(p, "PR 12 머지 마무리")], confidence: 0.95, reason: "PR 머지 완료" },
      { todo: tAlias(p, "견적 회신"), evidence: [wAlias(p, "견적 회신 메일")], confidence: 0.9, reason: "회신 보냄" },
      { todo: tAlias(p, "주간 보고서 초안 쓰기"), evidence: ["s99"], confidence: 0.9, reason: "?" },
    ],
    progress: [{ todo: tAlias(p, "주간 보고서 초안 쓰기"), note: "1·2장 초안 · 3장 남음" }],
  }));
  const r = await checkProgress(s.cfg, s.store, s.agent, { query: q, now: NOW, runs, log: () => {} });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /버린 일/); // 휴지통은 대상 아님
  assert.doesNotMatch(calls[0], /옛 세션/);
  assert.match(calls[0], /\[r1\][^\n]*비서 작업\(fix\)[\s\S]*결과: 견적 회신 보냄/);
  assert.deepEqual(r.done, ["gh:pr-12"]);
  assert.deepEqual(r.progressed, ["session:report"]);
  assert.deepEqual(r.rejected.map((x) => x.why).sort(), ["근거가 주어진 작업이 아님", "자동 완료 대상 아님(사용자가 상태를 정했거나 되돌림)"]);

  const pr = s.store.getTodo("gh:pr-12")!;
  assert.deepEqual([pr.status, pr.doneBy, pr.autoReason], ["done", "auto", "작업 기록: PR 머지 완료"]);
  assert.deepEqual(pr.autoEvidence, { ids: ["session:abc"] });
  const rep = s.store.getTodo("session:report")!;
  assert.deepEqual([rep.status, rep.note, rep.progress], ["open", "내 메모", "1·2장 초안 · 3장 남음"]);
  assert.equal(s.store.getTodo("mail:x")!.status, "open");
  assert.equal(s.store.trashedTodo("jira:gone")!.prevStatus, "open");
  const led = s.store.ledger({ actions: ["done", "progress"] }).filter((e) => e.by === "auto").map((e) => [e.todoId, e.action]);
  assert.deepEqual(led.sort(), [["gh:pr-12", "done"], ["session:report", "progress"]]);
  assert.ok(s.changes() > 0);
  // 되돌리기 → 다음 확인에서도 다시 안 끝냄
  assert.equal((s.agent.revertAutoTodo("gh:pr-12") as any).status, "open");
  // 대시보드·맥락에 진척
  const d = await buildDashboard(s.cfg, s.store, { git: async () => [] });
  assert.equal(d.todos.find((t) => t.id === "session:report")!.progress, "1·2장 초안 · 3장 남음");
  assert.match(buildContext(s.store), /주간 보고서 초안 쓰기 .*— 진행: 1·2장 초안 · 3장 남음/);

  // 새 세션이 생겨도 되돌린 할 일은 다시 안 끝낸다
  s.store.upsertNode("session:ghi", "session", "PR 12 후속", { cwd: "/Users/me/code/cy-agent", lastAssistant: "PR 12 머지 확인" }, new Date(NOW.getTime() + 5 * 60e3).toISOString());
  const again = fakeQuery(s.cfg, (p) => ({ done: [{ todo: tAlias(p, "cy-agent PR 12 머지"), evidence: [wAlias(p, "PR 12 후속")], confidence: 0.99, reason: "머지됨" }] }));
  const r2 = await checkProgress(s.cfg, s.store, s.agent, { query: again.q, now: new Date(NOW.getTime() + 30 * 60e3), runs: fakeRuns(), log: () => {} });
  assert.deepEqual(r2.done, []);
  assert.equal(s.store.getTodo("gh:pr-12")!.status, "open");
});

test("진행 확인: 새 세션·run 이 없으면 모델을 안 부르고, 할 일이 없어도 안 부른다. 확신도 낮으면 안 끝냄", async () => {
  const s = setup();
  const { q, calls } = fakeQuery(s.cfg, () => ({}));
  assert.equal((await checkProgress(s.cfg, s.store, s.agent, { query: q, now: NOW, runs: fakeRuns(), log: () => {} })).skipped, "no_todos");
  s.store.upsertTodo({ id: "a", title: "배포 확인", source: "session", priority: 2 });
  assert.equal((await checkProgress(s.cfg, s.store, s.agent, { query: q, now: NOW, runs: fakeRuns(), log: () => {} })).skipped, "no_activity");
  assert.equal(calls.length, 0);
  s.store.upsertNode("session:n", "session", "배포", { cwd: "/x", lastAssistant: "배포함" }, new Date(NOW.getTime() + 60e3).toISOString());
  const low = fakeQuery(s.cfg, (p) => ({ done: [{ todo: tAlias(p, "배포 확인"), evidence: [wAlias(p, "배포")], confidence: PROGRESS.threshold - 0.1, reason: "배포" }] }));
  const r = await checkProgress(s.cfg, s.store, s.agent, { query: low.q, now: new Date(NOW.getTime() + 2 * 60e3), runs: fakeRuns(), log: () => {} });
  assert.equal(r.called, true);
  assert.deepEqual(r.done, []);
  assert.equal(s.store.getTodo("a")!.status, "open");
  // 워터마크: 같은 세션은 다시 안 본다
  assert.equal((await checkProgress(s.cfg, s.store, s.agent, { query: low.q, now: new Date(NOW.getTime() + 3 * 60e3), runs: fakeRuns(), log: () => {} })).skipped, "no_activity");
  // 실패하면 워터마크를 안 넘겨 다음에 다시 본다
  s.store.upsertNode("session:m", "session", "또 배포", { cwd: "/x" }, new Date(NOW.getTime() + 4 * 60e3).toISOString());
  const bad = (() => (async function* () { yield { type: "result", subtype: "error_during_execution" }; })()) as any;
  const f = await checkProgress(s.cfg, s.store, s.agent, { query: bad, now: new Date(NOW.getTime() + 5 * 60e3), runs: fakeRuns(), log: () => {} });
  assert.match(f.error!, /실패/);
  const ok = fakeQuery(s.cfg, () => ({}));
  await checkProgress(s.cfg, s.store, s.agent, { query: ok.q, now: new Date(NOW.getTime() + 6 * 60e3), runs: fakeRuns(), log: () => {} });
  assert.equal(ok.calls.length, 1);
  assert.match(ok.calls[0], /또 배포/);
});
