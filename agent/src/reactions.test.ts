import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactions, fixMilestone, halfDayKey, mergeAskPrompt, testsFromLog, todoListMd, type MergeRec } from "./reactions.ts";
import { Bus, type BusHandlers } from "./bus.ts";
import { execFileSync } from "node:child_process";
import { Agent, type SlackPort } from "./core.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";

// KST 2026-10-08 10:00 = UTC 01:00
const at = (iso: string) => new Date(iso);
function setup(opts: Record<string, unknown> = {}, logPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cy-react-"));
  const bubbles: any[] = [], cleared: string[] = [];
  let now = at("2026-10-08T01:00:00Z");
  const bus = { bubble: (b: any) => { bubbles.push(b); return b.id ?? "x"; }, clear: (id: string) => { cleared.push(id); } };
  const path = logPath ?? join(dir, "reactions.json");
  const r = new Reactions(bus, { logPath: path, now: () => now, random: () => 0, progressGapMs: 0, ...opts });
  return { r, bubbles, cleared, path, setNow: (d: Date) => { now = d; } };
}
const todo = (id: string, priority = 2, extra: Record<string, unknown> = {}) => ({ id, title: `할 일 ${id}`, priority, status: "open", source: "slack", ...extra });
const done = (id: string, updated = "2026-10-08T02:00:00Z") => ({ id, title: id, status: "done", updated });

test("하루 진행률: 절반이면 한 번, 다 하면(3개 이상) 한 번 — 재시작해도 유지", () => {
  const s = setup();
  assert.equal(s.r.todoProgress([todo("a"), todo("b"), todo("c"), todo("d")], []), null);
  assert.equal(s.r.todoProgress([todo("c"), todo("d")], [done("a")]), null); // 1/4
  assert.equal(s.r.todoProgress([todo("d")], [done("a"), done("b")]), "half"); // 2/4
  assert.equal(s.bubbles.at(-1).image, "daily_half_complete");
  assert.equal(s.bubbles.at(-1).text, "벌써 절반 했어요! (2/3) 이 페이스 좋아요 💪 (기쁜 시사)");
  assert.equal(s.r.todoProgress([todo("d")], [done("a"), done("b"), done("c")]), null); // 절반은 한 번만
  // 재시작: 같은 기록 파일로 새로 만들어도 절반 응원은 다시 안 함, 추적 집합도 이어짐
  const s2 = setup({}, s.path);
  assert.equal(s2.r.todoProgress([todo("d")], [done("a"), done("b"), done("c")]), null);
  assert.equal(s2.r.todoProgress([], [done("a"), done("b"), done("c"), done("d")]), "all");
  assert.equal(s2.bubbles.at(-1).image, "daily_all_complete");
  assert.equal(s2.bubbles.at(-1).text, "오늘 할 일 4개 다 끝냈어요! 최고예요 🎉 (스이시~사)");
  assert.equal(s2.r.todoProgress([], [done("a"), done("b"), done("c"), done("d")]), null);
  assert.ok(JSON.parse(readFileSync(s.path, "utf8")).fired["all:2026-10-08"]);
});

test("하루 진행률: 2개뿐이면 다 해도 축하 없음, 지운 건 빼고 센다, 어제 끝낸 건 안 셈", () => {
  const s = setup();
  s.r.todoProgress([todo("a"), todo("b")], [done("y", "2026-10-07T02:00:00Z")]);
  assert.equal(s.r.todoProgress([], [done("a"), done("b")]), null); // total 2 → all 아님, 절반도 아님(done == total)
  const t = setup();
  t.r.todoProgress([todo("a"), todo("b"), todo("c"), todo("x")], []);
  // x 는 지워짐(열림도 끝남도 아님) → 3개 중 3개
  assert.equal(t.r.todoProgress([], [done("a"), done("b"), done("c")]), "all");
});

test("하루 진행률: 날이 바뀌면 새로", () => {
  const s = setup();
  s.r.todoProgress([todo("a"), todo("b")], []);
  assert.equal(s.r.todoProgress([todo("b")], [done("a")]), "half");
  s.setNow(at("2026-10-09T01:00:00Z"));
  assert.equal(s.r.todoProgress([todo("b"), todo("c")], []), null);
  assert.equal(s.r.todoProgress([todo("c")], [done("b", "2026-10-09T01:30:00Z")]), "half");
});

test("할 거 많다: P1+P2 문턱 이상, 반나절에 한 번", () => {
  const s = setup({ lotsThreshold: 3 });
  const many = [todo("a", 1), todo("b", 2), todo("c", 2), todo("d", 3)];
  assert.equal(s.r.lots(many.slice(0, 2), "briefing"), false);
  assert.equal(s.r.lots(many, "today"), true);
  assert.equal(s.bubbles.at(-1).image, "lots");
  assert.equal(s.bubbles.at(-1).text, "오늘 할 일이 많네요… 급한 것만 3개예요. 하나씩 같이 해 봐요 (비장한 시사)");
  assert.equal(s.r.lots(many, "briefing"), false); // 같은 오전
  s.setNow(at("2026-10-08T05:00:00Z")); // KST 14시
  assert.equal(halfDayKey(at("2026-10-08T05:00:00Z")), "2026-10-08:pm");
  assert.equal(s.r.lotsDue(many), true);
  assert.equal(s.r.lots(many, "briefing"), true);
});

test("daily: 별일 없는 브리핑에만, 하루 최대 2번", () => {
  const s = setup({ dailyChance: 1 });
  const b = { text: "평온", kind: "info" as const };
  assert.equal(s.r.briefingBubble(b, { notable: true }).image, undefined);
  assert.equal(s.r.briefingBubble(b, { notable: false }).image, "daily");
  assert.equal(s.r.briefingBubble(b, { notable: false }).image, "daily");
  assert.equal(s.r.briefingBubble(b, { notable: false }).image, undefined);
  const never = setup({ dailyChance: 0 });
  assert.equal(never.r.briefingBubble(b, { notable: false }).image, undefined);
});

test("새 할 일: to_do_new 스티커 + 목록 detail + 패널 할 일 열기", () => {
  const s = setup();
  assert.equal(s.r.newTodos([], "브리핑"), undefined);
  s.r.newTodos([todo("slack:1", 1, { description: "팀원이 물어봄" }), todo("mail:2", 2, { source: "mail" })], "브리핑");
  const b = s.bubbles.at(-1);
  assert.equal(b.image, "to_do_new");
  assert.equal(b.text, "새 할 일이 2개 생겼어요~");
  assert.deepEqual(b.open, { section: "todos", id: "slack:1" });
  assert.equal(b.detail, "- **[오늘 꼭]** 할 일 slack:1 · slack\n  팀원이 물어봄\n- **[이번 주]** 할 일 mail:2 · mail");
});

test("할 일 목록 마크다운: 1–3개는 글머리표, 4개 넘으면 표, 많으면 …외 N개, 표 칸의 | 는 바꿈", () => {
  assert.equal(todoListMd([todo("a", 1)], "브리핑"), "- **[오늘 꼭]** 할 일 a · slack");
  const many = Array.from({ length: 8 }, (_, i) => todo(`t${i}`, (i % 2) + 1, { title: i === 0 ? "A | B" : `일 ${i}` }));
  const md = todoListMd(many, "브리핑");
  const lines = md.split("\n");
  assert.equal(lines[0], "| | 할 일 | 출처 |");
  assert.equal(lines[1], "|---|---|---|");
  assert.equal(lines[2], "| **오늘 꼭** | A / B | slack |");
  assert.equal(lines.filter((l) => l.startsWith("| **")).length, 6);
  assert.match(md, /…외 2개$/);
  assert.equal(todoListMd([{ id: "x", title: "줄\n바꿈" }], "슬랙"), "- 줄 바꿈 · 슬랙");
});

test("진행 보고: 같은 말풍선을 이정표마다 교체, 조용한 작업은 금방 끝나면 안 보임", () => {
  const s = setup();
  const p = s.r.progress("x", "시작");
  p.step("둘째"); p.step("둘째"); // 같은 말은 한 번
  p.done("끝");
  p.step("늦은 단계"); // 끝난 뒤엔 무시
  assert.deepEqual(s.bubbles.map((b) => [b.id, b.text, b.kind]), [["progress:x", "시작", "info"], ["progress:x", "둘째", "info"], ["progress:x", "끝", "done"]]);
  const q = setup();
  const quiet = q.r.progress("y", "조용히", { quietMs: 60e3 });
  quiet.step("중간");
  quiet.done("결과");
  assert.equal(q.bubbles.length, 0);
  // 보인 적 있는 진행을 결과 없이 끝내면 지운다
  const c = setup();
  c.r.progress("z", "보임").done();
  assert.deepEqual(c.cleared, ["progress:z"]);
});

test("진행 보고: 간격 안의 단계는 묶는다", () => {
  const s = setup({ progressGapMs: 10_000 });
  const p = s.r.progress("x", "시작");
  p.step("a"); p.step("b");
  p.done("끝");
  assert.deepEqual(s.bubbles.map((b) => b.text), ["시작", "끝"]);
});

test("수정 이정표: 워크트리 → 수정 중 → 테스트 → 푸시, 중복 없이", () => {
  const seen = new Set<string>();
  const out = ["🌿 워크트리 cy/x (기준 main)", "Read a.ts", "Edit a.ts", "Edit b.ts", "$ npm test", "🧪 npm test", "🚀 푸시 완료"].map((s) => fixMilestone(s, seen));
  assert.deepEqual(out.filter(Boolean), ["워크트리 만드는 중이에요 🌿", "고치는 중이에요… ✏️", "테스트 돌리는 중이에~요 🧪", "테스트 통과했어요! ✅ 푸시했어요 (뿌듯한 시사)"]);
  assert.equal(testsFromLog(["🧪 npm test", "x"]), "npm test 통과");
  assert.equal(testsFromLog([]), undefined);
});

function mergeSetup(mergeImpl?: (rec: MergeRec) => Promise<string> | string) {
  const s = setup();
  const calls: string[] = [], resolved: [string, string][] = [];
  s.r.mergeDeps = {
    merge: mergeImpl ?? (async (rec) => { calls.push(rec.id); await new Promise((r) => setTimeout(r, 10)); return "✓ Squashed and merged"; }),
    ask: async (rec, q) => `'${rec.title}'는 파일 2개 바꿨어 (${q})`,
    resolved: (_rec, ack, via) => { resolved.push([ack, via]); },
  };
  s.r.offerMerge({ id: "p1", title: "버튼 색", prUrl: "https://github.com/x/y/pull/1", summary: "파랑으로" });
  return { ...s, calls, resolved };
}

test("머지: 묻기 → ✓ → merge_complete, 다시 눌러도 한 번만", async () => {
  const s = mergeSetup();
  const ask = s.bubbles.at(-1);
  assert.equal(ask.image, "merge");
  assert.equal(ask.actions, "merge");
  assert.equal(ask.proposalId, "p1");
  assert.match(ask.text, /'버튼 색' 머지할까요\?/);
  const r = await s.r.decideMerge("p1", "merge", "overlay");
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls, ["p1"]);
  const fin = s.bubbles.at(-1);
  assert.equal(fin.image, "merge_complete");
  assert.equal(fin.text, "머지했어요 🎉 (스이시~사)");
  assert.match(fin.detail, /Squashed/);
  assert.deepEqual(s.resolved, [["🎉 *머지 완료*", "overlay"]]);
  const again = await s.r.decideMerge("p1", "merge", "slack");
  assert.deepEqual([again.ok, again.already], [true, true]);
  assert.deepEqual(s.calls, ["p1"]);
  const no = await s.r.decideMerge("p1", "decline", "overlay");
  assert.equal(no.ok, false);
  assert.equal((no as any).status, 409);
});

test("머지: Slack·오버레이가 동시에 ✓ → gh 는 한 번, 둘 다 성공", async () => {
  const s = mergeSetup();
  const [a, b] = await Promise.all([s.r.decideMerge("p1", "merge", "overlay"), s.r.decideMerge("p1", "merge", "slack")]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(s.calls, ["p1"]);
  assert.equal(s.r.merge("p1")!.state, "merged");
});

test("머지: ✗ 먼저면 Slack ✓ 는 머지 안 함(먼저 답한 쪽이 이김)", async () => {
  const s = mergeSetup();
  const no = await s.r.decideMerge("p1", "decline", "overlay");
  assert.equal(no.ok, true);
  assert.match(s.bubbles.at(-1).text, /PR은 열어 둘게요/);
  assert.deepEqual(s.resolved, [["⏸️ *머지 안 함* — PR은 열어둠", "overlay"]]);
  const yes = await s.r.decideMerge("p1", "merge", "slack");
  assert.equal(yes.ok, false);
  assert.deepEqual(s.calls, []);
  assert.equal((await s.r.decideMerge("p1", "decline", "slack")).ok, true); // 같은 결정은 멱등
  // 재시작해도 결정 유지
  const s2 = setup({}, s.path);
  assert.equal(s2.r.merge("p1")!.state, "declined");
});

test("머지: 실패하면 다시 묻는 상태로, 재시도 가능", async () => {
  let fail = true;
  const s = mergeSetup(() => { if (fail) throw Object.assign(new Error("x"), { stderr: "merge conflict\nmore" }); return "ok"; });
  const r = await s.r.decideMerge("p1", "merge", "overlay");
  assert.equal(r.ok, false);
  assert.equal(s.r.merge("p1")!.state, "asking");
  assert.equal(s.bubbles.at(-1).actions, "merge");
  assert.match(s.bubbles.at(-1).text, /merge conflict/);
  fail = false;
  assert.equal((await s.r.decideMerge("p1", "merge", "overlay")).ok, true);
});

test("머지 추가질문: 답은 같은 말풍선(✓/✗ 유지), 끝난 뒤엔 409", async () => {
  const s = mergeSetup();
  const a = await s.r.askMerge("p1", "뭐 바꿨어?");
  assert.deepEqual(a, { ok: true, reply: "'버튼 색'는 파일 2개 바꿨어 (뭐 바꿨어?)" });
  const b = s.bubbles.at(-1);
  assert.equal(b.id, "merge:p1");
  assert.equal(b.actions, "merge");
  assert.equal(b.image, undefined);
  assert.equal((await s.r.askMerge("nope", "?") as any).status, 404);
  await s.r.decideMerge("p1", "merge", "overlay");
  assert.equal((await s.r.askMerge("p1", "?") as any).status, 409);
});

test("머지: 기록에 없으면 lookup(기능 이전 PR), 없으면 404", async () => {
  const s = setup();
  const calls: string[] = [];
  s.r.mergeDeps = { merge: (rec) => { calls.push(rec.prUrl); return "ok"; }, lookup: (id) => (id === "old" ? { id, title: "옛 PR", prUrl: "https://g/pr/9", state: "asking", at: "" } : undefined) };
  assert.equal((await s.r.decideMerge("old", "merge", "slack")).ok, true);
  assert.deepEqual(calls, ["https://g/pr/9"]);
  assert.equal((await s.r.decideMerge("zzz", "merge", "slack") as any).status, 404);
});

test("추가질문 프롬프트에 PR 정보·테스트·질문", () => {
  const p = mergeAskPrompt({ id: "p", title: "T", prUrl: "https://u", state: "asking", at: "", summary: "S", tests: "npm test 통과" }, "변경: 파일 2개", "위험해?");
  for (const s of ["T", "https://u", "S", "npm test 통과", "변경: 파일 2개", "위험해?"]) assert.ok(p.includes(s), s);
});

test("bus: 머지 라우트 — 헤더 없으면 403, merge/decline-merge/ask, 상태 코드 전달", async () => {
  const bus = new Bus();
  const calls: string[] = [];
  const h: BusHandlers = {
    approve: async () => 0, hold: async () => 0, briefing: async () => 0, dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    mergeDecide: async (id, d) => { calls.push(`${d}:${id}`); return id === "gone" ? { ok: false, status: 404, error: "x" } : { ok: true, state: d === "merge" ? "merged" : "declined" }; },
    mergeAsk: async (id, text) => { calls.push(`ask:${id}:${text}`); return { ok: true, reply: "응" }; },
  };
  await bus.listen(0, h);
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, body?: unknown, headers: Record<string, string> = { "X-CY-Agent": "1" }) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await post("/proposals/p1/merge", undefined, {})).status, 403);
    assert.equal((await post("/proposals/p1/merge", undefined, { "X-CY-Agent": "1", Origin: "https://evil.example" })).status, 403);
    const m = await post("/proposals/p1/merge");
    assert.equal(m.status, 200);
    assert.equal((await m.json()).state, "merged");
    assert.equal((await post("/proposals/p1/decline-merge")).status, 200);
    assert.equal((await post("/proposals/gone/merge")).status, 404);
    const a = await post("/proposals/p1/ask", { text: " 뭐 바꿨어? " });
    assert.deepEqual(await a.json(), { ok: true, reply: "응" });
    assert.equal((await post("/proposals/p1/ask", { text: "" })).status, 400);
    assert.deepEqual(calls, ["merge:p1", "decline:p1", "merge:gone", "ask:p1:뭐 바꿨어?"]);
  } finally {
    bus.close();
  }
});

test("bus: 머지 핸들러가 없으면 503", async () => {
  const bus = new Bus();
  await bus.listen(0, { approve: async () => 0, hold: async () => 0, briefing: async () => 0, dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/proposals/p1/merge`, { method: "POST", headers: { "X-CY-Agent": "1" } })).status, 503);
  } finally {
    bus.close();
  }
});

// ---- core 연결: 실행 → 머지 질문(Slack 메시지 기억) → 오버레이 ✓ → Slack 메시지 정리, Slack ✓ 는 이미 머지 ----

function agentSetup() {
  const root = mkdtempSync(join(tmpdir(), "cy-react-core-"));
  execFileSync("git", ["init", "-q", join(root, "app")]);
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none") };
  const store = new Store(":memory:");
  const bus = new Bus();
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  bus.dashboardChanged = () => {};
  const posts: any[] = [], updates: any[] = [];
  let n = 0;
  const slack: SlackPort = {
    post: async (blocks, text) => { posts.push({ blocks, text }); return { channel: "D1", ts: String(++n) }; },
    update: async (_c, ts, blocks, text) => { updates.push({ ts, blocks, text }); },
  };
  const merged: string[] = [], pins: (string | undefined)[] = [];
  const thought = {
    bubble: "할 일 정리했어", reply_md: "## 오늘",
    todos: [{ key: "slack:1", title: "팀원 답장", source: "slack", priority: 2, description: "패널 질문" }],
    done_todo_ids: [], proposals: [{ repo: join(root, "app"), title: "버튼 색", plan: "파랑" }],
  };
  const agent = new Agent(cfg as any, store, bus, slack, {
    think: async () => thought as any,
    runFix: async (_c, _p, step) => { step("🌿 워크트리 cy/b"); step("Edit a.ts"); step("🧪 npm test"); step("🚀 푸시 완료"); return { ok: true, summary: "바꿈", prUrl: "https://github.com/x/y/pull/1", branch: "cy/b", log: ["🧪 npm test"], headOid: "d".repeat(40) }; },
    mergePr: (url, sha) => { merged.push(url); pins.push(sha); return "merged"; },
    git: async () => [],
  });
  const r = new Reactions(bus, { logPath: join(root, "reactions.json"), random: () => 0.99, progressGapMs: 0 });
  agent.setReactions(r, async () => "답");
  return { agent, store, bubbles, posts, updates, merged, pins, r };
}

test("core: 브리핑 새 할 일 → to_do_new, 실행 이정표 → 머지 질문, 오버레이 ✓ 뒤 Slack ✓ 는 이미 머지", async () => {
  const s = agentSetup();
  await s.agent.runBriefing();
  const nb = s.bubbles.find((b) => b.image === "to_do_new");
  assert.ok(nb, "to_do_new 말풍선");
  assert.deepEqual(nb.open, { section: "todos", id: "slack:1" });
  const pid = s.bubbles.find((b) => b.kind === "proposal").proposalId;
  await s.agent.approve(pid);
  await s.agent.fixIdle();
  const prog = s.bubbles.filter((b) => b.id === `progress:fix:${pid}`).map((b) => b.text);
  assert.deepEqual(prog, ["'버튼 색' 해 볼게요 — 워크트리 만드는 중이에요 🌿", "워크트리 만드는 중이에요 🌿", "고치는 중이에요… ✏️", "테스트 돌리는 중이에~요 🧪", "테스트 통과했어요! ✅ 푸시했어요 (뿌듯한 시사)", "PR 올렸어요 — 🚀 (스이시~사)"]);
  const ask = s.bubbles.at(-1);
  assert.deepEqual([ask.id, ask.image, ask.actions], [`merge:${pid}`, "merge", "merge"]);
  assert.equal(s.r.merge(pid)!.tests, "npm test 통과");
  const mergeMsgTs = s.posts.findIndex((p) => p.text.startsWith("완료")) + 1;
  assert.deepEqual(s.r.merge(pid)!.slack, { channel: "D1", ts: String(mergeMsgTs) });

  const r = await s.agent.mergeDecide(pid, "merge");
  assert.equal(r.ok, true);
  assert.deepEqual(s.merged, ["https://github.com/x/y/pull/1"]);
  assert.deepEqual(s.pins, ["d".repeat(40)]); // 수정 run 이 푸시한 커밋으로 고정(그 사이 새 커밋이면 gh 가 거절)
  assert.equal(s.bubbles.at(-1).image, "merge_complete");
  const up = s.updates.find((u) => u.ts === String(mergeMsgTs));
  assert.ok(up && /머지 완료/.test(up.text), "Slack 머지 메시지 정리");
  assert.equal(await s.agent.merge(pid), "이미 머지했어요"); // Slack 버튼 늦게 눌림
  assert.equal(s.merged.length, 1);
});

test("core: ✗ 뒤 Slack 머지 버튼은 오류(머지 안 함)", async () => {
  const s = agentSetup();
  await s.agent.runBriefing();
  const pid = s.bubbles.find((b) => b.kind === "proposal").proposalId;
  await s.agent.approve(pid);
  await s.agent.fixIdle();
  assert.equal((await s.agent.mergeDecide(pid, "decline")).ok, true);
  await assert.rejects(s.agent.merge(pid), /머지 안 하기로/);
  assert.deepEqual(s.merged, []);
});
