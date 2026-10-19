// 수정 run 스트리밍 입력: 가짜 SDK로 중간 메시지 주입·중단·정지를 검증한다(진짜 모델 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runFix, InputQueue } from "./fixer.ts";
import { RunRegistry } from "./runs.ts";
import { INJECT_PREFIX, injectedPrompt, MAX_TURNS_NOTE } from "./run-inbox.ts";
import type { Config } from "./config.ts";
import type { Proposal } from "./store.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "cy-fixs-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true }); // Windows 엔 mkdir -p 명령이 없다
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  git(seed, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: seed });
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "app");
  return { root, app: join(root, "app"), origin: join(root, "origin.git"), wts: join(root, "wts") };
}

const cfgFor = (root: string) => ({ repoRoots: [root], gitAuthor: { name: "Bot", email: "bot@example.com" }, models: { code: "fake" } }) as unknown as Config;
const proposal = (app: string, id: string): Proposal => ({ id, repo: app, title: "add hello", plan: "hello.txt 추가", status: "approved", created: new Date().toISOString() });

// 가짜 SDK: 진짜처럼 입력을 바로바로 읽어 inbox 에 쌓고, inbox 의 메시지 하나 = 턴 하나.
// turn 안에서 ctx.inbox 를 꺼내 쓰면 "진행 중인 턴에 접어 넣기"(CLI 의 도구 경계 합치기)를 흉내 낸다
type Ctx = { cwd: string; emit: (m: any) => void; interrupted: Promise<void>; inbox: any[] };
function fakeSdk(turn: (n: number, msg: any, ctx: Ctx) => Promise<void>) {
  const calls: any[] = [];
  const fn = ({ prompt, options }: any) => {
    calls.push(options);
    const buf: any[] = [];
    let wake: (() => void) | undefined, done = false, err: any;
    const emit = (m: any) => { buf.push(m); wake?.(); };
    let onInterrupt!: () => void;
    let interrupted = new Promise<void>((r) => { onInterrupt = r; });
    options.abortController?.signal.addEventListener("abort", () => { err = Object.assign(new Error("aborted"), { name: "AbortError" }); wake?.(); });
    const inbox: any[] = [];
    let inputDone = false, inboxWake: (() => void) | undefined;
    (async () => { for await (const m of prompt as AsyncIterable<any>) { inbox.push(m); inboxWake?.(); } inputDone = true; inboxWake?.(); })();
    (async () => {
      let n = 0;
      emit({ type: "system", subtype: "init", session_id: "sess-fake", model: "fake", cwd: options.cwd });
      while (!err) {
        if (!inbox.length) {
          if (inputDone) break;
          await new Promise<void>((r) => { inboxWake = r; });
          inboxWake = undefined;
          continue;
        }
        const msg = inbox.shift();
        await turn(++n, msg, { cwd: options.cwd, emit, interrupted, inbox });
        interrupted = new Promise<void>((r) => { onInterrupt = r; });
      }
      done = true; wake?.();
    })().catch((e) => { err = e; wake?.(); });
    const it = (async function* () {
      while (true) {
        if (err) throw err;
        const m = buf.shift();
        if (m) { yield m; continue; }
        if (done) return;
        await new Promise<void>((r) => { wake = r; });
        wake = undefined;
      }
    })();
    // cancelAsyncMessage: CLI 큐(아직 턴에 안 들어간 것)에서 빼기 — 진짜 Query 의 런타임 메서드 흉내
    return Object.assign(it, {
      interrupt: async () => { onInterrupt(); },
      cancelAsyncMessage: async (u: string) => { const i = inbox.findIndex((m) => m.uuid === u); if (i < 0) return false; inbox.splice(i, 1); return true; },
    });
  };
  return { fn: fn as any, calls };
}
// 모델이 받은 사용자 말에서 감싼 앞머리(먼저 답하라)를 걷은 글
const said = (msg: any) => String(msg.message.content).replace(`${INJECT_PREFIX}\n`, "");
const text = (t: string, uuids?: string[]) => ({ type: "assistant", parent_tool_use_id: null, ...(uuids ? { user_message_uuids: uuids } : {}), message: { content: [{ type: "text", text: t }] } });
const ok = (structured?: any) => ({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, structured_output: structured });
const REPORT = (summary: string) => ({ summary, commit_message: "feat: add hello", tests_ran: "", tests_passed: true });
// 부하 중(테스트 파일 여럿이 동시에 git 워크트리를 만든다)엔 run 이 뜨기까지 3초를 넘기도 했다 — 조건이 되면 바로 끝나니 넉넉히 기다린다
const until = async (cond: () => boolean, ms = 30000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

test("InputQueue: push 순서대로, close 하면 끝", async () => {
  const q = new InputQueue();
  q.push("a"); q.push("b");
  const got: string[] = [];
  const reader = (async () => { for await (const m of q) got.push(String(m.message.content)); })();
  await until(() => got.length === 2);
  q.push("c"); q.close();
  await reader;
  assert.deepEqual(got, ["a", "b", "c"]);
  assert.throws(() => q.push("d"), /closed/);
});

test("실행 중 메시지 주입 → 다음 사용자 턴으로 들어가고 기록에 보인다 → 커밋·푸시", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const prompts: string[] = [];
  const sdk = fakeSdk(async (n, msg, { cwd, emit }) => {
    prompts.push(String(msg.message.content));
    if (n === 1) {
      emit(text("hello.txt 만들게"));
      writeFileSync(join(cwd, "hello.txt"), "hi\n");
      emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(cwd, "hello.txt"), content: "hi\n" } }] } });
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
      await gate; // 이 사이에 사용자가 메시지를 보낸다
      emit(ok(REPORT("hello 추가")));
    } else {
      emit(text(`받았어: ${said(msg)}`, [msg.uuid]));
      appendFileSync(join(cwd, "README.md"), "한 줄 더\n");
      emit(ok(REPORT("hello + README 한 줄")));
    }
  });
  const steps: string[] = [];
  const p = runFix(cfgFor(root), proposal(app, "prop-inject-1"), (s) => steps.push(s), { query: sdk.fn, runs: reg, worktreesDir: wts });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_result"));
  const id = reg.listRuns()[0].id;
  assert.equal(reg.summary(id)!.interactive, true);
  const sr = await reg.sendMessage(id, "그리고 README에 한 줄 추가해", { clientId: "c-1" }) as any;
  assert.equal(sr.ok, true);
  assert.equal(sr.pending, true);
  assert.equal(typeof sr.msgId, "string");
  release();
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], injectedPrompt("그리고 README에 한 줄 추가해")); // 모델엔 「먼저 짧게 답하고 이어 가라」로 감싸서
  const g = reg.getRun(id)!;
  assert.equal(g.run.status, "done");
  assert.equal(g.run.kind, "fix");
  assert.equal(g.run.sdkSessionId, "sess-fake");
  assert.equal(g.run.interactive, false);
  const users = g.events.filter((e) => e.type === "user");
  assert.equal(users.length, 2); // 첫 프롬프트 + 주입
  assert.equal(users[1].injected, true);
  assert.equal(users[1].text, "그리고 README에 한 줄 추가해"); // 기록엔 쓴 글 그대로
  assert.equal(users[1].clientId, "c-1");
  assert.equal(users[1].msgId, sr.msgId);
  assert.equal(users[1].pending, true);
  const dv = g.events.filter((e) => e.type === "delivery");
  assert.deepEqual(dv.map((e) => [e.msgId, e.state]), [[sr.msgId, "delivered"]]); // 다음 턴 첫 답에 uuid 가 찍힌 때
  assert.ok(g.events.some((e) => e.type === "assistant" && e.text === "받았어: 그리고 README에 한 줄 추가해"));
  assert.ok(g.events.some((e) => e.type === "tool_use" && e.name === "Write" && e.diff?.[0].new === "hi\n"));
  // 커밋은 cy-agent 가(작성자 고정), 원격 브랜치에 README 줄까지
  const branch = r.branch!;
  assert.match(git(origin, "log", "-1", "--format=%an <%ae>", branch), /Bot <bot@example.com>/);
  assert.match(git(origin, "show", `${branch}:README.md`), /한 줄 더/);
  assert.equal(existsSync(join(wts, "app-prop-inj")), false); // 워크트리 정리
  // 끝난 run 은 읽기 전용
  assert.equal((await reg.sendMessage(id, "또") as any).status, 409);
  // 스트리밍 입력 + 안전장치 유지
  const o = sdk.calls[0];
  assert.ok(o.abortController);
  assert.ok(o.hooks.PreToolUse);
  // 서브에이전트: 켜되(Agent 허용·글 전달·백그라운드 끔) 훅은 noShip + 서브에이전트 가드 둘 다
  assert.ok(!o.disallowedTools.includes("Agent"));
  assert.ok(o.allowedTools.includes("Agent"));
  assert.ok(o.disallowedTools.includes("WebFetch"));
  assert.equal(o.hooks.PreToolUse[0].hooks.length, 2);
  assert.equal(o.forwardSubagentText, true);
  assert.equal(o.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.ok(Object.keys(o.env).some((k) => k.toUpperCase() === "PATH" && o.env[k])); // Windows 는 Path
});

test("메시지가 턴에 붙었는지 모르면(uuid 미표시) 잠깐 기다렸다 끝낸다", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let n2 = 0;
  const sdk = fakeSdk(async (n, msg, { cwd, emit }) => {
    if (n === 1) {
      writeFileSync(join(cwd, "hello.txt"), "hi\n");
      emit(text("작업 중"));
      // 사용자가 보낸 메시지를 같은 턴에 접어 넣었다고 가정(별도 턴 없음, uuid 표시도 없음)
      await until(() => reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.injected));
      emit(ok(REPORT("hello")));
    } else n2++;
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-fold-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, idleAfterResultMs: 50 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "assistant"));
  const id = reg.listRuns()[0].id;
  await reg.sendMessage(id, "이것도");
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(n2, 1); // 큐에 남은 메시지는 다음 턴으로 갔다(가짜는 결과 없이 넘김)
});

test("진행 중인 턴에 접혀 들어간 메시지(도구 경계 뒤 응답) → 기다리지 않고 바로 마무리", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let folded = "";
  const sdk = fakeSdk(async (n, _msg, { cwd, emit, inbox }) => {
    assert.equal(n, 1);
    emit(text("hello 만들게"));
    emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 1" } }] } });
    await until(() => inbox.length > 0); // 사용자 메시지가 도착
    folded = String(inbox.shift().message.content); // CLI 가 도구 결과와 함께 접어 넣는다(uuid 표시 없음)
    emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] } });
    emit(text("README 도 고칠게"));
    writeFileSync(join(cwd, "hello.txt"), "hi\n");
    appendFileSync(join(cwd, "README.md"), "접힌 메시지 반영\n");
    emit(ok(REPORT("hello + README")));
  });
  const t0 = Date.now();
  const p = runFix(cfgFor(root), proposal(app, "prop-fold-2"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, idleAfterResultMs: 60_000 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_use"));
  await reg.sendMessage(reg.listRuns()[0].id, "README 에도 한 줄");
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  assert.equal(folded, injectedPrompt("README 에도 한 줄"));
  assert.ok(Date.now() - t0 < 10_000, "60초 대기 없이 끝나야 함");
  assert.match(git(origin, "show", `${r.branch}:README.md`), /접힌 메시지 반영/);
});

test("중단(interrupt) → 메시지 보내면 이어서 → 완료", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (n, msg, { cwd, emit, interrupted }) => {
    if (n === 1) {
      emit(text("오래 걸리는 일"));
      await interrupted;
      emit({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.01 });
    } else {
      emit(text(`이어서: ${msg.message.content}`, [msg.uuid]));
      writeFileSync(join(cwd, "hello.txt"), "after interrupt\n");
      emit(ok(REPORT("중단 후 이어서")));
    }
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-intr-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, awaitAfterInterruptMs: 5000 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "assistant"));
  const id = reg.listRuns()[0].id;
  assert.deepEqual(await reg.interrupt(id), { ok: true });
  await until(() => reg.getRun(id)!.events.some((e) => e.type === "system" && /중단됨/.test(e.text ?? "")));
  assert.equal(reg.summary(id)!.status, "running");
  await reg.sendMessage(id, "작게만 해");
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  assert.equal(reg.summary(id)!.status, "done");
});

test("중단 뒤 아무 말 없으면 정지 — 커밋 안 함", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (n, _msg, { cwd, emit, interrupted }) => {
    writeFileSync(join(cwd, "hello.txt"), "x\n");
    emit(text("일하는 중"));
    await interrupted;
    emit({ type: "result", subtype: "error_during_execution", is_error: true });
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-intr-2"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, awaitAfterInterruptMs: 30 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "assistant"));
  const id = reg.listRuns()[0].id;
  await reg.interrupt(id);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(reg.summary(id)!.status, "stopped");
  assert.equal(git(origin, "branch", "--list", "cy/*"), "");
});

test("정지(stop) → 저장 안 된 변경이 있으면 워크트리를 남기고 경로를 기록, 커밋·푸시 없음", async () => {
  const { root, app, origin, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (_n, _msg, { cwd, emit }) => {
    writeFileSync(join(cwd, "hello.txt"), "x\n");
    emit(text("일하는 중"));
    await new Promise(() => {}); // 끝나지 않는 턴
  });
  const p = runFix(cfgFor(root), { ...proposal(app, "prop-stop-1"), threadId: "th-1" }, () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "assistant"));
  const id = reg.listRuns()[0].id;
  assert.deepEqual(reg.summary(id)!.origin, { type: "proposal", proposalId: "prop-stop-1", threadId: "th-1" }); // 원래 화면: 그 제안(채팅 대화에서 나옴)
  const wt = reg.summary(id)!.cwd!;
  assert.ok(existsSync(wt));
  assert.deepEqual(await reg.stop(id), { ok: true });
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.summary, /정지/);
  assert.equal(reg.summary(id)!.status, "stopped");
  // hello.txt 가 커밋 안 된 채 남아 있다 → 워크트리·로컬 브랜치를 지우지 않는다
  assert.equal(existsSync(join(wt, "hello.txt")), true);
  assert.ok(reg.getRun(id)!.events.some((e) => e.type === "system" && e.worktree === wt && /남겨 뒀어요/.test(e.text ?? "")));
  assert.match(git(app, "branch", "--list", "cy/*"), /cy\//);
  assert.equal(git(origin, "branch", "--list", "cy/*"), "");
  assert.equal(git(origin, "rev-list", "--count", "--all"), "1");
});

// PR 대상 브랜치: 제안에 base 가 있으면 origin/<base> 에서 갈라 그 브랜치로 PR, 없으면 기본 브랜치, origin 에 없으면 실패
function withDevelop(o: ReturnType<typeof setupRepo>) {
  git(o.app, "checkout", "-q", "-b", "develop");
  writeFileSync(join(o.app, "DEV.md"), "develop only\n");
  git(o.app, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dev"], { cwd: o.app });
  git(o.app, "push", "-q", "origin", "develop");
  git(o.app, "checkout", "-q", "main");
}
const writeHello = () => fakeSdk(async (_n, _m, { cwd, emit }) => { writeFileSync(join(cwd, "hello.txt"), "hi\n"); emit(ok(REPORT("hello"))); });

test("PR 대상 브랜치 base=develop → origin/develop 에서 갈라 --base develop 으로 PR", async () => {
  const o = setupRepo();
  withDevelop(o);
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const ghCalls: string[][] = [];
  const steps: string[] = [];
  const r = await runFix(cfgFor(o.root), { ...proposal(o.app, "prop-base-dev"), base: "origin/develop" }, (s) => steps.push(s),
    { query: writeHello().fn, runs: reg, worktreesDir: o.wts, gh: (a) => { ghCalls.push(a); return "https://github.com/x/y/pull/9"; } });
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.prUrl, "https://github.com/x/y/pull/9");
  assert.deepEqual(ghCalls[0].slice(0, 5), ["pr", "create", "--base", "develop", "--head"]);
  assert.match(git(o.origin, "show", `${r.branch}:DEV.md`), /develop only/); // develop 위에서 갈랐다
  assert.ok(steps.some((s) => /기준 develop — PR 대상/.test(s)));
});

test("base 없으면 기본 브랜치(origin/HEAD) 기준 --base main", async () => {
  const o = setupRepo();
  withDevelop(o);
  const ghCalls: string[][] = [];
  const r = await runFix(cfgFor(o.root), proposal(o.app, "prop-base-def"), () => {},
    { query: writeHello().fn, runs: new RunRegistry(new DatabaseSync(":memory:")), worktreesDir: o.wts, gh: (a) => { ghCalls.push(a); return ""; } });
  assert.equal(r.ok, true, r.summary);
  assert.equal(ghCalls[0][3], "main");
  assert.throws(() => git(o.origin, "show", `${r.branch}:DEV.md`));
});

test("base 가 origin 에 없거나 이상한 이름이면 기본 브랜치로 대신하지 않고 실패", async () => {
  const o = setupRepo();
  const sdk = writeHello();
  const ghCalls: string[][] = [];
  const deps = { query: sdk.fn, runs: new RunRegistry(new DatabaseSync(":memory:")), worktreesDir: o.wts, gh: (a: string[]) => { ghCalls.push(a); return ""; } };
  await assert.rejects(runFix(cfgFor(o.root), { ...proposal(o.app, "prop-base-none"), base: "develop" }, () => {}, deps), /origin 에 develop 브랜치가 없어요/);
  await assert.rejects(runFix(cfgFor(o.root), { ...proposal(o.app, "prop-base-bad"), base: "--upload-pack=x" }, () => {}, deps), /브랜치 이름이 이상해요/);
  assert.equal(sdk.calls.length, 0);
  assert.equal(ghCalls.length, 0);
  assert.equal(git(o.origin, "branch", "--list", "cy/*"), "");
});

// ── 세션 창에서 보낸 말의 전달 상태(run-inbox.ts) ─────────────────────
const deliveries = (reg: RunRegistry, id: string) => reg.getRun(id)!.events.filter((e) => e.type === "delivery").map((e) => ({ msgId: e.msgId, state: e.state, now: !!e.now, seq: e.seq }));
const bashUse = (id: string, command: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (id: string, content = "", isError = false) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });

test("전달 상태: 도구(Bash sleep)가 도는 동안 보낸 말은 대기 중 → 도구가 끝나 경계에서 접혀 들어간 뒤에야 delivered", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let releaseTool!: () => void;
  const toolDone = new Promise<void>((r) => { releaseTool = r; });
  const sdk = fakeSdk(async (_n, _msg, { cwd, emit, inbox }) => {
    emit(bashUse("s1", "sleep 150"));
    await toolDone; // 150초짜리 도구
    emit(toolResult("s1"));
    inbox.shift(); // CLI 가 도구 경계에서 접어 넣는다(typed 턴이라 uuid 표시 없음)
    emit(text("물어본 것: 네 dev 에 떠 있어요"));
    writeFileSync(join(cwd, "hello.txt"), "hi\n");
    emit(ok(REPORT("hello")));
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-dlv-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, idleAfterResultMs: 60_000 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_use"));
  const id = reg.listRuns()[0].id;
  const sr = await reg.sendMessage(id, "url 줘봐") as any;
  await new Promise((r) => setTimeout(r, 30));
  // 도구가 끝나기 전: 기록엔 pending, delivery 없음(SDK 가 입력은 이미 가져갔어도 모델엔 안 닿음)
  assert.equal(reg.getRun(id)!.events.find((e) => e.msgId === sr.msgId && e.type === "user")!.pending, true);
  assert.deepEqual(deliveries(reg, id), []);
  releaseTool();
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  const d = deliveries(reg, id);
  assert.deepEqual(d.map((x) => [x.msgId, x.state]), [[sr.msgId, "delivered"]]);
  const resSeq = reg.getRun(id)!.events.find((e) => e.type === "tool_result")!.seq;
  assert.ok(d[0].seq > resSeq, "도구 결과 뒤에야 전달됨");
});

test("지금 보내기: 도는 도구를 interrupt 하고 그 말을 바로 다음 턴으로 — run 은 끝나지 않고 계속(완료까지)", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const turns: string[] = [];
  let killed = false;
  const sdk = fakeSdk(async (n, msg, { cwd, emit, interrupted }) => {
    turns.push(said(msg));
    if (n === 1) {
      emit(bashUse("s1", "sleep 150"));
      await interrupted; // 진짜 CLI: interrupt → Bash 프로세스를 죽이고 턴을 끝낸다. 큐에 남은 말은 살아남는다(still_queued)
      killed = true;
      emit(toolResult("s1", "Interrupted", true));
      emit({ type: "result", subtype: "error_during_execution", is_error: true });
    } else {
      emit(text(`먼저 답: ${said(msg)}`, [msg.uuid]));
      writeFileSync(join(cwd, "hello.txt"), "hi\n");
      emit(ok(REPORT("답하고 이어서 완료")));
    }
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-now-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, idleAfterResultMs: 5000 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_use"));
  const id = reg.listRuns()[0].id;
  await until(() => reg.getRun(id)!.events.some((e) => e.type === "tool_use") && true);
  const sr = await reg.sendMessage(id, "지금 url 줘") as any;
  assert.deepEqual(await reg.sendMessageNow(id, sr.msgId), { ok: true });
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  assert.equal(killed, true);
  assert.equal(turns[1], "지금 url 줘");
  assert.equal(reg.summary(id)!.status, "done"); // 멈춘 게 아니라 이어서 끝까지
  assert.deepEqual(deliveries(reg, id).map((x) => [x.msgId, x.state, x.now]), [[sr.msgId, "delivered", true]]);
  assert.ok(reg.getRun(id)!.events.some((e) => e.type === "system" && /지금 보내기/.test(e.text ?? "")));
  assert.equal((await reg.sendMessageNow(id, sr.msgId) as any).status, 409);
});

test("취소: 아직 안 닿은 말을 CLI 큐에서 빼고(cancelled), 모델은 끝내 못 받는다 · 이미 뺀 말은 409", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const turns: string[] = [];
  const sdk = fakeSdk(async (_n, msg, { cwd, emit }) => {
    turns.push(said(msg));
    emit(bashUse("s1", "sleep 5"));
    await gate;
    emit(toolResult("s1"));
    writeFileSync(join(cwd, "hello.txt"), "hi\n");
    emit(ok(REPORT("hello")));
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-cxl-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts, idleAfterResultMs: 60_000 });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_use"));
  const id = reg.listRuns()[0].id;
  const sr = await reg.sendMessage(id, "이거 하지 마") as any;
  await new Promise((r) => setTimeout(r, 20)); // SDK 가 CLI 큐로 가져간 뒤
  assert.deepEqual(await reg.cancelMessage(id, sr.msgId), { ok: true });
  assert.equal((await reg.cancelMessage(id, sr.msgId) as any).status, 409);
  release();
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.ok, true, r.summary);
  assert.ok(Date.now() - t0 < 10_000, "취소한 말을 기다리지 않는다");
  assert.equal(turns.length, 1);
  assert.deepEqual(deliveries(reg, id).map((x) => [x.msgId, x.state]), [[sr.msgId, "cancelled"]]);
});

test("닿기 전에 정지하면 그 말은 unsent(세션 창이 이어서 묻기로 다시 보냄) · 저장 안 된 게 없으면 워크트리 정리", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (_n, _msg, { emit }) => {
    emit(bashUse("s1", "sleep 150"));
    await new Promise(() => {});
  });
  const p = runFix(cfgFor(root), proposal(app, "prop-uns-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts });
  await until(() => reg.listRuns().length === 1 && reg.getRun(reg.listRuns()[0].id)!.events.some((e) => e.type === "tool_use"));
  const id = reg.listRuns()[0].id;
  const sr = await reg.sendMessage(id, "질문") as any;
  await reg.stop(id);
  await p;
  assert.deepEqual(deliveries(reg, id).map((x) => [x.msgId, x.state]), [[sr.msgId, "unsent"]]);
  const ev = reg.getRun(id)!.events;
  assert.ok(ev.findIndex((e) => e.type === "delivery") < ev.findIndex((e) => e.type === "status"), "status 가 마지막 줄");
  assert.equal(existsSync(reg.summary(id)!.cwd!), false);
  assert.equal(git(app, "branch", "--list", "cy/*"), "");
});

test("턴 한도 없음 · 그래도 error_max_turns 가 나면 실패가 아니라 멈춤 — 뒤따르는 exit code 1 도 충돌로 안 봄, 저장 안 된 작업은 워크트리째 남김", async () => {
  const { root, app, wts } = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (_n, _msg, { cwd, emit }) => {
    writeFileSync(join(cwd, "half.txt"), "반쯤\n");
    emit(text("검증 중"));
    emit({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 4.99 });
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("Claude Code process exited with code 1");
  });
  const r = await runFix(cfgFor(root), proposal(app, "prop-max-1"), () => {}, { query: sdk.fn, runs: reg, worktreesDir: wts });
  assert.equal(sdk.calls[0].maxTurns, undefined); // 한도를 걸지 않는다
  assert.equal(r.ok, false);
  assert.match(r.summary, /턴 한도/);
  const id = reg.listRuns()[0].id;
  const run = reg.summary(id)!;
  assert.equal(run.status, "stopped");
  assert.equal(run.error, MAX_TURNS_NOTE);
  assert.equal(run.costUsd, 4.99);
  const ev = reg.getRun(id)!.events;
  assert.ok(ev.some((e) => e.type === "status" && e.text === `stopped: ${MAX_TURNS_NOTE}`));
  assert.ok(ev.some((e) => e.type === "system" && e.worktree === run.cwd));
  assert.equal(existsSync(join(run.cwd!, "half.txt")), true);
});
