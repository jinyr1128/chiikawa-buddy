import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { Connections, redact, CHECK_IDS, type ConnRow } from "./connections.ts";
import { Bus } from "./bus.ts";
import type { Run } from "./runs.ts";

const NOW = new Date("2026-10-13T03:00:00Z");
const TOKENS = ["xoxb-1234567890-abcdefghij", "xapp-1-A0B1C2-secret", "sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk_lmnop"];

test("redact: 토큰·Authorization·쿼리 비밀은 *** 로", () => {
  for (const t of TOKENS) assert.doesNotMatch(redact(`실패: ${t} 때문`), new RegExp(t.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(redact("Authorization: Bearer abcdef1234567890"), "Authorization: Bearer ***");
  assert.equal(redact("GET https://x.example/mcp?token=abc123&x=1"), "GET https://x.example/mcp?token=***&x=1");
  assert.equal(redact('{"access_token":"abc.def"}'), '{"access_token":"***"}');
  assert.equal(redact("https://mcp.example.com/connect/google-workspace"), "https://mcp.example.com/connect/google-workspace");
  assert.doesNotMatch(redact("key AIzaSyA1234567890abcdefghijk 실패"), /AIzaSy/);
  assert.equal(redact(new Error("ECONNREFUSED 127.0.0.1")), "ECONNREFUSED 127.0.0.1");
  assert.equal(redact("x".repeat(10) + " " + "가".repeat(300)).length, 241);
});

function make(over: Partial<ConstructorParameters<typeof Connections>[1]> = {}, file: Record<string, unknown> = {}) {
  const cfg = loadConfig({}, {
    slackBotToken: "xoxb-1234567890-abcdefghij", slackAppToken: "xapp-1-A0B1C2-secret", briefing: { exclude: ["issues"] },
    connectors: {
      slack: { mode: "api", userToken: "xoxp-1234567890-abcdefghij" }, calendar: { mode: "api", icsUrl: "https://cal.example.com/secret.ics" },
      mail: { mode: "mcp", server: "mail" }, issues: { mode: "mcp", preset: "github" },
    },
    ...file,
  } as any);
  const runs: Run[] = [
    { id: "r1", kind: "calendar", title: "캘린더", model: "m", startedAt: "2026-10-13T02:40:00Z", endedAt: "2026-10-13T02:41:00Z", status: "done", interactive: false, events: 0, dropped: 0 },
    { id: "r2", kind: "kg", title: "kg", model: "m", startedAt: "2026-10-13T01:00:00Z", endedAt: "2026-10-13T01:01:00Z", status: "failed", error: "token ghp_abcdefghijklmnopqrstuvwxyz0123 rejected", interactive: false, events: 0, dropped: 0 },
    { id: "r3", kind: "slack-ingest", title: "s", model: "m", startedAt: "2026-10-12T20:00:00Z", endedAt: "2026-10-12T20:01:00Z", status: "done", interactive: false, events: 0, dropped: 0 },
  ];
  let t = 0;
  const c = new Connections(cfg, {
    now: () => NOW,
    urls: () => ({ mail: "https://m.example/mcp", github: "https://g.example/mcp" }),
    httpTimeoutMs: 50,
    fetch: async (u, init) => {
      if (u.includes("g.example")) return await new Promise((_, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
      t++;
      return { status: 406, headers: { get: () => null } };
    },
    hasServer: (n) => n === "mail" || n === "github",
    env: {},
    sdkProbe: async () => ({ account: { email: "me@example.com", provider: "firstParty", tokenSource: "claude.ai" }, servers: [{ name: "mail", status: "connected" }, { name: "github", status: "failed", error: "HTTP 401 Bearer abcdefghijklmnop" }] }),
    gh: async () => ({ ok: false, err: "You are not logged into any GitHub hosts. token gho_abcdefghijklmnopqrstu" }),
    lastRun: (k) => runs.find((r) => r.kind === k),
    kg: () => ({ phase: "idle" }),
    ...over,
  });
  return { c, cfg, fetched: () => t };
}

const byId = (rows: ConnRow[], id: string) => rows.find((r) => r.id === id)!;
const SHAPE = new Set(["id", "label", "summary", "group", "state", "detail", "error", "latencyMs", "checkedAt", "check", "pending", "doc", "server", "used", "briefing"]);

test("Connections: 처음엔 비싼 확인(claude)은 pending, list 는 net·gh 를 새로, 커넥터마다 한 줄", async () => {
  const { c } = make();
  const { rows } = await c.list();
  for (const r of rows) {
    for (const k of Object.keys(r)) assert.ok(SHAPE.has(k), `모르는 키 ${k}`);
    assert.ok(["ok", "warn", "error", "off", "unknown"].includes(r.state));
    assert.ok(CHECK_IDS.includes(r.check));
  }
  assert.equal(byId(rows, "claude").pending, true);
  assert.equal(byId(rows, "brain").state, "ok");
  assert.match(byId(rows, "brain").detail!, /Claude Code/);
  assert.deepEqual(rows.filter((r) => r.group === "service").map((r) => r.id), ["connector:slack", "connector:calendar", "connector:mail", "connector:issues"]);
  const mail = byId(rows, "connector:mail");
  assert.equal(mail.state, "ok");
  assert.match(mail.detail!, /응답함/);
  assert.equal(typeof mail.latencyMs, "number");
  assert.equal(mail.doc, "docs/connect/mail.md");
  const gh = byId(rows, "connector:issues");
  assert.equal(gh.state, "error");
  assert.match(gh.detail!, /응답 없음/);
  assert.match(gh.error!, /초 초과/);
  assert.deepEqual(gh.briefing, [{ source: "issues", label: "이슈", included: false }]);
  assert.equal(byId(rows, "connector:slack").state, "ok");
  assert.match(byId(rows, "connector:slack").detail!, /사용자 토큰/);
  assert.equal(byId(rows, "gh").state, "error");
  assert.equal(byId(rows, "slack-bot").state, "ok");
  assert.equal(byId(rows, "calendar").state, "ok");
  assert.match(byId(rows, "calendar").detail!, /19분 전/);
  assert.equal(byId(rows, "slack-ingest").state, "warn"); // 30분 넘게 성공 없음
  assert.equal(byId(rows, "kg").state, "error");
  assert.deepEqual(byId(rows, "sessions").briefing, [{ source: "sessions", label: "최근 작업 세션", included: true }]);
});

test("Connections: 꺼진 커넥터·등록 안 된 MCP 서버·키 없는 뇌", async () => {
  const { c } = make({ hasServer: () => false }, { connectors: { mail: { mode: "mcp", server: "mail" } }, brain: { provider: "gemini" } });
  const { rows } = await c.list();
  assert.equal(byId(rows, "connector:slack").state, "off");
  assert.equal(byId(rows, "connector:slack").used, false);
  assert.equal(byId(rows, "connector:mail").state, "error");
  assert.match(byId(rows, "connector:mail").detail!, /등록돼 있지 않아요/);
  assert.equal(byId(rows, "slack-ingest").state, "off");
  assert.equal(byId(rows, "calendar").state, "off");
  assert.equal(byId(rows, "brain").state, "error");
  assert.match(byId(rows, "brain").detail!, /Gemini API 키가 없어요/);
});

test("Connections: 뇌가 Codex 면 MCP 커넥터 줄은 경고 + 「Claude Code 뇌일 때만」, API 커넥터는 그대로", async () => {
  const { c } = make({}, { brain: { provider: "codex" } });
  const { rows } = await c.list();
  assert.equal(byId(rows, "connector:mail").state, "warn");
  assert.match(byId(rows, "connector:mail").detail!, /^MCP 연결\(메일·이슈·캘린더·Slack\)은 Claude Code 뇌일 때만 읽어요 · /);
  assert.equal(byId(rows, "connector:slack").state, "ok");
  const cc = (await make().c.list()).rows;
  assert.doesNotMatch(byId(cc, "connector:mail").detail!, /Claude Code 뇌일 때만/);
});

test("Connections.recheck: Claude 로그인 · SDK 가 본 MCP 상태", async () => {
  const { c } = make();
  const { rows } = await c.recheck();
  assert.equal(byId(rows, "claude").state, "ok");
  assert.equal(byId(rows, "claude").detail, "로그인됨");
  assert.match(byId(rows, "connector:mail").detail!, /MCP 연결됨/);
  assert.equal(byId(rows, "connector:issues").state, "error");
  assert.match(byId(rows, "connector:issues").detail!, /MCP 연결 실패/);
});

test("Connections: 출력 어디에도 토큰·이메일·ICS 주소가 없다", async () => {
  const { c } = make();
  const out = JSON.stringify(await c.recheck());
  for (const t of [...TOKENS, "gho_abcdefghijklmnopqrstu", "ghp_abcdefghijklmnopqrstuvwxyz0123", "abcdefghijklmnop", "me@example.com", "xoxp-1234567890", "secret.ics"]) assert.ok(!out.includes(t), t);
});

test("Connections: 확인이 던져도 줄은 남고 오류는 가려진다 · 같은 확인은 한 번만 돈다", async () => {
  let calls = 0;
  const { c } = make({
    sdkProbe: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); throw new Error("spawn failed: key sk-ant-api03-abcdefghijklmnop"); },
  });
  await Promise.all([c.check("claude"), c.check("claude")]);
  assert.equal(calls, 1);
  const rows = c.rows();
  const cl = byId(rows, "claude");
  assert.equal(cl.state, "error");
  assert.doesNotMatch(cl.error!, /sk-ant/);
});

test("GET /connections · POST /connections/check {id}: 헤더 필수, 모르는 id 는 400", async () => {
  const { c } = make();
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    connections: { ids: CHECK_IDS, list: () => c.list(), recheck: (id) => c.recheck(id as any) },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (body: unknown, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connections/check`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const g = await (await fetch(`${base}/connections`)).json();
    assert.ok(Array.isArray(g.rows) && g.checkedAt);
    assert.equal((await post({ id: "claude" }, {})).status, 403);
    assert.equal((await post({ id: "nope" })).status, 400);
    assert.equal((await post({ id: "services" })).status, 400); // 예전 서비스 확인(services)은 없다
    const r = await (await post({ id: "claude" })).json();
    assert.ok(r.rows.some((x: ConnRow) => x.id === "connector:issues"));
  } finally {
    bus.close();
  }
});

test("Connections: 작업 기록 읽기를 끄면 「작업 세션」 줄은 off·「읽지 않아요」, 켜면 ok", async () => {
  const off = (await make({}, { onboarded: true, readSessions: false }).c.list()).rows.find((r) => r.id === "sessions")!;
  assert.equal(off.state, "off");
  assert.equal(off.detail, "읽지 않아요(설정에서 켤 수 있어요)");
  const on = (await make({}, { onboarded: true, readSessions: true }).c.list()).rows.find((r) => r.id === "sessions")!;
  assert.equal(on.state, "ok");
  assert.equal(on.detail, "로컬 기록을 읽어요");
  const wait = (await make({}, { onboarded: false }).c.list()).rows.find((r) => r.id === "sessions")!;
  assert.equal(wait.state, "off");
});
