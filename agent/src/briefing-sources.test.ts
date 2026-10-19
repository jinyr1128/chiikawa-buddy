// 브리핑 출처: 커넥터로 연결 안 된(또는 서버가 등록 안 된) 기능은 지시에서 빠지고 진행 말풍선도 안 뜬다 — 이정표는 성공한 데이터 호출에만
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefingMilestone, briefingTask, failedResult, readySources, sourceOf, BRIEFING_HEAD, type SourceId } from "./briefing-sources.ts";
import { BRIEFING_TASK } from "./brain.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { resolveConnectors, CONNECTORS } from "./connectors.ts";
import { Reactions } from "./reactions.ts";

// 메일·일정은 같은 서버(ms365 프리셋), Slack 은 사용자 토큰(api), 이슈는 GitHub MCP
const CONNS = resolveConnectors({}, { connectors: {
  mail: { mode: "mcp", preset: "ms-365" }, calendar: { mode: "mcp", preset: "ms-365" },
  slack: { mode: "api", userToken: "xoxp-real-token" }, issues: { mode: "mcp", preset: "github" },
} });
const NO_ISSUES = new Set<SourceId>(["mail", "calendar", "slack"]);
const ALL = new Set<SourceId>(["mail", "calendar", "slack", "issues"]);

test("브리핑 지시: 이슈 서버가 등록 안 돼 있으면 이슈 단계가 없고 찾지 말라고, 되어 있으면 그대로", () => {
  const no = briefingTask(CONNS, NO_ISSUES);
  assert.ok(no.startsWith(BRIEFING_HEAD));
  assert.doesNotMatch(no, /\d\) 이슈:/);
  assert.match(no, /이슈는 MCP 서버가 연결돼 있지 않다 — 찾거나\(도구 목록 검색 포함\) 부르지 말고 건너뛴다/);
  assert.match(no, /1\) 캘린더: .*\n2\) 메일: .*\n3\) slack: .*\n4\) 위 최근 세션/);
  const yes = briefingTask(CONNS, ALL);
  assert.match(yes, /4\) 이슈: 나에게 할당된 열린 이슈/);
  assert.match(yes, /mcp__github__search_issues/);
  assert.doesNotMatch(yes, /연결돼 있지 않다/);
  // 모르면(null) 설정된 건 다 시킨다
  assert.match(briefingTask(CONNS, null), /4\) 이슈/);
  assert.equal(BRIEFING_TASK, briefingTask(CONNECTORS));
  // 아무것도 연결 안 했으면 세션 맥락만
  const bare = briefingTask(resolveConnectors({}, {}), null);
  assert.match(bare, /1\) 위 최근 세션/);
  assert.doesNotMatch(bare, /slack|캘린더|메일|이슈:/);
});

test("이정표: 성공한 데이터 호출에만 — ToolSearch·맥락 도구·실패·연결 안 된 출처는 아무것도", () => {
  assert.equal(briefingMilestone("github.search_issues", true, CONNS, ALL), "이슈 보는 중이에요…");
  assert.equal(briefingMilestone("github.search_issues", true, CONNS, null), "이슈 보는 중이에요…");
  assert.equal(briefingMilestone("github.search_issues", true, CONNS, NO_ISSUES), null, "연결 안 된 이슈");
  assert.equal(briefingMilestone("github.search_issues", false, CONNS, ALL), null, "연결돼 있어도 실패하면");
  for (const st of ["mcp__github__search_issues", "ToolSearch", "cy.kg_search github", "code.Grep github", "gh.search_prs x"]) {
    assert.equal(briefingMilestone(st, true, CONNS, ALL), null, st);
  }
  assert.equal(briefingMilestone("ms365.list-mail-messages", true, CONNS, NO_ISSUES), "메일 확인하는 중이에요…");
  assert.equal(briefingMilestone("ms365.get-calendar-view", true, CONNS, NO_ISSUES), "오늘 일정 보는 중이에요…");
  assert.equal(sourceOf("unknown-server.search", CONNS), undefined);
});

test("쓸 수 있는 기능: api 는 비밀값이 있을 때, mcp 는 서버가 등록돼 있을 때", () => {
  assert.deepEqual([...readySources(CONNS, (n) => n === "ms365")].sort(), ["calendar", "mail", "slack"]);
  assert.deepEqual([...readySources(CONNS, () => true)].sort(), ["calendar", "issues", "mail", "slack"]);
  assert.deepEqual([...readySources(resolveConnectors({}, {}), () => true)], []);
});

test("실패한 결과: is_error · 미연결·권한 응답 글", () => {
  assert.equal(failedResult(true, "ok"), true);
  assert.equal(failedResult(false, '{"error":"service github is not connected"}'), true);
  assert.equal(failedResult(false, "서비스가 연결되지 않았어요. 먼저 연결하세요"), true);
  assert.equal(failedResult(false, '[{"key":"AX-1","summary":"error 로그 정리"}]'), false);
});

// ---- 데몬 브리핑: 연결 안 된 이슈면 지시에 없고 말풍선도 없다 ----
function briefingSetup(ready: ReadonlySet<SourceId> | null, results: [string, boolean][]) {
  const root = mkdtempSync(join(tmpdir(), "cy-brief-"));
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none"), connectors: CONNS };
  const bus = new Bus();
  bus.bubble = () => "x";
  bus.dashboardChanged = () => {};
  const tasks: string[] = [];
  const agent = new Agent(cfg, new Store(":memory:"), bus, undefined, {
    think: async (_c, _s, task, _step, opts) => {
      tasks.push(task);
      for (const [st, ok] of results) opts?.onResult?.(st, ok);
      return { bubble: "끝", reply_md: "## 오늘", todos: [], done_todo_ids: [], proposals: [] } as any;
    },
    git: async () => [],
    ready: () => ready,
  });
  const r = new Reactions(bus, { logPath: join(root, "reactions.json"), random: () => 0.99 });
  const steps: string[] = [];
  r.progress = () => ({ step: (t: string) => { steps.push(t); }, done: () => {}, fail: () => {} });
  agent.setReactions(r);
  return { agent, tasks, steps };
}

test("데몬 브리핑: 이슈 서버 미연결 — 지시에 이슈 단계 없음, 모델이 불러 봐도(실패)·ToolSearch 를 뒤져도 「이슈 보는 중」 없음", async () => {
  const s = briefingSetup(NO_ISSUES, [["ToolSearch", true], ["github.search_issues", false], ["github.search_issues", true], ["ms365.list-mail-messages", true]]);
  await s.agent.runBriefing();
  assert.doesNotMatch(s.tasks[0], /\d\) 이슈:/);
  assert.deepEqual(s.steps, ["메일 확인하는 중이에요…"]);
});

test("데몬 브리핑: 이슈 연결돼 있으면 그대로 — 성공한 이슈 호출에 「이슈 보는 중」(한 번만)", async () => {
  const s = briefingSetup(ALL, [["github.search_issues", false], ["github.search_issues", true], ["github.issue_read", true]]);
  await s.agent.runBriefing();
  assert.match(s.tasks[0], /4\) 이슈: 나에게 할당된 열린 이슈/);
  assert.deepEqual(s.steps, ["이슈 보는 중이에요…"]);
});
