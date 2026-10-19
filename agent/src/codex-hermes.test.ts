import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexWatch, codexResetText, codexTool } from "./codex-watch.ts";
import { hermesToClaude } from "./hermes-hooks.ts";

test("Codex 기록: 시작 → 도구 → 끝, 한도에 걸리면 끝 대신 한도(풀리는 시각)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-"));
  const now = new Date(2026, 9, 19, 14, 0).getTime();
  const d = new Date(now);
  const day = join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(day, { recursive: true });
  const seen: any[] = [];
  const w = new CodexWatch({ handle: (ev, src) => seen.push({ ...ev, src }) }, { dir, now: () => now - 1000 });
  const f = join(day, "rollout-x.jsonl");
  writeFileSync(f, "");
  const line = (o: unknown) => appendFileSync(f, JSON.stringify(o) + "\n");
  line({ type: "session_meta", payload: { id: "T1", cwd: "/w/proj" } });
  line({ type: "event_msg", payload: { type: "task_started" } });
  line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "*** Update File: src/a.ts" } });
  line({ type: "event_msg", payload: { type: "task_complete" } });
  w.tick();
  assert.deepEqual(seen.map((e) => e.hook_event_name), ["UserPromptSubmit", "PreToolUse", "Stop"]);
  assert.equal(seen[1].tool_name, "Edit");
  assert.equal(seen[0].session_id, "codex:T1");
  assert.equal(seen[0].src, "codex");
  assert.equal(seen[2].limit_when, undefined);
  line({ type: "event_msg", payload: { type: "task_started" } });
  line({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: Math.floor(new Date(2026, 9, 19, 19, 0).getTime() / 1000) } } } });
  line({ type: "event_msg", payload: { type: "task_complete" } });
  w.tick();
  assert.equal(seen.at(-1).hook_event_name, "Stop");
  assert.match(seen.at(-1).limit_when, /오후 7시/);
  assert.equal(codexTool("exec", 'tools.web__run({search_query:[]})').tool, "WebSearch");
  assert.equal(codexResetText(0), "");
});

test("Hermes 신호 → Claude hook 모양", () => {
  assert.equal(hermesToClaude({ hook_event_name: "pre_llm_call", session_id: "s" })!.hook_event_name, "UserPromptSubmit");
  const t = hermesToClaude({ hook_event_name: "pre_tool_call", session_id: "s", tool_name: "read_file", args: { path: "/a/b.md" } })!;
  assert.equal(t.tool_name, "Read");
  assert.equal(t.tool_input!.file_path, "/a/b.md");
  assert.equal(hermesToClaude({ hook_event_name: "post_llm_call", session_id: "s" })!.hook_event_name, "Stop");
  assert.equal(hermesToClaude({ hook_event_name: "api_request_error", extra: { status_code: 429, retryable: false } })!.limit_when, "");
  assert.equal(hermesToClaude({ hook_event_name: "api_request_error", extra: { status_code: 429, retryable: true, retry_count: 0, max_retries: 3 } }), null);
  assert.equal(hermesToClaude({ hook_event_name: "api_request_error", extra: { status_code: 500 } }), null);
  assert.equal(hermesToClaude({ hook_event_name: "unknown" }), null);
});

test('기존 Codex 대화를 둘 이상 이어도 세션 식별자가 충돌하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-resume-'));
  const now = Date.now() + 10000;
  const d = new Date(now);
  const day = join(dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const files = ['rollout-a.jsonl', 'rollout-b.jsonl'].map((n) => join(day, n));
  for (const file of files) writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: file } }) + '\n');
  const seen: any[] = [];
  const w = new CodexWatch({ handle: (ev) => seen.push(ev) }, { dir, now: () => now });
  w.tick();
  for (const file of files) appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  w.tick();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].session_id, seen[1].session_id);
});
