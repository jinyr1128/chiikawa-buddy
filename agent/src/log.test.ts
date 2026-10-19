import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFileLog, redactLog } from "./log.ts";

test("데몬 로그는 토큰을 가린다", () => {
  const s = redactLog("ok xoxb-123456789012-abcdefghijk sk-abcdefghijklmnopqrstuvwxyz0123456789 https://x/a.ics?k=1");
  assert.match(s, /ok /);
  assert.equal(s.includes("xoxb-123456789012"), false);
  assert.equal(s.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(s.includes("a.ics"), false);
});

test("installFileLog: 파일에 남기고 토큰은 안 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-daemon-log-"));
  const restore = installFileLog(dir);
  try {
    console.log("hello xoxp-111-222-333-abcdefgh");
    const text = readFileSync(join(dir, "daemon.log"), "utf8");
    assert.match(text, /hello/);
    assert.equal(text.includes("xoxp-111-222-333-abcdefgh"), false);
  } finally {
    restore();
  }
});

test("installFileLog: 커지면 이전 파일로 돌린다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-daemon-rot-"));
  writeFileSync(join(dir, "daemon.log"), "x".repeat(256 * 1024 + 10));
  const restore = installFileLog(dir);
  try {
    console.warn("rotated");
    assert.equal(existsSync(join(dir, "daemon.log.1")), true);
    assert.match(readFileSync(join(dir, "daemon.log"), "utf8"), /rotated/);
  } finally {
    restore();
  }
});

test("[stall]: 단조 시계로만 잰다 — 잠자기(벽시계만 크게 뜀)는 멈춤이 아니다", async () => {
  const { stallLag } = await import("./log.ts");
  assert.equal(stallLag(1000, 1000), 0);
  assert.equal(stallLag(4500, 4500), 3500); // 진짜 멈춤
  assert.ok(stallLag(1001, 8 * 3600e3) <= 0); // 맥이 8시간 잠듦
  assert.ok(stallLag(1000, 1000 + 60e3) <= 0); // 시계 맞춤
});

// 새 OpenAI 키 모양(sk-proj-·sk-svcacct-, 밑줄·하이픈 섞임)도 가린다. 진짜 키 아님
const SK_SHAPES = ["sk-proj-unitTEST_not-real_0000aaaa", "sk-svcacct-unit_TEST-not-real-0000bbbb", "sk-ant-api03-unit_TEST-not-real-cccc", "sk-unitTESTnotreal0000dddd"];
test("redactLog: sk-proj-·sk-svcacct-·sk-ant- 키도 가린다", () => {
  for (const k of SK_SHAPES) assert.equal(redactLog(`key=${k} 끝`).includes(k.slice(3, 15)), false, k);
  assert.match(redactLog("task-notification 은 그대로"), /task-notification/);
});