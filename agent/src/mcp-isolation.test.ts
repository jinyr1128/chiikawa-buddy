// 브리핑·채팅(Claude Code 뇌)은 커넥터로 연결한 MCP 서버만 쓴다. ~/.claude.json 의 다른 서버는 읽기 도구여도 막힌다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { resolveConnectors } from "./connectors.ts";
import { allowedMcpServers, hiddenMcpRules, mcpNameOf, mcpServerVerdict } from "./guard.ts";
import { registeredMcpServerNames } from "./mcp.ts";
import { mcpIsolation, toolOptions } from "./brain.ts";
import { PermissionBroker, PermissionRules, isAutoAllowed, type PermQueue } from "./permissions.ts";
import { Store } from "./store.ts";

const conns = resolveConnectors({}, { connectors: { slack: { mode: "mcp", server: "slack" }, issues: { mode: "mcp", server: "atlassian" } } } as any);
const cfg = (): Config => ({ ...loadConfig({}, {}), connectors: conns, repoRoots: [], github: { enabled: false } });
const pre = (tool_name: string, tool_input: unknown = {}) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "/x", cwd: "/", tool_use_id: "tu" }) as any;
const decision = (out: any) => out?.hookSpecificOutput?.permissionDecision;
const asked: string[] = [];
const queue: PermQueue = { requestPermission(r: any) { asked.push(r.toolName); return { decision: Promise.resolve({ behavior: "deny", message: "아니요" }) } as any; } };

test("고치기 전 확인: 연결 안 한 서버의 읽기 도구는 승인 카드 없이 그냥 허용되던 길(isAutoAllowed)이 있다", () => {
  // 이 길을 훅이 먼저 막는지 아래 시험이 본다
  assert.equal(isAutoAllowed("mcp__company__search_docs", {}, { roots: [], brainDir: "/b", cwd: "/b" } as any), true);
});

test("mcpServerVerdict: 커넥터 서버·gh·cy 만, 그 밖의 MCP 도구·리소스는 막는다", () => {
  const allowed = allowedMcpServers(conns);
  assert.deepEqual(allowed.sort(), ["atlassian", "cy", "gh", "slack"]);
  assert.equal(mcpServerVerdict("mcp__slack__slack_search_public", {}, allowed).allow, true);
  assert.equal(mcpServerVerdict("mcp__cy__todos_list", {}, allowed).allow, true);
  assert.equal(mcpServerVerdict("mcp__company__search_docs", {}, allowed).allow, false);
  assert.equal(mcpServerVerdict("mcp__claude_ai_Gmail__search", {}, allowed).allow, false);
  assert.equal(mcpServerVerdict("mcp__slackbot__read", {}, allowed).allow, false); // 이름 앞부분만 같은 서버
  assert.equal(mcpServerVerdict("Read", {}, allowed).allow, true); // MCP 가 아닌 도구는 다른 훅이 본다
  assert.equal(mcpServerVerdict("ReadMcpResourceTool", { server: "company", uri: "x" }, allowed).allow, false);
  assert.equal(mcpServerVerdict("ReadMcpResourceTool", { server: "slack", uri: "x" }, allowed).allow, true);
  assert.equal(mcpServerVerdict("ListMcpResourcesTool", {}, allowed).allow, false);
  // 플러그인 서버 이름(plugin:slack:slack)은 도구 이름에서 plugin_slack_slack
  assert.equal(mcpNameOf("plugin:slack:slack"), "plugin_slack_slack");
  assert.equal(mcpServerVerdict("mcp__plugin_slack_slack__search", {}, ["plugin:slack:slack"]).allow, true);
});

test("대화형(채팅): 훅이 연결 안 한 서버의 읽기 도구를 막고, 커넥터 서버 읽기는 그대로 허용", async () => {
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue);
  const t = toolOptions(cfg(), { interactive: { origin: { via: "chat", threadId: "t1" }, broker } });
  const sig = { signal: new AbortController().signal };
  assert.equal(decision(await t.hook(pre("mcp__company__search_docs"), "tu", sig)), "deny");
  assert.equal(decision(await t.hook(pre("mcp__company__send_message", { text: "x" }), "tu", sig)), "deny"); // 쓰기도 카드 없이 막힘
  assert.equal(decision(await t.hook(pre("mcp__slack__slack_search_public"), "tu", sig)), "allow");
  // canUseTool 로 직접 와도 막힌다(카드를 띄우지 않음)
  const r = await t.canUseTool!("mcp__company__send_message", { text: "x" }, sig as any);
  assert.equal(r?.behavior, "deny");
  assert.deepEqual(asked, []);
});

test("정기 작업(브리핑): 연결 안 한 서버는 막고 커넥터 서버의 읽기만", async () => {
  const t = toolOptions(cfg(), {});
  const sig = { signal: new AbortController().signal };
  assert.equal(decision(await t.hook(pre("mcp__company__search_docs"), "tu", sig)), "deny");
  assert.equal(decision(await t.hook(pre("mcp__slack__slack_send_message"), "tu", sig)), "deny");
  assert.equal(await t.hook(pre("mcp__atlassian__searchJiraIssuesUsingJql"), "tu", sig).then(decision), undefined); // 통과(막지 않음)
  assert.equal(t.settingSources[0], "user");
});

test("mcpIsolation: ~/.claude.json 의 다른 서버는 모델에 안 보이게(disallowedTools), claude.ai 커넥터도 끈다", () => {
  const home = mkdtempSync(join(tmpdir(), "cy-mcpiso-"));
  const path = join(home, ".claude.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { slack: { type: "http", url: "https://s" }, company: { type: "http", url: "https://c" } }, projects: { "/r/app": { mcpServers: { "local-db": { command: "x" } } } } }));
  const names = registeredMcpServerNames(path);
  assert.deepEqual(names.sort(), ["company", "local-db", "slack"]);
  const iso = mcpIsolation(allowedMcpServers(conns), names);
  assert.deepEqual(iso.hidden.sort(), ["mcp__company", "mcp__local-db"]);
  assert.deepEqual(iso.env, { ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  // 커넥터로 claude.ai 서버를 골랐으면 끄지 않는다
  assert.deepEqual(mcpIsolation(["claude_ai_Slack"], []).env, {});
  assert.deepEqual(hiddenMcpRules(["slack"], ["slack"]), []);
  assert.deepEqual(registeredMcpServerNames(join(home, "none.json")), []);
});

test("allowMcp: 사용자가 config.json 에 적은 서버만 채팅에서 더 쓴다", async () => {
  const c = { ...cfg(), ...loadConfig({}, { allowMcp: ["notion", 3, " "] } as any), connectors: conns, repoRoots: [], github: { enabled: false } };
  assert.deepEqual(c.allowMcp, ["notion"]);
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue);
  const t = toolOptions(c, { interactive: { origin: { via: "chat", threadId: "t1" }, broker } });
  const sig = { signal: new AbortController().signal };
  assert.equal(decision(await t.hook(pre("mcp__notion__notion-search"), "tu", sig)), "allow");
  assert.equal(decision(await t.hook(pre("mcp__company__search_docs"), "tu", sig)), "deny");
  assert.ok(t.mcpAllow.includes("notion"));
});
