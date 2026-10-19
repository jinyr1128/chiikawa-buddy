import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyCall } from "./guard.ts";
import { resolveConnectors, brainAllowedTools } from "./connectors.ts";

test("개인 설정: mcp 커넥터는 매핑된 읽기 도구만, 쓰기 이름은 매핑에 있어도 차단", () => {
  const c = resolveConnectors({}, {
    connectors: {
      slack: { mode: "api", userToken: "xoxp-test" },
      calendar: { mode: "mcp", preset: "google-calendar" },
      mail: { mode: "mcp", preset: "gmail", tools: { read: "send_email" } },
      issues: { mode: "mcp", preset: "github" },
    },
  });
  const ok = (n: string, i: unknown = {}) => isReadOnlyCall(n, i, c).allow;
  assert.equal(ok("mcp__google-calendar__list-events"), true);
  assert.equal(ok("mcp__google-calendar__create-event"), false);
  assert.equal(ok("mcp__google-calendar__get-freebusy"), false, "매핑 밖");
  assert.equal(ok("mcp__gmail__search_emails"), true);
  assert.equal(ok("mcp__gmail__send_email"), false);
  assert.equal(ok("mcp__github__issue_read"), true);
  assert.equal(ok("mcp__github__search_pull_requests"), true);
  assert.equal(ok("mcp__github__create_issue"), false);
  assert.equal(ok("mcp__other__list_things"), false, "모르는 서버");
  assert.equal(ok("mcp__gw__invoke", { service: "slack", tool: "slack_search_messages" }), false);
  const allowed = brainAllowedTools(c);
  assert.ok(allowed.includes("mcp__github__search_issues"));
  assert.ok(!allowed.includes("mcp__gmail__send_email"));
  assert.ok(!allowed.some((t) => t.includes("*")), "매핑이 있으면 와일드카드 없음");
});

test("mcp 매핑을 안 채우면 서버 전체 + 읽기 이름만, 같은 서버를 두 기능이 쓰면 매핑을 합친다", () => {
  const c = resolveConnectors({}, { connectors: { issues: { mode: "mcp", server: "atlassian" }, calendar: { mode: "mcp", preset: "ms-365" }, mail: { mode: "mcp", preset: "ms-365" } } });
  assert.deepEqual(brainAllowedTools(c).filter((t) => t.startsWith("mcp__atlassian")), ["mcp__atlassian__*"]);
  assert.equal(isReadOnlyCall("mcp__atlassian__searchJiraIssuesUsingJql", {}, c).allow, true);
  assert.equal(isReadOnlyCall("mcp__atlassian__editJiraIssue", {}, c).allow, false);
  assert.equal(isReadOnlyCall("mcp__atlassian__doSomething", {}, c).allow, false);
  assert.equal(isReadOnlyCall("mcp__ms365__get-calendar-view", {}, c).allow, true);
  assert.equal(isReadOnlyCall("mcp__ms365__list-mail-messages", {}, c).allow, true);
  assert.equal(isReadOnlyCall("mcp__ms365__send-mail", {}, c).allow, false);
});

test("gateway 모드는 지원하지 않아 읽기 목록에 안 들어간다", () => {
  const c = resolveConnectors({}, { connectors: { slack: "gateway", calendar: "off", mail: "off", issues: "off" } });
  assert.equal(c.slack.mode, "off");
  assert.equal(isReadOnlyCall("mcp__gw__invoke", { service: "slack", tool: "slack_search_messages" }, c).allow, false);
});

test("전부 off 면 내장 도구 말고는 아무것도", () => {
  const c = resolveConnectors({}, {});
  assert.deepEqual(brainAllowedTools(c), ["ToolSearch", "StructuredOutput"]);
  assert.equal(isReadOnlyCall("mcp__gw__invoke", { service: "slack", tool: "slack_search_messages" }, c).allow, false);
  assert.equal(isReadOnlyCall("StructuredOutput", {}, c).allow, true);
  assert.equal(isReadOnlyCall("Bash", { command: "ls" }, c).allow, false);
});

test("열린 서버(매핑 없음): 위쪽 프로젝트의 쓰기 도구는 이름에 읽기 말이 섞여도 막는다", () => {
  const c = resolveConnectors({}, { connectors: { mail: { mode: "mcp", server: "m" }, calendar: { mode: "mcp", server: "ms365" }, slack: { mode: "mcp", server: "slack" } } });
  const ok = (n: string) => isReadOnlyCall(n, {}, c).allow;
  // Gmail(GongRzhe) batch_modify_emails · ms-365 set-my-status-message(kebab set) 는 예전에 통과했다
  for (const w of ["mcp__m__batch_modify_emails", "mcp__m__modify_email", "mcp__ms365__set-my-status-message", "mcp__ms365__copy-mail-message",
    "mcp__slack__slack_send_message", "mcp__slack__slack_send_message_draft", "mcp__slack__slack_schedule_message", "mcp__slack__slack_update_canvas",
    "mcp__slack__slack_add_reaction", "mcp__slack__slack_create_conversation", "mcp__slack__slack_get_file_upload_url", "mcp__slack__slack_complete_file_upload"]) assert.equal(ok(w), false, w);
  for (const r of ["mcp__m__search_emails", "mcp__m__read_email", "mcp__ms365__list-mail-messages", "mcp__ms365__get-calendar-view",
    "mcp__slack__slack_search_public_and_private", "mcp__slack__slack_read_channel", "mcp__slack__slack_read_thread", "mcp__slack__slack_search_users"]) assert.equal(ok(r), true, r);
});
