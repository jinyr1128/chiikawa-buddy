// 터미널 Claude Code 에서 이어 간 대화 불러오기(cli-sync.ts) — 합성 기록(src/fixtures/cli-sync)만 쓴다(실제 ~/.claude·모델 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunRegistry, logSdkMessage } from "./runs.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { askCwd } from "./brain.ts";
import {
  CliSync, CLI_LIMITS, HEADER_TEXT, convertMain, convertSub, findSessionFile, projectDirName, readFrom, sessionCwd, subagentFiles, taskNotification, userText,
} from "./cli-sync.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const FIX = fileURLToPath(new URL("./fixtures/cli-sync/", import.meta.url)); // Windows: .pathname 은 /C:/… 라 못 쓴다
// Windows 의 Claude Code 기록은 cwd 를 C:\… 로 적는다 → 픽스처의 /Users/tester/… 도 Windows 에선 C:\Users\tester\… 로 바꿔 쓴다
const WIN = process.platform === "win32";
const REPO = WIN ? "C:\\Users\\tester\\code\\demo" : "/Users/tester/code/demo";
const BRAIN = WIN ? "C:\\Users\\tester\\.cy-agent\\brain" : "/Users/tester/.cy-agent/brain";
const fixText = (f: string) => {
  const t = readFileSync(join(FIX, f), "utf8");
  return WIN ? t.replace(/\/Users\/tester(?:\/[\w.-]+)*/g, (m) => "C:" + m.replace(/\//g, "\\\\")) : t; // JSON 글 안이라 \ 를 두 번
};
const lines = (f: string) => fixText(f).split("\n").filter(Boolean).map((l) => JSON.parse(l));

// 임시 ~/.claude: projects/<demo 레포>/<sid>.jsonl + 서브에이전트
function claudeHome() {
  const dir = mkdtempSync(join(tmpdir(), "cy-cli-sync-"));
  const proj = join(dir, "projects", projectDirName(REPO));
  mkdirSync(join(proj, SID, "subagents"), { recursive: true });
  writeFileSync(join(proj, `${SID}.jsonl`), fixText("session.jsonl"));
  for (const f of ["agent-a1.jsonl", "agent-a1.meta.json", "agent-other.jsonl", "agent-other.meta.json"]) writeFileSync(join(proj, SID, "subagents", f), fixText(f));
  return { dir, proj, file: join(proj, `${SID}.jsonl`), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function setup(cwd = BRAIN) {
  const home = claudeHome();
  const store = new Store(":memory:");
  const reg = new RunRegistry(store.db);
  const thread = store.createThread({ title: "데모 대화" });
  store.addChat("user", "처음 질문(데몬)", undefined, undefined, thread.id);
  store.addChat("assistant", "처음 답(데몬)", undefined, undefined, thread.id);
  const run = reg.startRun({ kind: "chat", title: "채팅: 처음 질문", cwd, ref: thread.id, origin: { type: "thread", threadId: thread.id } });
  run.setSession(SID);
  run.log({ type: "user", text: "처음 질문(데몬)" });
  run.end("done");
  const touched: string[] = [];
  const sync = new CliSync({ runs: reg, db: store.db, store, claudeDir: home.dir, onThread: (id) => touched.push(id) });
  return { home, store, reg, thread, run, sync, touched };
}

test("convertMain: 터미널 줄만 · 합성 답·thinking 빼고 · 백그라운드 서브에이전트 결과는 알림으로 · 대화에는 말·답 글", () => {
  const c = convertMain(lines("session.jsonl"));
  assert.deepEqual(c.events.map((e) => [e.type, e.text ?? e.name ?? e.toolUseId]), [
    ["user", "터미널에서 물어봄"],
    ["tool_use", "Bash"],
    ["tool_result", "toolu_b1"],
    ["tool_use", "Agent"],
    ["assistant", "조사 맡겼어요 token=abcdef123456"], // 가림은 logEvent(sanitize)가
    ["tool_result", "toolu_ag1"],
    ["assistant", "결과 정리했어요"],
  ]);
  assert.ok(c.events.every((e) => e.via === "cli" && !e.parent && e.at));
  assert.equal(c.events[1].input, "ls -la");
  assert.equal(c.events[3].input, "조사");
  assert.equal(c.events[5].output, "조사 끝: 3곳");
  assert.deepEqual(c.asyncAgents, [{ agentId: "a1", toolUseId: "toolu_ag1" }]);
  assert.deepEqual(c.chat.map((m) => [m.role, m.text]), [["user", "터미널에서 물어봄"], ["assistant", "조사 맡겼어요 token=abcdef123456"], ["assistant", "결과 정리했어요"]]);
  assert.match(c.lastUuid!, /^00000000-/);
});

test("convertSub: 포크 맥락 되풀이(부모 Agent 호출·띄웠어요 결과)·보일러플레이트 빼고 parent 달기", () => {
  const s = convertSub(lines("agent-a1.jsonl"), "toolu_ag1");
  assert.deepEqual(s.events.map((e) => [e.type, e.text ?? e.name ?? e.toolUseId, e.parent, e.via]), [
    ["user", "조사해줘", "toolu_ag1", "cli"],
    ["tool_use", "Grep", "toolu_ag1", "cli"],
    ["tool_result", "toolu_g1", "toolu_ag1", "cli"],
    ["assistant", "찾았어요", "toolu_ag1", "cli"],
  ]);
  assert.equal(s.events[1].input, `needle in ${REPO}`);
});

test("userText·taskNotification: 슬래시 명령·! 셸·중단·알림 모양", () => {
  assert.deepEqual(userText("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"), { kind: "user", text: "/model opus" });
  assert.deepEqual(userText("<local-command-stdout>Set model</local-command-stdout>"), { kind: "system", text: "Set model" });
  assert.deepEqual(userText("<bash-input>ls</bash-input>"), { kind: "user", text: "! ls" });
  assert.deepEqual(userText("[Request interrupted by user]"), { kind: "system", text: "중단됨(Claude Code)" });
  assert.equal(userText("<local-command-caveat>x</local-command-caveat>"), undefined);
  assert.equal(userText("   "), undefined);
  assert.deepEqual(taskNotification("<task-notification><tool-use-id>toolu_1</tool-use-id><status>failed</status><summary>s</summary></task-notification>"), { toolUseId: "toolu_1", status: "failed", output: "s" });
  assert.equal(taskNotification("<task-notification><tool-use-id>bad id!</tool-use-id></task-notification>"), undefined);
  assert.equal(taskNotification("그냥 말"), undefined);
});

test("findSessionFile: 기록된 cwd 폴더에 없으면 projects/*/<sid>.jsonl · 실제 cwd 는 기록의 cwd 필드 · 심볼릭 링크·잘못된 id 거부", () => {
  const h = claudeHome();
  try {
    assert.equal(findSessionFile(h.dir, SID, BRAIN)?.file, h.file); // brain 폴더엔 없지만 데모 레포 폴더에서 찾음
    assert.equal(findSessionFile(h.dir, SID, REPO)?.file, h.file);
    assert.equal(findSessionFile(h.dir, "not-a-uuid", REPO), undefined);
    assert.equal(findSessionFile(h.dir, "22222222-2222-4333-8444-555555555555", REPO), undefined);
    assert.equal(sessionCwd(readFileSync(h.file, "utf8"), h.proj), REPO); // 터미널이 brain 에서 이어 갔어도 프로젝트 폴더와 맞는 cwd
    assert.equal(sessionCwd(readFileSync(h.file, "utf8")), REPO);
    assert.deepEqual(subagentFiles(findSessionFile(h.dir, SID, REPO)!, SID).map((s) => [s.agentId, !!s.meta]), [["a1", true], ["other", true]]);
    // 심볼릭 링크 파일은 안 따라간다
    const evil = join(h.dir, "projects", "-evil");
    mkdirSync(evil);
    const sid2 = "33333333-2222-4333-8444-555555555555";
    symlinkSync(h.file, join(evil, `${sid2}.jsonl`));
    assert.equal(findSessionFile(h.dir, sid2), undefined);
  } finally { h.done(); }
});

test("readFrom: 줄바꿈으로 끝난 줄만(쓰는 중인 마지막 조각은 다음에)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-cli-read-"));
  try {
    const f = join(dir, "x.jsonl");
    writeFileSync(f, '{"a":1}\n{"b":');
    const r = readFrom(f, 0, 1024);
    assert.deepEqual(r.lines.map((l) => l.text), ['{"a":1}']);
    assert.equal(r.lines[0].end, 8);
    appendFileSync(f, "2}\n");
    assert.deepEqual(readFrom(f, 8, 1024).lines.map((l) => l.text), ['{"b":2}']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CliSync.sync: run 기록(via cli·가림·서브에이전트 parent)과 원래 대화(Claude Code 표시)에 붙이고, 다시 불러도 겹치지 않음", () => {
  const { home, store, reg, thread, run, sync, touched } = setup();
  try {
    const before = reg.getRun(run.id)!.events.length;
    const r = sync.sync(run.id);
    assert.equal(r.ok, true);
    const evs = reg.getRun(run.id)!.events.slice(before);
    assert.equal(r.ok && r.imported, evs.length);
    assert.equal(evs[0].type, "system");
    assert.equal(evs[0].text, HEADER_TEXT);
    assert.ok(evs.every((e) => e.via === "cli"));
    const top = evs.filter((e) => !e.parent);
    assert.deepEqual(top.slice(1).map((e) => e.type), ["user", "tool_use", "tool_result", "tool_use", "assistant", "tool_result", "assistant"]);
    assert.match(top.find((e) => e.type === "assistant")!.text!, /token=«redacted»/);
    const sub = evs.filter((e) => e.parent === "toolu_ag1");
    assert.deepEqual(sub.map((e) => e.type), ["user", "tool_use", "tool_result", "assistant"]);
    assert.ok(!evs.some((e) => e.text === "데몬 서브에이전트")); // 데몬이 띄운(이 run 기록에 터미널 Agent 줄이 없는) 서브에이전트는 안 붙음
    assert.ok(!evs.some((e) => e.text === "처음 답(데몬)" || e.text === "No response requested."));
    // 대화: 터미널 말·답만, Claude Code 표시
    const msgs = store.threadMessages(thread.id);
    assert.deepEqual(msgs.slice(2).map((m) => [m.role, m.text, m.via]), [
      ["user", "터미널에서 물어봄", "cli"], ["assistant", "조사 맡겼어요 token=«redacted»", "cli"], ["assistant", "결과 정리했어요", "cli"],
    ]);
    assert.equal(msgs[0].via, undefined);
    assert.deepEqual(touched, [thread.id]);
    assert.equal(store.thread(thread.id)!.cliSync, true);
    // 다시: 새 것 없음
    assert.deepEqual(sync.sync(run.id), { ok: true, imported: 0 });
    assert.equal(store.threadMessages(thread.id).length, 5);
    // 터미널에서 한 턴 더 → 그것만
    const t = new Date().toISOString();
    appendFileSync(home.file, [
      JSON.stringify({ type: "user", entrypoint: "cli", uuid: "99999999-0000-4000-8000-000000000001", timestamp: t, message: { role: "user", content: "하나 더" } }),
      JSON.stringify({ type: "assistant", entrypoint: "cli", uuid: "99999999-0000-4000-8000-000000000002", timestamp: t, message: { role: "assistant", model: "m", content: [{ type: "text", text: "네" }] } }),
    ].join("\n") + "\n");
    appendFileSync(join(home.proj, SID, "subagents", "agent-a1.jsonl"), JSON.stringify({ type: "assistant", isSidechain: true, entrypoint: "cli", uuid: "99999999-0000-4000-8000-000000000003", timestamp: t, message: { role: "assistant", model: "m", content: [{ type: "text", text: "더 찾음" }] } }) + "\n");
    const r2 = sync.sync(run.id);
    assert.deepEqual(r2, { ok: true, imported: 3 });
    const tail = reg.getRun(run.id)!.events.slice(-3);
    assert.deepEqual(tail.map((e) => [e.type, e.text, e.parent ?? null]), [["user", "하나 더", null], ["assistant", "네", null], ["assistant", "더 찾음", "toolu_ag1"]]);
    assert.ok(!reg.getRun(run.id)!.events.slice(before + 1).some((e) => e.text === HEADER_TEXT)); // 머리 줄은 처음 한 번
    assert.deepEqual(store.threadMessages(thread.id).slice(-2).map((m) => m.text), ["하나 더", "네"]);
  } finally { home.done(); }
});

test("CliSync.sync: 없는 run 404 · 세션 id 없음 409 · 기록 파일 없음 404 · 대화 단위 ↻", () => {
  const { home, reg, thread, run, sync } = setup(REPO);
  try {
    assert.deepEqual(sync.sync("nope"), { ok: false, status: 404, error: "no such run" });
    const bare = reg.startRun({ kind: "chat", title: "세션 없음" });
    assert.equal((sync.sync(bare.id) as any).status, 409);
    const other = reg.startRun({ kind: "chat", title: "다른 세션", cwd: REPO });
    other.setSession("44444444-2222-4333-8444-555555555555");
    assert.equal((sync.sync(other.id) as any).status, 404);
    assert.deepEqual(reg.runsForThread(thread.id).map((r) => r.id), [run.id]);
    const t = sync.syncThread(thread.id);
    assert.equal(t.ok && t.imported > 5, true);
    assert.equal((sync.syncThread("no-thread") as any).status, 404);
  } finally { home.done(); }
});

test("CliSync.sync: run 당 읽는 양 상한 — 넘으면 시스템 줄 한 번", () => {
  const { home, reg, run, sync } = setup();
  const keep = CLI_LIMITS.bytesPerRun;
  try {
    CLI_LIMITS.bytesPerRun = 300; // 첫 줄 몇 개만
    sync.sync(run.id);
    sync.sync(run.id);
    const caps = reg.getRun(run.id)!.events.filter((e) => /너무 커서/.test(e.text ?? ""));
    assert.equal(caps.length, 1);
  } finally { CLI_LIMITS.bytesPerRun = keep; home.done(); }
});

test("CliSync.watch: 지켜보는 동안 run 에 watching, 새 줄이 오면 불러오고, unwatch 로 끔", async () => {
  const { home, reg, run, sync } = setup();
  const keep = [CLI_LIMITS.debounceMs, CLI_LIMITS.pollMs];
  CLI_LIMITS.debounceMs = 20;
  CLI_LIMITS.pollMs = 100; // fs.watch 가 늦어도(부하) 폴링으로
  try {
    const seen: any[] = [];
    const off = reg.subscribe((u) => { if (u.type === "runs" && u.run.id === run.id) seen.push(u.run.watching ?? false); });
    const w = sync.watch(run.id);
    assert.equal(w.ok, true);
    assert.equal(reg.summary(run.id)!.watching, true);
    assert.deepEqual(sync.watchingIds(), [run.id]);
    appendFileSync(home.file, JSON.stringify({ type: "user", entrypoint: "cli", uuid: "99999999-0000-4000-8000-00000000000a", timestamp: new Date().toISOString(), message: { role: "user", content: "지켜보는 중 한 말" } }) + "\n");
    for (let i = 0; i < 250 && !reg.getRun(run.id)!.events.some((e) => e.text === "지켜보는 중 한 말"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(reg.getRun(run.id)!.events.some((e) => e.text === "지켜보는 중 한 말"));
    sync.unwatch(run.id);
    assert.equal(reg.summary(run.id)!.watching, undefined);
    assert.ok(seen.includes(true) && seen[seen.length - 1] === false);
    off();
  } finally { [CLI_LIMITS.debounceMs, CLI_LIMITS.pollMs] = keep; sync.close(); home.done(); }
});

test("CliSync.importSession: 세션 id 로 채팅 run 하나(기록의 cwd·첫 말 제목·끝남) · 다시 넣으면 그 run · 잘못된 id 400 · 기록 없음 404", () => {
  const home = claudeHome();
  try {
    const store = new Store(":memory:");
    const reg = new RunRegistry(store.db);
    const sync = new CliSync({ runs: reg, db: store.db, store, claudeDir: home.dir });
    const r = sync.importSession(SID);
    assert.ok(r.ok && r.imported > 0 && !r.existing);
    const got = reg.getRun(r.runId)!;
    assert.equal(got.run.kind, "chat");
    assert.equal(got.run.status, "done");
    assert.equal(got.run.sdkSessionId, SID);
    assert.equal(got.run.cwd, REPO);
    assert.equal(got.run.title, "Claude Code: 터미널에서 물어봄");
    assert.ok(got.events.some((e) => e.type === "system" && e.text === HEADER_TEXT));
    assert.ok(got.events.some((e) => e.type === "user" && e.text === "터미널에서 물어봄" && e.via === "cli"));
    const again = sync.importSession(SID);
    assert.deepEqual(again, { ok: true, runId: r.runId, imported: 0, existing: true });
    assert.equal(reg.listRuns().length, 1);
    assert.deepEqual(sync.importSession("not-a-uuid"), { ok: false, status: 400, error: "세션 id 는 UUID 여야 해요" });
    assert.equal((sync.importSession("22222222-2222-4333-8444-555555555555") as any).status, 404);
  } finally { home.done(); }
});

test("run cwd: SDK init 의 cwd 로 고침 · askCwd 는 관련 레포(대화형·코드 보기), 아니면 brain", () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const run = reg.startRun({ kind: "chat", title: "x", cwd: BRAIN });
  const repo = REPO; // Windows SDK 는 C:\… 로 준다
  logSdkMessage(run, { type: "system", subtype: "init", session_id: SID, cwd: repo, model: "m" });
  assert.equal(reg.summary(run.id)!.cwd, repo);
  assert.equal(reg.summary(run.id)!.sdkSessionId, SID);
  logSdkMessage(run, { type: "system", subtype: "init", session_id: SID, cwd: "relative/x" });
  assert.equal(reg.summary(run.id)!.cwd, repo);
  if (process.platform === "win32") { logSdkMessage(run, { type: "system", subtype: "init", session_id: SID, cwd: "\\\\evil\\share" }); assert.equal(reg.summary(run.id)!.cwd, repo); } // UNC 는 안 받음
  const cfg = { repoRoots: [WIN ? "C:\\Users\\tester\\code" : "/Users/tester/code"] } as any;
  assert.equal(askCwd(cfg, { interactive: { origin: { via: "chat" } } as any, code: { roots: cfg.repoRoots, cwd: REPO } }), REPO);
  assert.equal(askCwd(cfg, { code: { roots: cfg.repoRoots, cwd: REPO } }), REPO);
  assert.match(askCwd(cfg, { interactive: { origin: { via: "chat" } } as any, code: { roots: cfg.repoRoots, cwd: "/etc" } }), /brain$/);
  assert.match(askCwd(cfg, {}), /brain$/);
  assert.match(askCwd(cfg, { tools: false, code: { roots: cfg.repoRoots, cwd: REPO } }), /brain$/);
});

test("POST /runs/:id/sync · /chat/threads/:id/sync: CSRF·입력 검증·결과", async () => {
  const calls: any[] = [];
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    runSync: (id, o) => { calls.push([id, o.watch]); return id === "gone" ? { ok: false, status: 404, error: "no such run" } : { ok: true, imported: 3 }; },
    threadSync: (id) => ({ ok: true, imported: id.length }),
    runImport: (sid) => { calls.push(["import", sid]); return sid === "gone" ? { ok: false, status: 404, error: "없음" } : { ok: true, runId: "r9", imported: 2 }; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, body?: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + p, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await post("/runs/r1/sync", undefined, {})).status, 403);
    const ok = await post("/runs/r1/sync");
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true, imported: 3 }]);
    assert.equal((await post("/runs/r1/sync", { watch: true })).status, 200);
    assert.equal((await post("/runs/r1/sync", { watch: "yes" })).status, 400);
    assert.equal((await post("/runs/r1/sync", { other: 1 })).status, 400);
    assert.equal((await post("/runs/gone/sync")).status, 404);
    assert.deepEqual(calls, [["r1", false], ["r1", true], ["gone", false]]);
    assert.deepEqual(await (await post("/chat/threads/abcd/sync")).json(), { ok: true, imported: 4 });
    assert.equal((await post("/runs/import", { sessionId: SID }, {})).status, 403);
    const imp = await post("/runs/import", { sessionId: ` ${SID} ` });
    assert.deepEqual([imp.status, await imp.json()], [200, { ok: true, runId: "r9", imported: 2 }]);
    assert.equal((await post("/runs/import", {})).status, 400);
    assert.equal((await post("/runs/import", { sessionId: SID, x: 1 })).status, 400);
    assert.equal((await post("/runs/import", { sessionId: "gone" })).status, 404);
    assert.deepEqual(calls.slice(3), [["import", SID], ["import", "gone"]]);
  } finally { bus.close(); }
});
