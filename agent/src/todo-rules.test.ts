import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TodoRules, evaluateRules, parseRule, parseRulePatch, ruleChanges, ruleMatches, ruleSummary, rulesContext, safeRegex, withNote,
  type RuleProposal, type TodoRule,
} from "./todo-rules.ts";
import { Agent, type SlackPort } from "./core.ts";
import { Bus, type BusHandlers } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildContext } from "./brain.ts";
import { buildDashboard } from "./dashboard.ts";
import { parsePatch, parseNew, opPatch } from "./todos.ts";
import { todoCanvasMarkdown } from "./slack/canvas.ts";
import { Reactions } from "./reactions.ts";
import { askPrompt } from "./todo-ask.ts";

const SEMINAR: RuleProposal = { text: "앞으로 모든 세미나는 우선순위 매우 낮음", match: { keywords: ["세미나"], description: "제목에 세미나" }, effect: { backlog: true, priority: 4 } };

test("parseRule: 엄격한 검증 — 키·길이·효과·출처, backlog는 P4로", () => {
  const ok = parseRule({ text: "  앞으로  세미나는 백로그 ", match: { keywords: ["세미나", "세미나", "seminar"], description: "세미나" }, effect: { backlog: true } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { text: "앞으로 세미나는 백로그", match: { keywords: ["세미나", "seminar"], description: "세미나" }, effect: { backlog: true, priority: 4 } });
  const bad = [
    null, [], {}, { text: "x", match: { keywords: ["세미나"] }, effect: {} }, // 효과 없음
    { text: "x", match: { description: "" }, effect: { priority: 4 } }, // 조건 없음
    { text: "x", match: { keywords: ["k"] }, effect: { priority: 4 } }, // 너무 짧은 낱말
    { text: "x", match: { keywords: Array.from({ length: 11 }, (_, i) => `kw${i}`) }, effect: { priority: 4 } },
    { text: "x", match: { keywords: ["세미나"] }, effect: { priority: 5 } },
    { text: "x", match: { sources: ["evil"] }, effect: { priority: 4 } },
    { text: "x", match: { keywords: ["세미나"], extra: 1 }, effect: { priority: 4 } },
    { text: "x", match: { keywords: ["세미나"] }, effect: { priority: 4, delete: true } },
    { text: "x", match: { titleRegex: "(a+)+$" }, effect: { priority: 4 } },
    { text: "x", match: { keywords: ["세미나"] }, effect: { priority: 4 }, evil: 1 },
  ];
  for (const b of bad) assert.equal(parseRule(b).ok, false, JSON.stringify(b));
  // 출처만으로도, skip·note도 된다
  assert.ok(parseRule({ text: "jira는 다 P2", match: { sources: ["jira"], description: "" }, effect: { priority: 2 } }).ok);
  assert.ok(parseRule({ text: "봇 알림은 올리지 마", match: { keywords: ["github bot"], description: "" }, effect: { skip: true } }).ok);
});

test("safeRegex: 짧고 안전한 정규식만(역참조·후방탐색·중첩 수량자·큰 반복 거절)", () => {
  assert.ok(safeRegex("^제\\d+회 세미나"));
  assert.ok(safeRegex("(?:세미나|seminar)"));
  for (const bad of ["(a+)+", "(a|b*)*", "(\\w+\\s?)+$", "(a)\\1", "(?<=x)y", "a{1,999}", "a{2,}", "[", "x".repeat(101), "", 42]) {
    assert.equal(safeRegex(bad), null, String(bad));
  }
});

test("ruleMatches·evaluateRules: 제목 낱말(대소문자·전각 무시), 출처 AND, 최근 규칙이 이김, skip", () => {
  const r = (id: string, p: RuleProposal, created: string, enabled = true): TodoRule => ({ id, ...parseRule(p).ok ? (parseRule(p) as any).value : p, enabled, created, hits: 0 });
  const sem = r("r1", SEMINAR, "2026-10-01");
  assert.ok(ruleMatches(sem, { title: "제134회 세미나(10/15 목 10:00) 참석 여부 정하기" }));
  assert.ok(ruleMatches(r("nfkc", { text: "t", match: { keywords: ["seminar"], description: "" }, effect: { priority: 4 } }, "2026-10-01"), { title: "ＳＥＭＩＮＡＲ 신청" })); // NFKC
  assert.ok(!ruleMatches(sem, { title: "견적 회신" }));
  const slackOnly = r("r2", { text: "슬랙 세미나는 P3", match: { keywords: ["세미나"], sources: ["slack"], description: "" }, effect: { priority: 3, note: "슬랙 공지" } }, "2026-10-05");
  assert.ok(!ruleMatches(slackOnly, { title: "세미나", source: "mail" }));
  assert.ok(ruleMatches(slackOnly, { title: "세미나", source: "slack" }));
  // 최근 규칙(r2)이 우선순위·메모를 정한다
  assert.deepEqual(evaluateRules([sem, slackOnly], { title: "세미나 참석", source: "slack" }), { skip: false, ruleIds: ["r2", "r1"], rule: { id: "r2", text: "슬랙 세미나는 P3" }, priority: 3, note: "슬랙 공지" });
  assert.deepEqual(evaluateRules([sem, slackOnly], { title: "세미나 참석", source: "mail" }), { skip: false, ruleIds: ["r1"], rule: { id: "r1", text: SEMINAR.text }, priority: 4 });
  // 꺼진 규칙은 안 본다
  assert.deepEqual(evaluateRules([{ ...sem, enabled: false }], { title: "세미나" }), { skip: false, ruleIds: [] });
  const skip = r("r3", { text: "봇 알림 무시", match: { keywords: ["dependabot"], description: "" }, effect: { skip: true } }, "2026-10-06");
  assert.equal(evaluateRules([skip], { title: "Dependabot PR 3개" }).skip, true);
  assert.equal(withNote("기존", "추가"), "기존 · 추가");
  assert.equal(withNote("기존 · 추가", "추가"), "기존 · 추가");
  assert.match(ruleSummary(sem), /제목에 "세미나" → 언젠가·백로그\(P4\)/);
  assert.match(rulesContext([sem, { ...skip, enabled: false }]), /앞으로 모든 세미나는 우선순위 매우 낮음/);
  assert.doesNotMatch(rulesContext([sem, { ...skip, enabled: false }]), /봇 알림/);
  assert.equal(rulesContext([]), "");
});

test("ruleChanges: 맞는 열린 할 일 전부, 직접 정한 우선순위는 건너뜀(force 예외), exclude", () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "제134회 세미나 참석 여부", source: "slack", priority: 2 });
  store.upsertTodo({ id: "b", title: "세미나 135회 신청", source: "mail", priority: 3 });
  store.upsertTodo({ id: "c", title: "세미나 발표 자료", source: "mail", priority: 1 });
  store.upsertTodo({ id: "d", title: "견적 회신", source: "mail", priority: 2 });
  store.editTodo("c", { priority: 1 }); // 사용자가 직접 정함
  const r = ruleChanges(SEMINAR, store.openTodos());
  assert.deepEqual(r.changes.map((c) => [c.id, c.before.priority, c.after.priority]), [["a", 2, 4], ["b", 3, 4]]);
  assert.deepEqual(r.skipped.map((x) => x.id), ["c"]);
  assert.deepEqual(ruleChanges(SEMINAR, store.openTodos(), { force: ["c"] }).changes.map((c) => c.id).sort(), ["a", "b", "c"]);
  assert.deepEqual(ruleChanges(SEMINAR, store.openTodos(), { exclude: ["a"] }).changes.map((c) => c.id), ["b"]);
});

test("TodoRules: 테이블 마이그레이션(예전 DB), 추가·같은 규칙 합치기·켜기/끄기·지우기·적중 수", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-rules-"));
  const path = join(dir, "cy.db");
  new Store(path).db.close(); // 예전 DB(규칙 테이블 없음)
  const store = new Store(path);
  const rules = new TodoRules(store);
  const a = rules.add(parseRule(SEMINAR).ok ? (parseRule(SEMINAR) as any).value : SEMINAR);
  assert.match(a.id, /^rule:/);
  assert.equal(rules.add({ ...SEMINAR, text: "세미나는 백로그" }).id, a.id); // 같은 조건·효과 → 하나
  assert.equal(rules.list().length, 1);
  assert.equal(rules.get(a.id)!.text, "세미나는 백로그");
  rules.hit([a.id], 3);
  assert.equal(rules.get(a.id)!.hits, 3);
  assert.equal(rules.edit(a.id, { enabled: false })!.enabled, false);
  assert.equal(rules.enabled().length, 0);
  assert.equal(rules.edit("nope", { enabled: true }), undefined);
  assert.equal(rules.delete(a.id), true);
  assert.equal(rules.delete(a.id), false);
  // 깨진 행은 건너뛴다
  store.db.prepare("INSERT INTO todo_rules (id, text, match, effect, created) VALUES ('rule:x', 't', '{bad', '{}', '2026')").run();
  assert.deepEqual(rules.list(), []);
  assert.deepEqual(parseRulePatch({ enabled: true, text: "  새 글 " }), { ok: true, value: { enabled: true, text: "새 글" } });
  for (const b of [{}, { enabled: "y" }, { text: "" }, { evil: 1 }]) assert.equal(parseRulePatch(b as any).ok, false);
});

// ---- Agent: 팝오버 미리보기·적용·거절, 모든 생성 경로에 결정적 적용, 사용자 편집 우선 ----
function setup(think?: any, extra: Record<string, unknown> = {}) {
  const cfg = { ...loadConfig(), repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" };
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.bubble = (b) => b.id ?? "x";
  bus.dashboardChanged = () => {};
  bus.setMood = () => {};
  const posts: any[] = [];
  const slack: SlackPort = { post: async (blocks, text) => { posts.push({ blocks, text }); return { channel: "D1", ts: "1" }; }, update: async () => {} };
  const agent = new Agent(cfg, store, bus, slack, { think: think ?? (async () => ({ bubble: "", reply_md: "", todos: [], done_todo_ids: [], proposals: [] })), git: async () => [], ...extra });
  return { agent, store, posts };
}
const feedback = (store: Store) => store.db.prepare("SELECT kind, ref, note FROM profile_feedback ORDER BY n").all() as any[];

test("팝오버: 지속 지시 → 규칙 미리보기(집어 든 것 + 맞는 다른 할 일 전부), ✓면 저장·적용, ✗면 학습 신호", async () => {
  const s = setup(undefined, {
    askTodo: async (_c: unknown, _s: unknown, todo: any) => ({ reply: "앞으로 세미나는 백로그로 보낼까?", todo_ops: [{ op: "edit", id: todo.id, priority: 4 }], rule: SEMINAR }),
  });
  s.store.upsertTodo({ id: "slack:1", title: "제134회 세미나(10/15 목 10:00) 참석 여부 정하기", source: "slack", priority: 2 });
  s.store.upsertTodo({ id: "mail:2", title: "제135회 세미나 사전 신청", source: "mail", priority: 3 });
  s.store.upsertTodo({ id: "mail:3", title: "견적 회신", source: "mail", priority: 2 });
  const r = (await s.agent.askTodo("slack:1", "야 앞으로 모든 세미나는 우선순위 매우 낮음"))!;
  assert.deepEqual(r.ops, [{ op: "edit", id: "slack:1", priority: 4 }]);
  assert.equal(r.rule!.proposal.text, SEMINAR.text);
  // 집어 든 것은 ops가 다루니 규칙 변화엔 다른 세미나만
  assert.deepEqual(r.rule!.changes.map((c) => [c.id, c.before.priority, c.after.priority]), [["mail:2", 3, 4]]);
  assert.equal(s.agent.todoRules().length, 0); // 묻기는 아무것도 안 바꾼다
  assert.equal(s.store.getTodo("mail:2")!.priority, 3);

  // ✗: 규칙까지 거절했다는 학습 신호
  assert.equal(s.agent.rejectAsk("slack:1", "야 앞으로", r.ops, SEMINAR), true);
  assert.match(feedback(s.store).at(-1).note, /규칙 "앞으로 모든 세미나는/);

  // ✓: 할 일 변경 + 규칙 저장 + 맞는 기존 할 일 적용(직접 수정 표시 없이, 규칙 기록)
  const ok = s.agent.applyAsk("slack:1", r.ops, r.rev, SEMINAR) as any;
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ruleChanged, ["mail:2"]);
  assert.equal(s.store.getTodo("slack:1")!.priority, 4);
  assert.equal(s.store.getTodo("slack:1")!.appliedRule!.text, SEMINAR.text); // ops가 바꿨어도 규칙 기록
  const m2 = s.store.getTodo("mail:2")!;
  assert.equal(m2.priority, 4);
  assert.deepEqual(m2.userEdited, []);
  assert.equal(m2.appliedRule!.text, SEMINAR.text);
  assert.equal(s.store.getTodo("mail:3")!.priority, 2);
  const rule = s.agent.todoRules()[0];
  assert.equal(rule.hits, 2);
  assert.equal(feedback(s.store).at(-1).kind, "todo_rule_added");
  // 잘못된 규칙은 400용 이유, 규칙만 있어도(ops 없음) 적용된다
  assert.deepEqual(s.agent.applyAsk("mail:3", [], undefined, { text: "x" }), { ok: false, reason: "bad_rule", error: "rule match required" });
  assert.equal((s.agent.applyAsk("mail:3", [], undefined, { ...SEMINAR, match: { keywords: ["견적"], description: "" } }) as any).ok, true);
  assert.equal(s.store.getTodo("mail:3")!.priority, 4);
});

test("팝오버: ops가 집어 든 할 일 우선순위를 안 건드리면 규칙이 그것도 바꾼다(직접 정한 우선순위여도), stale은 규칙 미리보기 다시", async () => {
  const s = setup(undefined, { askTodo: async () => ({ reply: "규칙만 만들까?", todo_ops: [], rule: SEMINAR }) });
  s.store.upsertTodo({ id: "a", title: "세미나 참석", source: "slack", priority: 1 });
  s.store.upsertTodo({ id: "b", title: "세미나 발표", source: "slack", priority: 2 });
  s.store.editTodo("a", { priority: 1 });
  s.store.editTodo("b", { priority: 2 });
  const r = (await s.agent.askTodo("a", "앞으로 세미나는 백로그"))!;
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.rule!.changes.map((c) => c.id), ["a"]);
  assert.deepEqual(r.rule!.skipped.map((c) => c.id), ["b"]); // 다른 할 일의 직접 정한 우선순위는 그대로
  s.store.editTodo("a", { note: "바뀜" });
  const stale = s.agent.applyAsk("a", [], r.rev, SEMINAR) as any;
  assert.equal(stale.reason, "stale");
  assert.deepEqual(stale.rule.changes.map((c: any) => c.id), ["a"]);
  assert.equal((s.agent.applyAsk("a", [], stale.rev, SEMINAR) as any).ok, true);
  assert.equal(s.store.getTodo("a")!.priority, 4);
  assert.equal(s.store.getTodo("b")!.priority, 2);
});

test("규칙은 모든 생성 경로에 결정적으로: 브리핑(skip 포함)·채팅/DM add·직접 추가·팝오버 add, 사용자 편집이 이긴다", async () => {
  let thought: any = { bubble: "b", reply_md: "r", done_todo_ids: [], proposals: [], todos: [
    { key: "slack:k1", title: "제136회 세미나 참석", source: "slack", priority: 2 },
    { key: "mail:x", title: "견적 회신", source: "mail", priority: 1 },
    { key: "mail:bot", title: "Dependabot 알림", source: "mail", priority: 3 },
  ] };
  const s = setup(async () => thought, { askTodo: async () => ({ reply: "", todo_ops: [{ op: "add", title: "세미나 후기 정리", priority: 2 }], rule: null }) });
  s.agent.addRule(SEMINAR);
  s.agent.addRule({ text: "봇 알림은 올리지 마", match: { keywords: ["dependabot"], description: "" }, effect: { skip: true } });
  // 1) 정기 브리핑(absorb)
  await s.agent.runBriefing();
  const k1 = s.store.getTodo("slack:k1")!;
  assert.equal(k1.priority, 4);
  assert.equal(k1.appliedRule!.text, SEMINAR.text);
  assert.equal(s.store.getTodo("mail:x")!.priority, 1);
  assert.equal(s.store.getTodo("mail:x")!.appliedRule, undefined);
  assert.equal(s.store.getTodo("mail:bot"), undefined); // skip
  // 브리핑이 다시 올려도 규칙이 유지, 사용자가 직접 옮기면 그게 이긴다
  thought = { ...thought, todos: [{ key: "slack:k1", title: "제136회 세미나 참석", source: "slack", priority: 1 }] };
  await s.agent.runBriefing();
  assert.equal(s.store.getTodo("slack:k1")!.priority, 4);
  s.agent.reorderTodo("slack:k1", 2);
  await s.agent.runBriefing();
  assert.equal(s.store.getTodo("slack:k1")!.priority, 2);
  // 2) 패널 직접 추가(POST /todos) — 고른 우선순위보다 규칙
  const added = s.agent.addTodo({ title: "세미나 137회", priority: 2 });
  assert.equal(added.priority, 4);
  assert.equal(added.appliedRule!.text, SEMINAR.text);
  // skip은 사용자가 직접 만든 할 일엔 적용 안 함
  assert.equal(s.agent.addTodo({ title: "Dependabot 정리", priority: 2 }).priority, 2);
  // 3) 채팅·DM todo_ops add
  const r = s.agent.applyTodoOps([{ op: "add", title: "세미나 좌석 신청", priority: 1 }]);
  assert.equal(r.added[0].priority, 4);
  // 4) DM 요청: 규칙과 add가 같이 오면 규칙 먼저 저장
  thought = { bubble: "b", reply_md: "알았어", todos: [], done_todo_ids: [], proposals: [],
    todo_ops: [{ op: "add", title: "팀 워크숍 신청", priority: 2 }],
    rule: { text: "워크숍은 다 P3", match: { keywords: ["워크숍"], description: "" }, effect: { priority: 3 } } };
  await s.agent.handleRequest("앞으로 워크숍은 다 P3, 그리고 팀 워크숍 신청 추가해줘");
  assert.equal(s.store.openTodos().find((t) => t.title === "팀 워크숍 신청")!.priority, 3);
  assert.match(s.posts.at(-1).blocks[0].text, /📏 규칙 저장: 워크숍은 다 P3/);
  // 5) 팝오버 add
  s.store.upsertTodo({ id: "focus", title: "아무거나", source: "mail", priority: 2 });
  const ask = (await s.agent.askTodo("focus", "세미나 후기 정리도 추가"))!;
  const ap = s.agent.applyAsk("focus", ask.ops, ask.rev) as any;
  assert.equal(ap.added[0].priority, 4);
  // 적중 수가 쌓인다
  const sem = s.agent.todoRules().find((x) => x.text === SEMINAR.text)!;
  assert.ok(sem.hits >= 4, String(sem.hits));
  // 끄면 더 이상 적용 안 함, 지우면 학습 신호
  s.agent.editRule(sem.id, { enabled: false });
  assert.equal(s.agent.addTodo({ title: "세미나 138회", priority: 2 }).priority, 2);
  assert.equal(s.agent.deleteRule(sem.id), true);
  assert.equal(feedback(s.store).at(-1).kind, "todo_rule_removed");
});

test("채팅: 모델이 낸 규칙은 바로 저장·적용하고 답에 한 줄, 잘못된 규칙은 경고", async () => {
  const replies = [
    { reply_md: "알았어", bubble: "", show: null, proposals: [], todo_ops: [], rule: SEMINAR },
    { reply_md: "음", bubble: "", show: null, proposals: [], todo_ops: [], rule: { text: "x" } },
  ];
  const s = setup(undefined, { converse: async () => replies.shift() });
  s.store.upsertTodo({ id: "a", title: "세미나 참석", source: "slack", priority: 2 });
  s.agent.chat("앞으로 세미나는 백로그");
  s.agent.chat("이상한 규칙");
  await s.agent.chatIdle();
  const hist = s.store.chatHistory(10).filter((t) => t.role === "assistant").map((t) => t.text);
  assert.match(hist[0], /📏 규칙 저장: 앞으로 모든 세미나는 우선순위 매우 낮음 — 제목에 "세미나" → 언젠가·백로그\(P4\) \(지금 있는 1개도 바꿈\)/);
  assert.match(hist[1], /⚠️ 규칙은 저장하지 못했어요/);
  assert.equal(s.store.getTodo("a")!.priority, 4);
});

test("프롬프트: 켜진 규칙을 브리핑·팝오버 맥락에 짧게, 백로그(P4)는 따로", () => {
  const s = setup();
  s.agent.addRule(SEMINAR);
  s.store.upsertTodo({ id: "a", title: "세미나 참석", source: "slack", priority: 4 });
  s.store.upsertTodo({ id: "b", title: "견적 회신", source: "mail", priority: 1 });
  const ctx = buildContext(s.store, new Date("2026-10-08T01:00:00Z"));
  assert.match(ctx, /## 할 일 규칙[^\n]*\n- "앞으로 모든 세미나는 우선순위 매우 낮음" — 제목에 "세미나" → 언젠가·백로그\(P4\)/);
  const open = ctx.slice(ctx.indexOf("## 현재 열린 할 일"), ctx.indexOf("## 언젠가·백로그"));
  assert.match(open, /\[P1\] 견적 회신/);
  assert.doesNotMatch(open, /세미나 참석/);
  assert.match(ctx.slice(ctx.indexOf("## 언젠가·백로그")), /id=a \[P4\] 세미나 참석/);
  assert.match(askPrompt(s.store, s.store.getTodo("b")!, "x"), /## 할 일 규칙/);
});

test("P4(백로그): 검증·저장·순서·캔버스·대시보드·반응 집계", async () => {
  assert.deepEqual(parsePatch({ priority: 4 }), { ok: true, value: { priority: 4 } });
  assert.equal(parsePatch({ priority: 5 }).ok, false);
  assert.equal(parseNew({ title: "x", priority: 4 }).ok, true);
  assert.deepEqual(opPatch({ op: "edit", id: "a", priority: 4 }), { ok: true, value: { priority: 4 } });
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "언젠가 정리", source: "other", priority: 4 });
  store.upsertTodo({ id: "b", title: "급함", source: "mail", priority: 1 });
  store.upsertTodo({ id: "c", title: "참고", source: "mail", priority: 3 });
  assert.deepEqual(store.openTodos().map((t) => t.id), ["b", "c", "a"]); // P4는 맨 뒤
  assert.equal((store.reorderTodo("c", 4, "a") as any).priority, 4);
  assert.deepEqual(store.openTodos().map((t) => t.id), ["b", "c", "a"]);
  const md = todoCanvasMarkdown(store.openTodos(), new Date("2026-10-08T01:00:00Z"));
  assert.match(md, /열린 일 1개 · 백로그 2개/);
  assert.match(md, /## 🗂 언젠가 · 백로그 \(2\)\n- \[ \] 참고/);
  const d = await buildDashboard(loadConfig(), store, { git: async () => [] });
  assert.deepEqual(d.todos.map((t) => t.priority), [1, 4, 4]);
  assert.deepEqual(d.todoRules, []);
  // 반응: 백로그는 '할 거 많다'·하루 진행률에서 빠진다
  const bubbles: any[] = [];
  const r = new Reactions({ bubble: (b: any) => { bubbles.push(b); return "x"; }, clear: () => {} },
    { logPath: join(mkdtempSync(join(tmpdir(), "cy-p4-")), "r.json"), now: () => new Date("2026-10-08T01:00:00Z"), random: () => 0, lotsThreshold: 2 });
  const t = (id: string, priority: number, status = "open") => ({ id, title: id, priority, status, updated: "2026-10-08T00:30:00Z" });
  assert.equal(r.lotsDue([t("x", 4), t("y", 4), t("z", 1)]), false);
  // 오늘 본 할 일: 열린 P1 하나 + 끝낸 P4 셋 → P4를 빼면 0/1이라 '절반'도 아님
  assert.equal(r.todoProgress([t("p1", 1)], [t("d1", 4, "done"), t("d2", 4, "done"), t("d3", 4, "done")]), null);
  assert.equal(r.todoProgress([], [t("p1", 1, "done"), t("d1", 4, "done")]), null); // 1개뿐(3개 미만) → '다 했다' 아님
});

test("버스: GET /todo-rules, POST /todo-rules/:id(검증·404), /delete, apply에 rule(ops 비어도), reject에 rule, reorder P4", async () => {
  const calls: any[] = [];
  const bus = new Bus();
  const h: BusHandlers = {
    approve: async () => {}, hold: async () => {}, briefing: async () => {}, dashboard: async () => ({}), todoDone: () => true,
    chat: () => "c", chatHistory: () => [],
    todoRules: () => [{ id: "rule:1", text: "t" }],
    todoRuleEdit: (id, p) => { calls.push(["edit", id, p]); return id === "rule:1" ? { id, ...p } : undefined; },
    todoRuleDelete: (id) => { calls.push(["del", id]); return id === "rule:1"; },
    todoApply: (id, ops, rev, rule) => { calls.push(["apply", id, ops, rev, rule]); return (rule as any)?.text === "bad" ? { ok: false, reason: "bad_rule", error: "x" } : { ok: true }; },
    todoReject: (id, text, ops, rule) => { calls.push(["reject", id, text, ops, rule]); return true; },
    todoReorder: (id, p) => { calls.push(["reorder", id, p]); return { id }; },
  };
  await bus.listen(0, h);
  const port = (bus.server!.address() as any).port;
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/todo-rules`)).json(), { rules: [{ id: "rule:1", text: "t" }] });
    assert.equal((await post("/todo-rules/rule%3A1", { enabled: false })).status, 200);
    assert.equal((await post("/todo-rules/rule%3A1", { enabled: "no" })).status, 400);
    assert.equal((await post("/todo-rules/rule%3A1", { evil: 1 })).status, 400);
    assert.equal((await post("/todo-rules/nope", { text: "x" })).status, 404);
    assert.equal((await post("/todo-rules/rule%3A1/delete", {})).status, 200);
    assert.equal((await post("/todo-rules/nope/delete", {})).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/todo-rules/rule%3A1`, { method: "POST", body: "{}" })).status, 403); // CSRF
    assert.equal((await post("/todos/a/apply", { rule: SEMINAR })).status, 200); // ops 없이 규칙만
    assert.equal((await post("/todos/a/apply", { ops: [] })).status, 400); // 둘 다 없으면 400
    assert.equal((await post("/todos/a/apply", { ops: [], rule: "x" })).status, 400);
    assert.equal((await post("/todos/a/apply", { ops: [], rule: { text: "bad" } })).status, 400);
    assert.equal((await post("/todos/a/reject", { ops: [], rule: SEMINAR })).status, 200);
    assert.equal((await post("/todos/reorder", { id: "a", priority: 4 })).status, 200);
    assert.deepEqual(calls.filter((c) => c[0] === "edit"), [["edit", "rule:1", { enabled: false }], ["edit", "nope", { text: "x" }]]);
    assert.deepEqual(calls.find((c) => c[0] === "apply"), ["apply", "a", [], undefined, SEMINAR]);
    assert.deepEqual(calls.find((c) => c[0] === "reject")?.[4], SEMINAR);
  } finally {
    bus.close();
  }
});
