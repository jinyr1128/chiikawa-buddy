// 되살아남 막기(다른 id 로 다시 올라온 같은 일) · 할 일 일지(일별 기록) · 재시작 브리핑 건너뛰기
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, type SlackPort } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store, kstDay } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildContext } from "./brain.ts";
import { briefingDue, briefingTask } from "./briefing-sources.ts";
import { ctxHandlers } from "./ctx-tools.ts";
import { ledgerContext, ledgerDay, removedRecently } from "./todo-ledger.ts";
import { linkRef, normRef, sameItem, similarTitle } from "./todo-match.ts";

test("todo-match: 참조 키 정규화·링크 키·제목 비슷함(숫자가 다르면 다른 일)", () => {
  assert.equal(normRef("slack:C1:1791772040.560799"), normRef("slack:C1:1791772040560799"));
  assert.equal(normRef("session:cy-agent"), undefined); // 거친 키는 비교 안 함
  assert.equal(normRef("other:x"), undefined);
  assert.equal(linkRef("https://x.slack.com/archives/C1/p1791772040560799?thread_ts=1"), "slack:C1:1791772040560799");
  assert.equal(linkRef("https://github.com/a/b/pull/269"), "gh:a/b#269");
  assert.equal(linkRef("https://outlook.office.com/mail/"), undefined);
  assert.ok(similarTitle("VPN 연결 후 Metrics 수집 재실행", "Metrics 수집기 실패 — VPN 연결 후 재실행"));
  assert.ok(!similarTitle("오늘(10/9) 데일리 스크럼 제출하기", "오늘(10/10) 데일리 스크럼 제출하기"));
  assert.ok(!similarTitle("박민지 님 DM 확인 후 답하기", "박민지 님 질문 답하기: 미티 유저 이관 11월 초로 미룰지"));
  assert.equal(sameItem({ id: "mail:9", title: "x", sourceRef: "slack:C1:1.2" }, { id: "slack:C1:12", title: "y" }), "ref");
  assert.equal(sameItem({ id: "session:a", title: "x", sourceRef: "session:cy-agent" }, { id: "session:b", title: "y", sourceRef: "session:cy-agent" }), undefined);
});

test("store: 휴지통에 넣은 일은 새 id·새 참조로 다시 와도 안 생긴다(blocked) — 일지에 하루 한 번", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "metrics:vpn-collector-failure", title: "Metrics 수집기 실패 — VPN 연결 후 재실행", source: "metrics", priority: 2 });
  s.trashTodo("metrics:vpn-collector-failure");
  assert.equal(s.upsertTodo({ id: "other:metrics-vpn-recollect", title: "VPN 연결 후 Metrics 수집 재실행", source: "other", priority: 1 }), "blocked");
  assert.equal(s.upsertTodo({ id: "other:metrics-vpn-recollect", title: "VPN 연결 후 Metrics 수집 재실행", source: "other", priority: 1 }), "blocked");
  assert.equal(s.getTodo("other:metrics-vpn-recollect"), undefined);
  const blocked = s.ledger({ actions: ["blocked"] });
  assert.equal(blocked.length, 1, "같은 날 같은 막힘은 한 번만");
  assert.match(blocked[0].detail!, /지운 일 metrics:vpn-collector-failure \(title\)/);
  // 참조 키(Slack 메시지)로도: 점 있는 ts 든 없는 ts 든, 링크로 와도
  s.upsertTodo({ id: "slack:C9:1791856486420439", title: "박민지 님 질문 답하기", source: "slack", priority: 1 });
  s.trashTodo("slack:C9:1791856486420439");
  assert.equal(s.upsertTodo({ id: "mail:x", title: "완전히 다른 제목", source: "mail", priority: 1, sourceRef: "slack:C9:1791856486.420439" }), "blocked");
  assert.equal(s.upsertTodo({ id: "other:y", title: "또 다른 제목", source: "other", priority: 1, link: "https://t.slack.com/archives/C9/p1791856486420439" }), "blocked");
  // 영구 삭제(묘비만 남음) 뒤에도
  s.purgeTodo("metrics:vpn-collector-failure");
  assert.equal(s.upsertTodo({ id: "session:metrics-vpn-check", title: "VPN 연결 후 Metrics 수집 재실행하기", source: "session", priority: 2 }), "blocked");
  // 되살리면 다시 열린 할 일 — 그땐 새 id 는 그 할 일로 합쳐진다
  s.restoreTodo("slack:C9:1791856486420439");
  assert.equal(s.upsertTodo({ id: "mail:x", title: "완전히 다른 제목", source: "mail", priority: 1, sourceRef: "slack:C9:1791856486.420439" }), "merged");
  // 관계없는 새 일은 그대로 생긴다
  assert.equal(s.upsertTodo({ id: "jira:CY-1", title: "로그인 버그 고치기", source: "jira", priority: 2 }), "added");
});

test("store: 끝낸 일은 최근(2일) 것만 막고, 날짜가 다른 반복 일은 새로 생긴다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "metrics:scrum:2026-10-09", title: "오늘(10/9) 데일리 스크럼 제출하기", source: "metrics", priority: 1 });
  s.editTodo("metrics:scrum:2026-10-09", { status: "done" });
  assert.equal(s.upsertTodo({ id: "other:scrum-today", title: "오늘(10/9) 데일리 스크럼 제출", source: "other", priority: 1 }), "blocked");
  assert.equal(s.upsertTodo({ id: "metrics:scrum:2026-10-10", title: "오늘(10/10) 데일리 스크럼 제출하기", source: "metrics", priority: 1 }), "added");
  // 오래전에 끝낸 일과 비슷한 건 막지 않는다
  s.upsertTodo({ id: "mail:old", title: "분기 보고서 정리하기", source: "mail", priority: 2 });
  s.editTodo("mail:old", { status: "done" });
  s.db.prepare("UPDATE todos SET updated = '2026-01-01T00:00:00.000Z' WHERE id = 'mail:old'").run();
  assert.equal(s.upsertTodo({ id: "mail:new", title: "분기 보고서 정리하기", source: "mail", priority: 2 }), "added");
});

test("store: 열린 할 일과 같은 일이 새 id 로 오면 합치고, 사용자가 고친 필드는 그대로", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "session:jira-reconnect", title: "Jira·Metrics MCP 재연결하기", source: "session", priority: 1, link: "https://a" });
  s.editTodo("session:jira-reconnect", { title: "MCP 다시 붙이기(내가 고침)", priority: 3, note: "금요일에" });
  // 사용자가 제목을 고쳤어도 일지에 남은 예전 제목으로 알아본다
  const r = s.upsertTodo({ id: "other:jira-metrics-reconnect-1013", title: "Jira·Metrics MCP 재연결하기", source: "other", priority: 1, link: "https://b", description: "설명" });
  assert.equal(r, "merged");
  assert.equal(s.getTodo("other:jira-metrics-reconnect-1013"), undefined);
  const t = s.getTodo("session:jira-reconnect")!;
  assert.deepEqual([t.title, t.priority, t.note], ["MCP 다시 붙이기(내가 고침)", 3, "금요일에"]); // 사용자 것 그대로
  assert.equal(t.link, "https://b"); // 사용자가 안 고친 링크는 브리핑 것으로
  assert.equal(t.description, "설명"); // 비어 있던 설명은 채운다
  assert.equal(s.openTodos().length, 1);
  assert.equal(s.ledger({ actions: ["merged"] })[0].todoId, "session:jira-reconnect");
});

test("할 일 일지: 경로마다 누가 무엇을 했는지 일별로, 예전 DB 는 처음 열 때 채운다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 1 }); // 브리핑이 우선순위 올림
  s.editTodo("mail:1", { note: "내일" });
  const u = s.addTodo({ title: "직접 넣은 일" });
  s.ruleUpdateTodo(u.id, { priority: 4 });
  s.editTodo(u.id, { status: "done" });
  s.setTodoStatus("mail:1", "done", { by: "briefing" });
  s.trashTodo("mail:1");
  s.restoreTodo("mail:1");
  s.upsertTodo({ id: "jira:2", title: "이슈 보기", source: "jira", priority: 2 });
  s.autoCompleteTodo("jira:2", { reason: "PR 머지됨", evidence: { ids: ["x"] } });
  s.revertAutoTodo("jira:2");
  assert.equal(s.setTodoProgress("jira:2", "  리뷰 반영 중 \n PR 올림 "), true);
  assert.equal(s.setTodoProgress("jira:2", "리뷰 반영 중 PR 올림"), false, "같은 글이면 안 남김");
  assert.equal(s.getTodo("jira:2")!.progress, "리뷰 반영 중 PR 올림");
  assert.deepEqual(s.getTodo("jira:2")!.userEdited, ["status"], "진행 메모는 사용자 편집 아님");

  const rows = s.ledger({ limit: 100 }).reverse().map((e) => `${e.todoId === u.id ? "u" : e.todoId} ${e.action} ${e.by}`);
  assert.deepEqual(rows, [
    "mail:1 added briefing", "mail:1 edited briefing", "mail:1 edited user",
    "u added user", "u edited rule", "u done user",
    "mail:1 done briefing", "mail:1 trashed user", "mail:1 restored user",
    "jira:2 added briefing", "jira:2 done auto", "jira:2 reopened user", "jira:2 progress auto",
  ]);
  const today = kstDay(new Date());
  assert.equal(s.ledger({ day: today }).length, rows.length);
  assert.deepEqual(s.ledgerDays(), [{ day: today, count: rows.length }]);
  assert.equal(ledgerDay(s).day, today);

  // 예전 DB: 지금 있는 할 일·휴지통·묘비로 한 번 채운다
  const path = join(mkdtempSync(join(tmpdir(), "cy-ledger-")), "cy.db");
  const a = new Store(path);
  a.upsertTodo({ id: "x:1", title: "지운 일", source: "x", priority: 2 });
  a.upsertTodo({ id: "x:2", title: "끝낸 일", source: "x", priority: 2 });
  a.trashTodo("x:1", "2026-10-12T01:00:00.000Z");
  a.setTodoStatus("x:2", "done", { by: "auto" });
  a.db.exec("DROP TABLE todo_ledger");
  a.db.close();
  const b = new Store(path);
  assert.deepEqual(b.ledger({ actions: ["trashed", "done"] }).map((e) => [e.todoId, e.action, e.by, e.day]).sort(),
    [["x:1", "trashed", "user", "2026-10-12"], ["x:2", "done", "auto", kstDay(new Date())]]);
  b.db.close();
  const c = new Store(path); // 두 번 열어도 다시 채우지 않는다
  assert.equal(c.ledger({ actions: ["added"] }).length, 2);
});

test("일지 기억: 지운 일·끝낸 일(되살린 건 빠짐)이 브리핑 맥락·cy todos_list history·브리핑 지시에", async () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "other:jira-reconnect-20261013", title: "Jira 연결 재인증하기", source: "other", priority: 1 });
  s.upsertTodo({ id: "mail:2", title: "되살린 일", source: "mail", priority: 2 });
  s.upsertTodo({ id: "mail:3", title: "끝낸 일", source: "mail", priority: 2 });
  s.trashTodo("other:jira-reconnect-20261013");
  s.trashTodo("mail:2");
  s.restoreTodo("mail:2");
  s.editTodo("mail:3", { status: "done" });
  assert.deepEqual(removedRecently(s).map((e) => [e.todoId, e.action]).sort(), [["mail:3", "done"], ["other:jira-reconnect-20261013", "trashed"]]);
  const ctx = buildContext(s);
  assert.match(ctx, /## 최근 14일 지우거나 끝낸 할 일[^\n]*다시 올리지 마라\)\n- \d\d-\d\d 휴지통\(사용자\) id=other:jira-reconnect-20261013 Jira 연결 재인증하기/);
  assert.doesNotMatch(ledgerContext(s), /되살린 일/);
  const out = await ctxHandlers(loadConfig(), s).todos_list({ status: "history" });
  assert.match(out.content[0].text, /휴지통\(사용자\) id=other:jira-reconnect-20261013/);
  assert.match(briefingTask(null), /같은 일이면 그 id 를 key 로 그대로 쓴다/);
  assert.match(briefingTask(null), /key·제목을 바꿔서라도 다시 올리지 않는다/);
});

test("briefingDue: 마지막 브리핑이 간격 안이면 재시작해도 건너뛴다", () => {
  const now = Date.parse("2026-10-13T05:00:00Z");
  assert.equal(briefingDue(null, 60, now), true);
  assert.equal(briefingDue({ at: "2026-10-13T04:30:00Z" }, 60, now), false);
  assert.equal(briefingDue({ at: "2026-10-13T04:00:00Z" }, 60, now), true);
  assert.equal(briefingDue({ at: "이상한 값" }, 60, now), true);
  const s = new Store(":memory:");
  s.saveBriefing({ bubble: "b", replyMd: "r" });
  assert.equal(briefingDue(s.latestBriefing(), 60), false); // 방금 브리핑 → 재시작 직후엔 안 함
});

test("Agent 브리핑: 지운 일을 새 key 로 올려도 안 생기고, 사용자가 고친 열린 일도 그대로", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-ledger-agent-"));
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none") };
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.bubble = (b) => b.id ?? "x";
  bus.dashboardChanged = () => {};
  const slack: SlackPort = { post: async () => ({ channel: "D1", ts: "1" }), update: async () => {} };
  let todos: any[] = [
    { key: "other:ms365-jira-reconnect", title: "MS365·Jira MCP 재연결하기", source: "other", priority: 1 },
    { key: "mail:report", title: "주간 보고서 보내기", source: "mail", priority: 2 },
  ];
  const agent = new Agent(cfg, store, bus, slack, {
    think: async () => ({ bubble: "응", reply_md: "r", todos, done_todo_ids: [], proposals: [] }),
    runFix: async () => ({ ok: true, summary: "", log: [] }) as any, mergePr: () => "", git: async () => [],
  } as any);
  await agent.runBriefing();
  agent.deleteTodo("other:ms365-jira-reconnect");
  agent.editTodo("mail:report", { priority: 4, title: "주간 보고서(금요일)" });
  // 다음 브리핑(예: 재시작 뒤): 같은 일을 다른 key·조금 다른 제목으로
  todos = [
    { key: "session:ms365-jira-mcp-reconnect", title: "MS365·Jira MCP 다시 재연결하기", source: "session", priority: 1 },
    { key: "mail:weekly-report-1013", title: "주간 보고서 보내기", source: "mail", priority: 1 },
  ];
  await agent.runBriefing();
  assert.deepEqual(store.openTodos().map((t) => [t.id, t.title, t.priority]), [["mail:report", "주간 보고서(금요일)", 4]]);
  assert.equal(store.trashCount(), 1);
  const blocked = store.ledger({ actions: ["blocked"] })[0];
  assert.deepEqual([blocked.todoId, blocked.by], ["session:ms365-jira-mcp-reconnect", "briefing"]);
  assert.match(blocked.detail!, /지운 일 other:ms365-jira-reconnect/);
  assert.equal(agent.todoLedger().entries.some((e) => e.action === "merged" && e.todoId === "mail:report"), true);
});

test("bus: GET /todos/ledger?day= — 형식 틀리면 400, 핸들러 없으면 503", async () => {
  const bus = new Bus();
  const days: (string | undefined)[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoLedger: (day) => { days.push(day); return { day: day ?? "2026-10-13", entries: [], days: [] }; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/todos/ledger`)).json(), { day: "2026-10-13", entries: [], days: [] });
    assert.equal((await fetch(`${base}/todos/ledger?day=2026-10-12`)).status, 200);
    assert.equal((await fetch(`${base}/todos/ledger?day=${encodeURIComponent("어제")}`)).status, 400);
    assert.deepEqual(days, [undefined, "2026-10-12"]);
  } finally { bus.close(); }
  const bare = new Bus();
  await bare.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  try { assert.equal((await fetch(`http://127.0.0.1:${(bare.server!.address() as any).port}/todos/ledger`)).status, 503); } finally { bare.close(); }
});
