import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { ingestSessions, parseClaudeSession, parseCodexSession, readLines } from "./sessions.ts";

const claudeLines = [
  { type: "user", sessionId: "s1", cwd: "/r/app", gitBranch: "main", timestamp: "2026-10-08T01:00:00Z", message: { content: "버튼 색 바꿔줘" } },
  { type: "user", sessionId: "s1", timestamp: "2026-10-08T01:00:01Z", message: { content: [{ type: "tool_result", content: "x" }] } },
  { type: "user", sessionId: "s1", timestamp: "2026-10-08T01:00:02Z", message: { content: "<command-name>/clear</command-name>" } },
  { type: "assistant", sessionId: "s1", timestamp: "2026-10-08T01:01:00Z", message: { content: [
    { type: "tool_use", name: "Edit", input: { file_path: "/r/app/page.tsx" } },
    { type: "text", text: "바꿨어" },
  ] } },
  { type: "ai-title", aiTitle: "버튼 색 변경", sessionId: "s1" },
].map((l) => JSON.stringify(l)).join("\n");

test("claude 세션: 사람 프롬프트·제목·수정 파일만 뽑는다", () => {
  const s = parseClaudeSession(claudeLines, "fallback")!;
  assert.equal(s.id, "s1");
  assert.equal(s.title, "버튼 색 변경");
  assert.equal(s.turns, 1);
  assert.equal(s.firstPrompt, "버튼 색 바꿔줘");
  assert.equal(s.lastAssistant, "바꿨어");
  assert.deepEqual(s.files, ["/r/app/page.tsx"]);
  assert.equal(s.ended, "2026-10-08T01:01:00Z");
});

test("codex 세션: AGENTS 주입문은 프롬프트로 치지 않는다", () => {
  const raw = [
    { type: "session_meta", timestamp: "2026-09-22T01:00:00Z", payload: { id: "c1", cwd: "/r/meet" } },
    { type: "response_item", timestamp: "2026-09-22T01:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /r/meet" }] } },
    { type: "response_item", timestamp: "2026-09-22T01:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "mcp 구조 파악해봐" }] } },
    { type: "response_item", timestamp: "2026-09-22T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "봤어" }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const s = parseCodexSession(raw, "x")!;
  assert.equal(s.id, "c1");
  assert.equal(s.cwd, "/r/meet");
  assert.equal(s.turns, 1);
  assert.equal(s.firstPrompt, "mcp 구조 파악해봐");
});

test("ingestSessions: 그래프에 반영하고 안 바뀐 파일은 건너뛴다", () => {
  const root = mkdtempSync(join(tmpdir(), "cy-"));
  mkdirSync(join(root, "claude", "-r-app"), { recursive: true });
  writeFileSync(join(root, "claude", "-r-app", "s1.jsonl"), claudeLines);
  const store = new Store(":memory:");
  const dirs = { claude: join(root, "claude"), codex: join(root, "codex") };
  assert.equal(ingestSessions(store, dirs), 1);
  assert.equal(ingestSessions(store, dirs), 0);
  assert.equal(store.node("session:s1")?.label, "버튼 색 변경");
  assert.deepEqual(store.neighbors("session:s1", "in"), ["project:/r/app"]);
  assert.deepEqual(store.neighbors("session:s1", "edited"), ["file:/r/app/page.tsx"]);
  assert.equal(store.search("버튼")[0].id, "session:s1");
});

test("isCyAgentCwd: 이 설치와 같은 맥의 다른 시사 설치 폴더 세션은 뺀다", async () => {
  const { isCyAgentCwd } = await import("./sessions.ts");
  assert.equal(isCyAgentCwd("/h/.cy-agent-test/brain", "/h/.cy-agent-test", "/h"), true);
  assert.equal(isCyAgentCwd("/h/.cy-agent/brain", "/h/.cy-agent-test", "/h"), true); // 다른 설치
  assert.equal(isCyAgentCwd("/h/.cy-agent/worktrees/app-1", undefined, "/h"), true);
  assert.equal(isCyAgentCwd("/h/code/app", "/h/.cy-agent", "/h"), false);
  assert.equal(isCyAgentCwd(undefined, "/h/.cy-agent", "/h"), false);
});

test("readLines: 1MB 경계를 넘는 줄도 한 줄로, 마지막 줄바꿈이 없어도", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-lines-"));
  const p = join(dir, "s.jsonl");
  const long = "가".repeat(700_000); // 2.1MB
  writeFileSync(p, `a\n${long}\n\nb`);
  assert.deepEqual([...readLines(p)].map((l) => l.length), [1, long.length, 0, 1]);
  assert.equal([...readLines(p)][1], long);
  rmSync(dir, { recursive: true, force: true });
});
