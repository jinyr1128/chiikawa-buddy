import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiUsage, resetIso, statusText } from "./usage.ts";

const NOW = new Date(2026, 9, 19, 15, 0).getTime();

test("Claude 상태 줄: 한도를 기억하고 한 줄로 돌려준다, 지난 초기화는 0%", () => {
  const dir = mkdtempSync(join(tmpdir(), "us-"));
  let now = NOW;
  const u = new AiUsage({ file: join(dir, "usage.json"), claudeDir: join(dir, "none"), codexDir: join(dir, "none2"), now: () => now });
  const line = u.fromClaudeStatus({ rate_limits: { five_hour: { used_percentage: 85.4, resets_at: NOW / 1000 + 3600 }, seven_day: { used_percentage: 12 } } });
  assert.match(line, /5시간 85%\(오후 4시 초기화\) · 주간 12%/);
  assert.equal(u.fromClaudeStatus({}), line.replace(/\(.*?\)/, "(오후 4시 초기화)")); // 한도 없는 입력이면 기억한 값
  assert.equal(new AiUsage({ file: join(dir, "usage.json"), claudeDir: dir, codexDir: dir, now: () => now }).snapshot().claude.fiveHour?.pct, 85); // 파일에 남는다
  now = NOW + 2 * 3600e3;
  assert.equal(u.snapshot().claude.fiveHour?.pct, 0);
  assert.equal(statusText({ todayTokens: 0 }), "");
  assert.equal(resetIso("2026-10-19T06:00:00Z"), "2026-10-19T06:00:00.000Z");
});

test("오늘 토큰: Claude 는 같은 응답 한 번만, Codex 는 한도 %와 오늘 늘어난 토큰", () => {
  const dir = mkdtempSync(join(tmpdir(), "us-"));
  const cl = join(dir, "projects", "p"); mkdirSync(cl, { recursive: true });
  const ts = new Date(NOW - 3600e3).toISOString();
  const a = { type: "assistant", timestamp: ts, requestId: "r1", message: { id: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999, output_tokens: 5 } } };
  const old = { ...a, requestId: "r0", message: { id: "m0", usage: { input_tokens: 1000 } }, timestamp: new Date(NOW - 2 * 86400e3).toISOString() };
  writeFileSync(join(cl, "s.jsonl"), [a, a, old].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const d = new Date(NOW);
  const cx = join(dir, "sessions", String(d.getFullYear()), "10", "19"); mkdirSync(cx, { recursive: true });
  const tc = (total: number, used: number) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: NOW / 1000 + 600 }, secondary: { used_percent: 30, window_minutes: 10080 }, plan_type: "plus" } } });
  writeFileSync(join(cx, "rollout-a.jsonl"), [tc(100, 10), tc(400, 20)].join("\n") + "\n");
  const u = new AiUsage({ file: join(dir, "u.json"), claudeDir: join(dir, "projects"), codexDir: join(dir, "sessions"), now: () => NOW });
  const s = u.snapshot();
  assert.equal(s.claude.todayTokens, 115);
  assert.equal(s.codex.todayTokens, 400);
  assert.equal(s.codex.fiveHour?.pct, 20);
  assert.equal(s.codex.week?.pct, 30);
  assert.equal(s.codex.plan, "plus");
});
