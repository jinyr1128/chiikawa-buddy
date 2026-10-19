import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { buildSlackChunks, claudeItems, codexItems, hashText, packItems, scanSessions, sessionChunks, type Item } from "./chunks.ts";

const L = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

const claude = (sid: string, cwd: string, n = 1) => L([
  { type: "user", sessionId: sid, cwd, timestamp: "2026-09-10T01:00:00Z", message: { content: `빌드 파이프라인 고쳐줘 ${n}<system-reminder>숨김</system-reminder>` } },
  { type: "user", sessionId: sid, timestamp: "2026-09-10T01:00:01Z", message: { content: [{ type: "tool_result", content: "아주 긴 도구 출력".repeat(50) }] } },
  { type: "user", sessionId: sid, timestamp: "2026-09-10T01:00:02Z", message: { content: "<command-name>/clear</command-name>" } },
  { type: "assistant", sessionId: sid, timestamp: "2026-09-10T01:01:00Z", message: { content: [
    { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    { type: "tool_use", name: "Read", input: { file_path: "/r/a.ts" } },
    { type: "tool_use", name: "Edit", input: { file_path: "/r/app/ci.yml" } },
  ] } },
  { type: "assistant", sessionId: sid, timestamp: "2026-09-10T01:02:00Z", message: { content: [{ type: "text", text: "CI 설정을 고쳤어" }] } },
]);

test("claude 세션: 사람 프롬프트·AI 텍스트·도구 한 줄만, 도구 결과·주입 태그는 뺀다", () => {
  const s = claudeItems(claude("s1", "/r/app"), "x");
  assert.equal(s.id, "s1");
  assert.equal(s.cwd, "/r/app");
  const texts = s.items.map((i) => i.text);
  assert.deepEqual(texts, ["사용자: 빌드 파이프라인 고쳐줘 1", "도구: $ npm test; Edit /r/app/ci.yml", "AI: CI 설정을 고쳤어"]);
  assert.ok(!texts.join().includes("도구 출력"));
});

test("서브에이전트: 첫 지시와 AI 텍스트", () => {
  const raw = L([
    { type: "user", isSidechain: true, agentId: "a1", sessionId: "p1", cwd: "/r/app", timestamp: "2026-09-10T02:00:00Z", message: { content: "Slack 채널 요약해" } },
    { type: "assistant", sessionId: "p1", timestamp: "2026-09-10T02:01:00Z", message: { content: [{ type: "text", text: "요약 완료" }] } },
  ]);
  const s = claudeItems(raw, "agent-a1", { subagent: true });
  assert.equal(s.id, "agent-a1");
  assert.deepEqual(s.items.map((i) => i.text), ["상위 에이전트 지시: Slack 채널 요약해", "AI: 요약 완료"]);
});

test("codex: 가져온(external-import) 턴은 빼고 네이티브 턴만", () => {
  const raw = L([
    { type: "session_meta", payload: { id: "c1", cwd: "/r/x" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "external-import-turn-1" } },
    { type: "response_item", timestamp: "2026-09-10T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "가져온 질문" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "[external_agent_tool_result]\nls\n[/external_agent_tool_result]" }] } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
    { type: "response_item", timestamp: "2026-09-10T00:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "새 질문" }] } },
    { type: "response_item", timestamp: "2026-09-10T00:01:30Z", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "status"] }) } },
    { type: "response_item", timestamp: "2026-09-10T00:02:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "답" }] } },
  ]);
  const s = codexItems(raw, "x");
  assert.equal(s.id, "c1");
  assert.deepEqual(s.items.map((i) => i.text), ["사용자: 새 질문", "도구: $ git status", "AI: 답"]);
});

test("packItems: 순서 유지, 목표 크기 이하, 뒤에 붙여도 앞 청크는 그대로", () => {
  const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ at: `2026-09-10T00:${String(i).padStart(2, "0")}:00Z`, text: `사용자: ${"가".repeat(500)} ${i}` }));
  const a = packItems(items, 3000);
  assert.ok(a.length > 5);
  assert.deepEqual(a.flat().map((x) => x.text), items.map((x) => x.text));
  for (const p of a.slice(0, -1)) assert.ok(p.reduce((n, x) => n + x.text.length + 16, 0) <= 3000);
  const b = packItems([...items, { at: "2026-09-10T01:00:00Z", text: "사용자: 추가" }], 3000);
  for (let i = 0; i < a.length - 1; i++) assert.equal(hashText(JSON.stringify(b[i])), hashText(JSON.stringify(a[i])));
  // 시각은 청크 범위로
  const cs = sessionChunks({ id: "s", tool: "claude", cwd: "/r", items }, "s");
  assert.equal(cs[0].start, items[0].at);
  assert.ok(cs[0].text.startsWith("[09-10 09:00] 사용자:"), "KST 시각");
});

test("scanSessions: 전체 기간, 서브에이전트는 부모 세션 근거로, 데몬 세션 제외, 바뀐 것만 다시", async () => {
  const root = mkdtempSync(join(tmpdir(), "kg-scan-"));
  const proj = join(root, "claude", "-r-app");
  mkdirSync(join(proj, "p1", "subagents"), { recursive: true });
  writeFileSync(join(proj, "p1.jsonl"), claude("p1", "/r/app"));
  writeFileSync(join(proj, "p1", "subagents", "agent-a1.jsonl"), L([
    { type: "user", sessionId: "p1", timestamp: "2026-09-10T02:00:00Z", message: { content: "하위 작업" } },
    { type: "assistant", sessionId: "p1", timestamp: "2026-09-10T02:01:00Z", message: { content: [{ type: "text", text: "끝" }] } },
  ]));
  writeFileSync(join(proj, "old.jsonl"), claude("old", "/r/app").replaceAll("2026-09-10", "2025-01-02")); // 오래된 것도
  writeFileSync(join(proj, "d1.jsonl"), claude("d1", "/home/.cy-agent/brain"));
  mkdirSync(join(root, "codex"), { recursive: true });
  const store = new Store(":memory:");
  const r = await scanSessions(store, { claude: join(root, "claude"), codex: join(root, "codex") }, { skipCwdPrefixes: ["/home/.cy-agent"] });
  assert.equal(r.skipped, 1);
  const rows = store.db.prepare("SELECT id, ref, status FROM kg_chunks ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((x) => x.id), ["s:old:0", "s:p1/sub:agent-a1:0", "s:p1:0"]);
  assert.equal(rows.find((x) => x.id.includes("sub"))!.ref, "session:p1");
  assert.ok(rows.every((x) => x.status === "pending"));

  // 처리됨으로 표시한 뒤 다시 스캔: 그대로. 세션에 내용이 붙으면 그 청크만 pending
  store.db.exec("UPDATE kg_chunks SET status = 'done'");
  const r2 = await scanSessions(store, { claude: join(root, "claude"), codex: join(root, "codex") }, { skipCwdPrefixes: ["/home/.cy-agent"] });
  assert.equal(r2.changed, 0);
  appendFileSync(join(proj, "p1.jsonl"), L([{ type: "user", sessionId: "p1", timestamp: "2026-09-11T01:00:00Z", message: { content: "하나 더" } }]));
  await scanSessions(store, { claude: join(root, "claude"), codex: join(root, "codex") }, { skipCwdPrefixes: ["/home/.cy-agent"] });
  const pending = (store.db.prepare("SELECT id FROM kg_chunks WHERE status = 'pending'").all() as any[]).map((x) => x.id);
  assert.deepEqual(pending, ["s:p1:0"]);
});

test("buildSlackChunks: 스레드는 스레드끼리, 최상위는 대화·날짜(KST)별, 멘션은 이름으로, permalink", () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  store.db.prepare("INSERT INTO slack_meta VALUES ('teamUrl', 'https://acme.slack.com/')").run();
  store.upsertNode("channel:C1", "channel", "#dev", {});
  store.upsertNode("person:UB", "person", "Bob", { slackId: "UB" });
  const msg = (ts: string, text: string, extra: Record<string, unknown> = {}) =>
    store.upsertNode(`message:C1:${ts}`, "message", text, { channel: "C1", ts, text, author: "UA", authorName: "Alice", ...extra }, new Date(Number(ts) * 1000).toISOString());
  const t0 = Date.parse("2026-09-10T02:00:00Z") / 1000; // KST 11시
  msg(`${t0}.000100`, "배포 <@UB> 확인 부탁", { replyCount: 1 });
  msg(`${t0 + 60}.000100`, "확인함", { thread_ts: `${t0}.000100` });
  msg(`${t0 + 120}.000100`, "다른 얘기");
  msg(`${t0 + 86400}.000100`, "다음 날");
  const r = buildSlackChunks(store);
  assert.equal(r.groups, 3);
  const rows = store.db.prepare("SELECT id, ref, text, link FROM kg_chunks ORDER BY id").all() as any[];
  const th = rows.find((x) => x.id.includes(":t"))!;
  assert.equal(th.ref, `message:C1:${t0}.000100`);
  assert.match(th.text, /Alice: 배포 @Bob 확인 부탁\n.*Alice: 확인함/);
  assert.equal(th.link, `https://acme.slack.com/archives/C1/p${t0}000100`);
  assert.ok(rows.some((x) => x.id === "k:C1:d2026-09-10:0" && x.text.includes("다른 얘기")));
  assert.ok(rows.some((x) => x.id === "k:C1:d2026-09-11:0"));
  // 다시 만들어도 바뀐 게 없으면 그대로
  assert.equal(buildSlackChunks(store).newOrChanged, 0);
});
