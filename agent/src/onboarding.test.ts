// 처음 쓰는 사람의 동의(onboarding.ts): 마법사를 마치기 전엔 모델·작업 기록·git 을 건드리지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, pickBrain, type Config } from "./config.ts";
import { gitAllowed, looksExisting, markFreshInstall, modelWorkAllowed, readSessionsOf, sessionsAllowed, WAIT_SETUP } from "./onboarding.ts";
import { Settings, briefingExcludeOf } from "./settings.ts";
import { featureBrain } from "./feature-brain.ts";
import { statusOf } from "./status.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { buildDashboard } from "./dashboard.ts";
import { CalendarSync } from "./calendar-sync.ts";
import { resolveConnectors } from "./connectors.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ── 새 설치 표시 ──────────────────────────────────────────────

test("markFreshInstall: 새 설치(파일 없음·이름만 있음)는 onboarded:false 를 남기고, 두 번째엔 그대로", () => {
  const dir = tmp("cy-onb-");
  const path = join(dir, "config.json");
  assert.equal(markFreshInstall(path, {}), true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { onboarded: false });
  assert.equal(markFreshInstall(path, {}), false); // 이미 키가 있음

  const p2 = join(tmp("cy-onb-"), "config.json");
  writeFileSync(p2, JSON.stringify({ user: { name: "길동" } }));
  assert.equal(markFreshInstall(p2, {}), true);
  assert.deepEqual(JSON.parse(readFileSync(p2, "utf8")), { user: { name: "길동" }, onboarded: false });
});

test("markFreshInstall: 이미 쓰던 설정(뇌·커넥터·Slack 토큰·데이터·env 뇌)은 건드리지 않는다", () => {
  const cases: [Record<string, unknown>, NodeJS.ProcessEnv, boolean][] = [
    [{ brain: { provider: "claude-code" } }, {}, false],
    [{ connectors: { slack: { mode: "mcp", server: "slack" } } }, {}, false],
    [{ slackBotToken: "xoxb-1" }, {}, false],
    [{}, { CY_AGENT_BRAIN: "codex" }, false],
    [{}, {}, true], // cy.db 가 이미 있음
  ];
  for (const [file, env, db] of cases) {
    const path = join(tmp("cy-onb-"), "config.json");
    writeFileSync(path, JSON.stringify(file));
    assert.equal(markFreshInstall(path, env, db), false, JSON.stringify(file));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), file);
  }
  // 커넥터가 전부 off 면 새 설치로 본다
  assert.equal(looksExisting({ connectors: { slack: { mode: "off" } } }), false);
  // 깨진 파일은 덮어쓰지 않는다
  const bad = join(tmp("cy-onb-"), "config.json");
  writeFileSync(bad, "{ not json");
  assert.equal(markFreshInstall(bad, {}), false);
  assert.equal(readFileSync(bad, "utf8"), "{ not json");
});

// ── 설정 기본값 ───────────────────────────────────────────────

test("loadConfig: 새 설치는 뇌 미선택(local)·작업 기록 끔·레포 폴더 없음·마법사 전", () => {
  const c = loadConfig({}, { onboarded: false });
  assert.equal(c.onboarded, false);
  assert.equal(c.brain.provider, "local");
  assert.equal(c.readSessions, false);
  assert.deepEqual(c.repoRoots, []);
  assert.equal(modelWorkAllowed(c), false);
  assert.equal(sessionsAllowed(c), false);
  assert.equal(gitAllowed(c), false);
});

test("loadConfig: 예전 설정(onboarded 키 없음)은 지금처럼: claude-code·작업 기록 읽기·~/code", () => {
  const c = loadConfig({}, {});
  assert.equal(c.onboarded, true);
  assert.equal(c.brain.provider, "claude-code");
  assert.equal(c.readSessions, true);
  assert.deepEqual(c.repoRoots, [join(homedir(), "code")]);
  assert.equal(modelWorkAllowed(c), true);
  assert.equal(sessionsAllowed(c), true);
});

test("loadConfig: 마법사를 마친 새 설치는 고른 것만", () => {
  const c = loadConfig({}, { onboarded: true, readSessions: true, repoRoots: ["/r"], brain: { provider: "codex" } });
  assert.equal(c.onboarded, true);
  assert.equal(c.brain.provider, "codex");
  assert.equal(c.readSessions, true);
  assert.deepEqual(c.repoRoots, ["/r"]);
  assert.equal(readSessionsOf({ onboarded: true }), false); // 고르지 않았으면 끔
  assert.equal(pickBrain({}, { onboarded: true }).provider, "local"); // 뇌를 안 골랐으면 모델 없음
  assert.equal(pickBrain({ CY_AGENT_BRAIN: "claude-code" }, { onboarded: false }).provider, "claude-code"); // env 는 그대로
});

// ── 설정 창·마법사 저장 ───────────────────────────────────────

test("Settings: onboarded·readSessions 를 받아 파일·메모리에 바로, 모양이 틀리면 400", () => {
  const dir = tmp("cy-onb-set-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ onboarded: false, slackBotToken: "keep" }));
  const cfg = loadConfig({}, { onboarded: false });
  const seen: string[][] = [];
  const s = new Settings(cfg, { path, env: {}, onChange: (k) => seen.push(k) });
  assert.equal(s.view().onboarded, false);
  assert.equal(s.view().readSessions, false);
  const r = s.put({ readSessions: true, onboarded: true });
  assert.equal(r.ok, true);
  assert.equal(cfg.onboarded, true);
  assert.equal(cfg.readSessions, true);
  assert.ok(seen.at(-1)?.includes("onboarded") && seen.at(-1)?.includes("readSessions"));
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.onboarded, true);
  assert.equal(file.readSessions, true);
  assert.equal(file.slackBotToken, "keep");
  // 다시 읽어도(재시작) 그대로
  assert.equal(loadConfig({}, file).onboarded, true);
  const bad = s.put({ readSessions: "yes" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
});

// ── 모델 작업 ────────────────────────────────────────────────

test("featureBrain·status: 마법사 전엔 Claude Code 를 골랐어도 뒤에서 도는 일이 없다", () => {
  const before = { brain: { provider: "claude-code" as const }, onboarded: false };
  assert.equal(featureBrain(before, () => true), null);
  assert.equal(featureBrain({ ...before, onboarded: true }, () => true), "claude-code");
  const st = statusOf({ ...before, connectors: resolveConnectors({}, {}), user: { aliases: [] } }, { env: {}, claude: () => true });
  assert.equal(st.onboarded, false);
  assert.equal(st.features.background.by, null);
  assert.equal(st.features.background.detail, WAIT_SETUP);
});

function agentWith(cfgPatch: Partial<Config>) {
  const root = tmp("cy-onb-agent-");
  const claude = join(root, "claude");
  mkdirSync(join(claude, "-r-app"), { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(join(claude, "-r-app", "s1.jsonl"), [
    line({ type: "user", sessionId: "s1", cwd: "/r/app", timestamp: new Date().toISOString(), message: { content: "다른 프로젝트 이야기" } }),
    line({ type: "assistant", sessionId: "s1", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "네" }] } }),
  ].join("\n"));
  const cfg = { ...loadConfig({}, {}), claudeProjectsDir: claude, codexSessionsDir: join(root, "none"), ...cfgPatch } as Config;
  const store = new Store(":memory:");
  const bus = new Bus();
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  bus.dashboardChanged = () => {};
  const slack: SlackPort = { post: async () => ({ channel: "D1", ts: "1" }), update: async () => {} };
  let thinks = 0, gits = 0;
  const agent = new Agent(cfg, store, bus, slack, {
    think: async () => { thinks++; return { bubble: "브리핑", reply_md: "x", todos: [{ key: "k", title: "할 일", source: "other", priority: 2 }], done_todo_ids: [], proposals: [] }; },
    runFix: async () => ({ ok: false, summary: "", log: [] } as any),
    mergePr: () => "merged",
    git: async () => { gits++; return []; },
  });
  return { agent, store, cfg, bubbles, thinks: () => thinks, gits: () => gits };
}

test("마법사 전: 브리핑·Slack 할 일은 모델을 안 부르고, 작업 기록도 안 읽는다", async () => {
  const a = agentWith({ onboarded: false, readSessions: true, brain: { provider: "claude-code" } });
  await a.agent.runBriefing();
  assert.equal(a.thinks(), 0);
  assert.equal(a.store.openTodos().length, 0);
  assert.ok(a.bubbles.some((b) => b.text === WAIT_SETUP));
  assert.equal(await a.agent.slackTodosNow(), 0);
  assert.equal(a.agent.ingest(), 0);
  assert.equal(a.store.node("session:s1"), undefined);
});

test("마법사 뒤: 작업 기록 읽기를 끈 사람은 세션을 안 읽고, 켠 사람만 읽는다", async () => {
  const off = agentWith({ onboarded: true, readSessions: false });
  assert.equal(off.agent.ingest(), 0);
  await off.agent.runBriefing();
  assert.equal(off.thinks(), 1); // 브리핑 자체는 돈다
  assert.equal(off.store.node("session:s1"), undefined);
  const on = agentWith({ onboarded: true, readSessions: true });
  assert.equal(on.agent.ingest(), 1);
  assert.ok(on.store.node("session:s1"));
});

test("briefingExcludeOf: 작업 기록 읽기를 끄면 브리핑에서 「최근 작업 세션」도 뺀다", () => {
  assert.deepEqual(briefingExcludeOf({ briefing: { exclude: ["mail"] }, readSessions: false }), ["mail", "sessions"]);
  assert.deepEqual(briefingExcludeOf({ briefing: { exclude: ["mail"] }, readSessions: true }), ["mail"]);
  assert.deepEqual(briefingExcludeOf({ briefing: { exclude: ["sessions"] }, readSessions: false }), ["sessions"]);
});

// ── 대시보드: git·세션 ───────────────────────────────────────

test("대시보드: 마법사 전엔 git 을 안 읽고, 세션 프로젝트도 안 보인다", async () => {
  const store = new Store(":memory:");
  const at = new Date().toISOString();
  store.upsertNode("session:s1", "session", "세션", { cwd: "/r/app" }, at);
  store.upsertNode("project:/r/app", "project", "app", { path: "/r/app" }, at);
  store.link("session:s1", "in", "project:/r/app");
  let gits = 0;
  const git = async () => { gits++; return [{ path: "/r/lib", name: "lib", commitsToday: [{ sha: "a", subject: "x", time: at }], recentCommits: [{ sha: "a", subject: "x", time: at }] }]; };
  const before = await buildDashboard({ ...loadConfig({}, {}), onboarded: false, readSessions: true, repoRoots: ["/r"] }, store, { git });
  assert.equal(gits, 0);
  assert.deepEqual(before.projects, []);
  assert.equal(before.commitsToday, 0);
  // 마쳤지만 작업 기록은 끔 · 레포 폴더 없음
  const noRepos = await buildDashboard({ ...loadConfig({}, {}), onboarded: true, readSessions: false, repoRoots: [] }, store, { git });
  assert.equal(gits, 0);
  assert.deepEqual(noRepos.projects, []);
  // 고른 폴더가 있으면 git 만, 켜면 세션까지
  const after = await buildDashboard({ ...loadConfig({}, {}), onboarded: true, readSessions: true, repoRoots: ["/r"] }, store, { git });
  assert.equal(gits, 1);
  assert.deepEqual(after.projects.map((p) => p.name).sort(), ["app", "lib"]);
});

// ── 캘린더 MCP(모델 중계) ────────────────────────────────────

test("캘린더: MCP 캘린더는 마법사 전엔 부르지 않고, ICS 는 그대로 읽는다", async () => {
  let calls = 0;
  const source = async () => { calls++; return { events: [], ok: true, calls: 1, errors: 0, costUsd: 0 }; };
  const base = loadConfig({}, {});
  const mcp = { ...base, onboarded: false, connectors: resolveConnectors({}, { connectors: { calendar: { mode: "mcp", server: "google-calendar", preset: "google-calendar" } } } as any) } as Config;
  await new CalendarSync(mcp, new Store(":memory:"), { source }).sync();
  assert.equal(calls, 0);
  await new CalendarSync({ ...mcp, onboarded: true }, new Store(":memory:"), { source }).sync();
  assert.equal(calls, 1);
  const ics = { ...base, onboarded: false, connectors: resolveConnectors({}, { connectors: { calendar: { mode: "api", icsUrl: "https://x/a.ics" } } } as any) } as Config;
  await new CalendarSync(ics, new Store(":memory:"), { source }).sync();
  assert.equal(calls, 2);
});

// ── 대화 맥락: 작업 기록을 끈 사람의 세션은 모델에 안 보인다 ──────────

test("작업 기록 읽기를 끄면 맥락 블록·맥락 도구(sessions_recent·session_get)에 세션이 안 나온다", async () => {
  const { buildContext } = await import("./brain.ts");
  const { ctxHandlers } = await import("./ctx-tools.ts");
  const store = new Store(":memory:");
  const now = new Date();
  store.upsertNode("session:s9", "session", "비밀 프로젝트 작업", { cwd: "/r/secret", tool: "claude", turns: 3, lastPrompt: "슬랙 글 붙여 넣음" }, now.toISOString());
  assert.match(buildContext(store, now), /비밀 프로젝트 작업/);
  assert.doesNotMatch(buildContext(store, now, { sessions: false }), /비밀 프로젝트 작업/);
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
  const off = ctxHandlers({ ...loadConfig({}, {}), readSessions: false }, store, { now: () => now });
  assert.doesNotMatch(text(await off.sessions_recent({})), /비밀 프로젝트/);
  assert.doesNotMatch(text(await off.session_get({ id: "s9" })), /슬랙 글/);
  const on = ctxHandlers({ ...loadConfig({}, {}), readSessions: true }, store, { now: () => now });
  assert.match(text(await on.sessions_recent({})), /비밀 프로젝트/);
});

test("예전부터 쓰던 사람이 마법사를 다시 마쳐도 지금처럼: claude-code·작업 기록 읽기·~/code 를 같이 적는다", () => {
  const dir = tmp("cy-onb-legacy-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ slackUserId: "U1" })); // onboarded·brain·repoRoots·readSessions 없음
  const cfg = loadConfig({}, JSON.parse(readFileSync(path, "utf8")));
  const s = new Settings(cfg, { path, env: {} });
  assert.equal(s.put({ onboarded: true }).ok, true);
  const file = JSON.parse(readFileSync(path, "utf8"));
  const again = loadConfig({}, file); // 재시작
  assert.equal(again.onboarded, true);
  assert.equal(again.brain.provider, "claude-code");
  assert.equal(again.readSessions, true);
  assert.deepEqual(again.repoRoots, [join(homedir(), "code")]);
  // 새 설치가 마치면: 고른 것 그대로(아무것도 안 골랐으면 모두 꺼짐)
  const fresh = join(tmp("cy-onb-fresh-"), "config.json");
  writeFileSync(fresh, JSON.stringify({ onboarded: false }));
  const fc = loadConfig({}, { onboarded: false });
  new Settings(fc, { path: fresh, env: {} }).put({ onboarded: true });
  const f2 = loadConfig({}, JSON.parse(readFileSync(fresh, "utf8")));
  assert.equal(f2.brain.provider, "local");
  assert.equal(f2.readSessions, false);
  assert.deepEqual(f2.repoRoots, []);
});
