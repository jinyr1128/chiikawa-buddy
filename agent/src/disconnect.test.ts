import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectConnector, disconnectConnectorFile, withConnectorOff } from "./disconnect.ts";
import { resolveConnectors, connectorStatus } from "./connectors.ts";
import { Settings } from "./settings.ts";
import { loadConfig } from "./config.ts";
import { Bus, type BusHandlers } from "./bus.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cy-disconnect-"));
const FILE = {
  slackBotToken: "xoxb-keep",
  repoRoots: ["/code"],
  connectors: {
    slack: { mode: "api", userToken: "xoxp-secret" },
    calendar: { mode: "api", icsUrl: "https://example.com/a.ics", icsUrls: ["https://example.com/b.ics"], timeZone: "Asia/Seoul" },
    mail: { mode: "mcp", preset: "gmail" },
    issues: { mode: "mcp", server: "atlassian" },
  },
};

test("withConnectorOff: 그 기능만 off, 토큰·ICS 주소도 지운다. 다른 키는 그대로", () => {
  const next = withConnectorOff(structuredClone(FILE), "calendar") as any;
  assert.deepEqual(next.connectors.calendar, { mode: "off" });
  assert.deepEqual(next.connectors.slack, FILE.connectors.slack);
  assert.equal(next.slackBotToken, "xoxb-keep");
  assert.deepEqual(withConnectorOff({}, "slack"), { connectors: { slack: { mode: "off" } } });
});

test("disconnectConnectorFile: 원자적으로 쓰고, 깨진 파일은 덮어쓰지 않는다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(FILE));
  assert.deepEqual(disconnectConnectorFile(path, "slack"), { changed: true });
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /xoxp-secret/);
  assert.deepEqual(JSON.parse(raw).connectors.slack, { mode: "off" });
  assert.equal(resolveConnectors({}, JSON.parse(raw)).slack.mode, "off");
  assert.deepEqual(disconnectConnectorFile(path, "slack"), { changed: false }, "이미 꺼져 있으면 쓰지 않는다");
  // 파일이 없으면 새로
  const fresh = join(dir, "sub", "config.json");
  disconnectConnectorFile(fresh, "mail");
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { connectors: { mail: { mode: "off" } } });
  // 깨진 파일
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => disconnectConnectorFile(bad, "slack"), /덮어쓰지 않았어요/);
  assert.equal(readFileSync(bad, "utf8"), "{ not json");
});

test("disconnectConnector: 파일 → 다시 읽기 → 메모리 off, mcp 면 서버 이름을 돌려준다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(FILE));
  const cfg = { connectors: resolveConnectors({}, FILE as any) };
  const order: string[] = [];
  const reload = () => {
    // 다시 읽을 때 파일은 이미 off 이고 메모리는 아직 예전 것(바뀜을 알아챌 수 있게)
    order.push(`reload:${cfg.connectors.issues.mode}:${JSON.parse(readFileSync(path, "utf8")).connectors.issues.mode}`);
    return { changed: true, restarting: false };
  };
  const r = disconnectConnector("issues", { path, cfg, reload, changed: () => order.push("changed") });
  assert.deepEqual(r, { ok: true, cap: "issues", server: "atlassian", reload: { changed: true, restarting: false } });
  assert.deepEqual(order, ["reload:mcp:off", "changed"]);
  assert.deepEqual(cfg.connectors.issues, { cap: "issues", mode: "off" });
  assert.equal(connectorStatus(cfg.connectors, () => true).find((c) => c.cap === "issues")!.mode, "off");
  // api 는 서버 이름 없음
  const s = disconnectConnector("slack", { path, cfg, reload: () => ({ changed: true, restarting: true }) });
  assert.deepEqual(s, { ok: true, cap: "slack", reload: { changed: true, restarting: true } });
  // 모르는 기능
  assert.deepEqual(disconnectConnector("github", { path, cfg, reload }), { ok: false, status: 400, error: "cap must be one of slack|calendar|mail|issues" });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "[]");
  const e = disconnectConnector("mail", { path: bad, cfg, reload });
  assert.equal(e.ok, false);
  assert.equal(cfg.connectors.mail.mode, "mcp", "파일을 못 쓰면 메모리도 그대로");
});

test("connectorStatus: mcp 면 서버 이름을 같이 준다(claude mcp remove 안내용)", () => {
  const st = connectorStatus(resolveConnectors({}, FILE as any), () => true);
  assert.equal(st.find((c) => c.cap === "issues")!.server, "atlassian");
  assert.equal(st.find((c) => c.cap === "mail")!.server, "gmail");
  assert.equal(st.find((c) => c.cap === "slack")!.server, undefined);
});

test("AI 연결 해제: PUT /settings brain 으로 키를 지우고 로컬로, 바로 반영", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ brain: { provider: "gemini", geminiApiKey: "AIza-secret", openaiApiKey: "sk-keep" }, slackBotToken: "xoxb-keep" }));
  const cfg = loadConfig({}, JSON.parse(readFileSync(path, "utf8")));
  const s = new Settings(cfg, { path, env: {} });
  const r = s.put({ brain: { provider: "local", keys: { gemini: null } } });
  assert.equal(r.ok, true);
  assert.equal(cfg.brain.provider, "local");
  assert.equal(cfg.brain.geminiApiKey, undefined);
  assert.equal(cfg.brain.openaiApiKey, "sk-keep");
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.brain, { provider: "local", openaiApiKey: "sk-keep" });
  assert.equal(file.slackBotToken, "xoxb-keep");
  if (r.ok) assert.deepEqual(r.settings.brain.keys, { gemini: false, openai: true, anthropic: false, genspark: false });
  // 쓰지 않는 키만 지우면 provider 는 그대로
  const r2 = s.put({ brain: { keys: { openai: null } } });
  assert.equal(r2.ok, true);
  assert.equal(cfg.brain.provider, "local");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).brain.openaiApiKey, undefined);
  assert.ok(existsSync(path));
});

async function serve(extra: Partial<BusHandlers>) {
  const bus = new Bus();
  await bus.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [], ...extra } as BusHandlers);
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, body: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + p, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { bus, post };
}

test("bus: POST /connectors/disconnect — 헤더 필수, cap 만, 핸들러 결과 그대로, 없으면 503", async () => {
  const seen: unknown[] = [];
  const { bus, post } = await serve({
    connectorDisconnect: (cap) => { seen.push(cap); return cap === "slack" ? { ok: true, cap, reload: { changed: true, restarting: false } } : { ok: false, status: 400, error: "bad cap" }; },
  });
  try {
    assert.equal((await post("/connectors/disconnect", { cap: "slack" }, {})).status, 403);
    const r = await post("/connectors/disconnect", { cap: "slack" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, cap: "slack", reload: { changed: true, restarting: false } });
    const b = await post("/connectors/disconnect", { cap: "nope" });
    assert.equal(b.status, 400);
    assert.deepEqual(await b.json(), { error: "bad cap" });
    assert.equal((await post("/connectors/disconnect", { cap: "slack", token: "x" })).status, 400);
    assert.deepEqual(seen, ["slack", "nope"]);
  } finally { bus.close(); }
  const off = await serve({});
  try { assert.equal((await off.post("/connectors/disconnect", { cap: "slack" })).status, 503); } finally { off.bus.close(); }
});

test("연결 해제는 설치 마법사 상태(onboarded·readSessions·repoRoots)를 건드리지 않는다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  // 마법사 도중(onboarded:false)에 해제해도 그대로 false: 마친 것으로 바뀌지 않는다
  writeFileSync(path, JSON.stringify({ ...FILE, onboarded: false, readSessions: false, repoRoots: [] }));
  disconnectConnectorFile(path, "calendar");
  let f = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(f.onboarded, false);
  assert.equal(f.readSessions, false);
  assert.deepEqual(f.repoRoots, []);
  // 예전 설정(onboarded 키 없음)은 키를 새로 적지 않는다: 새 방식 기본값(작업 기록 끔·레포 없음)으로 바뀌지 않게
  writeFileSync(path, JSON.stringify(FILE));
  disconnectConnectorFile(path, "slack");
  f = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("onboarded" in f, false);
  assert.equal("readSessions" in f, false);
  const cfg = loadConfig({}, f);
  assert.equal(cfg.onboarded, true);
  assert.equal(cfg.readSessions, true);
});
