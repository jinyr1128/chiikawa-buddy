// 작업 세션 이어서 하기: 끝난 수정 run → 연결된 새 수정 run(같은 브랜치·resume/요약), 브랜치 없음 → 기본 브랜치,
// 그 밖의 run → 대화로 이어가기, 새 작업 → 제안, 정기 작업 표시, 라우트
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runFix, type FixDeps } from "./fixer.ts";
import { RunRegistry, asRoutine, inRunContext, summarizeRun, finalOutput } from "./runs.ts";
import { FollowUps, followUpChatText, type FollowUpPorts } from "./followup.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import type { Config } from "./config.ts";
import type { Proposal } from "./store.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const until = async (cond: () => boolean, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "cy-follow-"));
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

// 가짜 SDK: 턴마다 handler(msg 내용, cwd, options) — 파일을 고치고 구조화 결과를 보고
function fakeSdk(handler: (prompt: string, cwd: string, options: any) => void) {
  const calls: any[] = [];
  const prompts: string[] = [];
  const fn = ({ prompt, options }: any) => {
    calls.push(options);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: options.resume ? "sess-child" : "sess-parent", model: "fake", cwd: options.cwd };
      for await (const m of prompt as AsyncIterable<any>) {
        const text = String(m.message.content);
        prompts.push(text);
        handler(text, options.cwd, options);
        yield { type: "assistant", parent_tool_use_id: null, user_message_uuids: [m.uuid], message: { content: [{ type: "text", text: "했어요" }] } };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, structured_output: { summary: "바꿈", commit_message: "docs: readme", tests_ran: "", tests_passed: true } };
      }
    })();
  };
  return { fn: fn as any, calls, prompts };
}

async function parentFix(o: ReturnType<typeof setupRepo>, reg: RunRegistry, store: Store, deps: FixDeps) {
  store.addProposal({ id: "prop-follow-1", repo: o.app, title: "add hello", plan: "hello.txt 추가" });
  const p = store.proposal("prop-follow-1")!;
  const r = await runFix(cfgFor(o.root), p, () => {}, { runs: reg, worktreesDir: o.wts, ...deps });
  assert.equal(r.ok, true, r.summary);
  return { p, r, run: reg.listRuns()[0] };
}

function ports(o: ReturnType<typeof setupRepo>, reg: RunRegistry, store: Store, extra: Partial<FollowUpPorts> = {}) {
  const jobs: Promise<unknown>[] = [];
  const bubbles: any[] = [];
  const chats: string[] = [];
  const proposed: any[] = [];
  const f = new FollowUps({
    cfg: cfgFor(o.root), store, runs: reg,
    chat: (t) => { chats.push(t); return `chat-${chats.length}`; },
    enqueue: (job) => { jobs.push(job()); },
    propose: async (pr) => { proposed.push(pr); if (!pr.repo.startsWith(o.root)) return undefined; store.addProposal({ id: "np1", ...pr }); return store.proposal("np1"); },
    bubble: (b) => { bubbles.push(b); },
    mood: () => {}, reactions: () => undefined, changed: () => {},
    ...extra,
  });
  return { f, jobs, bubbles, chats, proposed };
}

test("끝난 수정 run 이어서 하기 → 같은 워크트리 경로·resume(fork), 같은 브랜치에 커밋·푸시, 부모·자식 연결", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const sdk = fakeSdk((t, cwd) => {
    if (t.startsWith("다음 변경을")) writeFileSync(join(cwd, "hello.txt"), "hi\n");
    else appendFileSync(join(cwd, "README.md"), "한 줄 더\n");
  });
  const { r: first, run: parent } = await parentFix(o, reg, store, { query: sdk.fn });
  assert.equal(parent.branch, first.branch);
  assert.equal(parent.repo, git(o.app, "rev-parse", "--show-toplevel"));
  assert.equal(parent.sdkSessionId, "sess-parent");
  const before = git(o.origin, "rev-parse", first.branch!);

  const seen: string[] = [];
  const { f, jobs } = ports(o, reg, store, { fixDeps: { query: sdk.fn, worktreesDir: o.wts, sessionExists: async (sid, cwd) => { seen.push(`${sid}@${cwd}`); return true; }, prState: () => undefined } });
  const res = f.continueRun(parent.id, "README에 한 줄 더 추가해");
  assert.equal(res.ok, true);
  assert.equal((res as any).mode, "fix");
  const childId = (res as any).runId;
  // 바로 연결된 run 이 생긴다(세션 창이 곧장 고를 수 있게)
  const child0 = reg.summary(childId)!;
  assert.equal(child0.parentId, parent.id);
  assert.equal(child0.title, "add hello · 이어서");
  assert.deepEqual(reg.summary(parent.id)!.childIds, [childId]);
  assert.ok(reg.getRun(parent.id)!.events.some((e) => e.type === "system" && e.childId === childId));
  await Promise.all(jobs);

  const child = reg.getRun(childId)!;
  assert.equal(child.run.status, "done", child.run.error ?? "");
  assert.equal(child.run.branch, first.branch);
  assert.equal(child.run.cwd, parent.cwd); // resume 은 같은 경로여야 세션을 찾는다
  assert.deepEqual(seen, [`sess-parent@${parent.cwd}`]);
  const opts = sdk.calls[1];
  assert.equal(opts.resume, "sess-parent");
  assert.equal(opts.forkSession, true);
  assert.equal(opts.cwd, parent.cwd);
  assert.ok(opts.hooks.PreToolUse); // 안전장치 그대로
  assert.ok(!sdk.prompts[1].includes("앞선 작업 기록")); // resume 이면 요약 안 넣음
  assert.match(sdk.prompts[1], /README에 한 줄 더 추가해/);
  assert.equal(child.run.sdkSessionId, "sess-child");
  assert.ok(child.events.some((e) => e.type === "user" && e.injected && e.text === "README에 한 줄 더 추가해"));
  assert.ok(child.events.some((e) => e.type === "system" && /resume/.test(e.text ?? "")));
  // 같은 브랜치에 이어서(앞선 커밋 위에) 푸시, 작성자 고정
  assert.equal(git(o.origin, "rev-parse", `${first.branch}~1`), before);
  assert.match(git(o.origin, "show", `${first.branch}:README.md`), /한 줄 더/);
  assert.match(git(o.origin, "show", `${first.branch}:hello.txt`), /hi/);
  assert.match(git(o.origin, "log", "-1", "--format=%an|%B", first.branch!), /^Bot\|docs: readme[\s\S]*continue of run/);
  assert.equal(existsSync(parent.cwd!), false); // 워크트리 정리
});

test("세션을 다시 열 수 없으면 요약을 넣고 새 세션 · 원격 브랜치가 없으면 기본 브랜치에서 새 브랜치(기록에 알림)", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const sdk = fakeSdk((t, cwd) => { if (t.startsWith("다음 변경을")) writeFileSync(join(cwd, "hello.txt"), "hi\n"); else appendFileSync(join(cwd, "README.md"), "두 번째\n"); });
  const { r: first, run: parent } = await parentFix(o, reg, store, { query: sdk.fn });
  git(o.origin, "branch", "-D", first.branch!); // 브랜치가 사라졌다(머지 후 삭제 등)
  const { f, jobs } = ports(o, reg, store, { fixDeps: { query: sdk.fn, worktreesDir: o.wts, sessionExists: async () => false, prState: () => undefined } });
  const res = f.continueRun(parent.id, "README 고쳐") as any;
  await Promise.all(jobs);
  const child = reg.getRun(res.runId)!;
  assert.equal(child.run.status, "done", child.run.error ?? "");
  assert.notEqual(child.run.branch, first.branch);
  assert.match(child.run.branch!, /^cy\/add-hello-/);
  assert.ok(child.events.some((e) => e.type === "system" && /원격에 없어서 main 에서 새 브랜치/.test(e.text ?? "")));
  assert.ok(child.events.some((e) => e.type === "system" && /요약/.test(e.text ?? "")));
  assert.equal(sdk.calls[1].resume, undefined);
  assert.match(sdk.prompts[1], /앞선 작업 기록\(요약\)/);
  assert.match(sdk.prompts[1], /제목: add hello/);
  assert.match(sdk.prompts[1], /기본 브랜치\(main\)에서 새 브랜치로/);
  assert.match(git(o.origin, "show", `${child.run.branch}:README.md`), /두 번째/);
  assert.equal(existsSync(join(o.origin, "refs/heads", first.branch!)), false);
});

test("이어서 하기는 원래 제안의 PR 대상 브랜치(base)를 이어받는다 — 새 브랜치도 develop 에서, PR 도 --base develop", async () => {
  const o = setupRepo();
  git(o.app, "checkout", "-q", "-b", "develop");
  writeFileSync(join(o.app, "DEV.md"), "develop only\n");
  git(o.app, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dev"], { cwd: o.app });
  git(o.app, "push", "-q", "origin", "develop");
  git(o.app, "checkout", "-q", "main");
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const ghCalls: string[][] = [];
  const gh = (a: string[]) => { ghCalls.push(a); return ""; };
  const sdk = fakeSdk((t, cwd) => { if (t.startsWith("다음 변경을")) writeFileSync(join(cwd, "hello.txt"), "hi\n"); else appendFileSync(join(cwd, "README.md"), "x\n"); });
  store.addProposal({ id: "prop-follow-dev", repo: o.app, title: "add hello", plan: "hello.txt 추가", base: "develop" });
  const first = await runFix(cfgFor(o.root), store.proposal("prop-follow-dev")!, () => {}, { runs: reg, worktreesDir: o.wts, query: sdk.fn, gh });
  assert.equal(first.ok, true, first.summary);
  assert.equal(ghCalls[0][3], "develop");
  git(o.origin, "branch", "-D", first.branch!); // 브랜치가 사라졌다 → 새 브랜치로
  const parent = reg.listRuns()[0];
  const { f, jobs } = ports(o, reg, store, { fixDeps: { query: sdk.fn, worktreesDir: o.wts, sessionExists: async () => false, prState: () => undefined, gh } });
  const res = f.continueRun(parent.id, "README 고쳐") as any;
  await Promise.all(jobs);
  const child = reg.getRun(res.runId)!;
  assert.equal(child.run.status, "done", child.run.error ?? "");
  assert.match(git(o.origin, "show", `${child.run.branch}:DEV.md`), /develop only/);
  assert.equal(ghCalls[1][3], "develop");
  assert.match(sdk.prompts[1], /PR 대상 브랜치\(develop\)에서 새 브랜치로/);
});

test("PR 이 머지됐으면 브랜치가 있어도 기본 브랜치에서 새로", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const sdk = fakeSdk((t, cwd) => { if (t.startsWith("다음 변경을")) writeFileSync(join(cwd, "hello.txt"), "hi\n"); else appendFileSync(join(cwd, "README.md"), "x\n"); });
  const { r: first, run: parent } = await parentFix(o, reg, store, { query: sdk.fn });
  const { f, jobs } = ports(o, reg, store, { fixDeps: { query: sdk.fn, worktreesDir: o.wts, sessionExists: async () => true, prState: () => ({ state: "MERGED", url: "https://github.com/x/y/pull/1" }) } });
  const res = f.continueRun(parent.id, "이어서") as any;
  await Promise.all(jobs);
  const child = reg.getRun(res.runId)!;
  assert.equal(child.run.status, "done", child.run.error ?? "");
  assert.notEqual(child.run.branch, first.branch);
  assert.ok(child.events.some((e) => /머지돼서/.test(e.text ?? "")));
});

test("이어서 하기에 고른 모델: 수정 run 은 그 모델로 새 세션(run 기록에도), 대화는 채팅으로 모델을 넘긴다", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const sdk = fakeSdk((t, cwd) => { if (t.startsWith("다음 변경을")) writeFileSync(join(cwd, "hello.txt"), "hi\n"); else appendFileSync(join(cwd, "README.md"), "m\n"); });
  const { run: parent } = await parentFix(o, reg, store, { query: sdk.fn });
  const cfg = { models: { code: "fake", general: "fake-general", light: "fake-light" } };
  assert.equal(sdk.calls[0].model, cfg.models.code);
  const models: (string | undefined)[] = [];
  const { f, jobs } = ports(o, reg, store, {
    fixDeps: { query: sdk.fn, worktreesDir: o.wts, sessionExists: async () => true, prState: () => undefined },
    chat: (_t, m) => { models.push(m); return "chat-m"; },
  });
  const res = f.continueRun(parent.id, "가볍게 하나 더", cfg.models.general) as any;
  assert.equal(reg.summary(res.runId)!.model, cfg.models.general);
  await Promise.all(jobs);
  assert.equal(reg.getRun(res.runId)!.run.status, "done");
  assert.equal(sdk.calls[1].model, cfg.models.general);
  const b = reg.startRun({ kind: "briefing", title: "브리핑" }); b.end("done");
  f.continueRun(b.id, "물어볼게", cfg.models.light);
  f.continueRun(b.id, "기본으로");
  assert.deepEqual(models, [cfg.models.light, undefined]);
});

test("이어서 하기 검증: 없는 run 404, 돌고 있는 수정 run 409, 빈 말 400, 레포 모름 409", () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const { f } = ports(o, reg, store);
  assert.equal((f.continueRun("nope", "x") as any).status, 404);
  const r = reg.startRun({ kind: "fix", title: "돌고 있음", control: { send: () => {} } });
  assert.equal((f.continueRun(r.id, "x") as any).status, 409);
  assert.equal((f.continueRun(r.id, "  ") as any).status, 400);
  const old = reg.startRun({ kind: "fix", title: "옛 기록" }); old.end("done");
  assert.equal((f.continueRun(old.id, "x") as any).status, 409);
});

test("그 밖의 run → 대화로 이어가기: 맥락 붙여 채팅, 채팅 run 은 앞선 run 에 연결, 답은 앞선 run 기록에", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const b = reg.startRun({ kind: "briefing", title: "정기 브리핑" });
  b.log({ type: "assistant", text: "오늘 회의 3개, 답장 필요한 메일 1개." });
  b.end("done");
  let chatRun = "";
  const { f, chats } = ports(o, reg, store, {
    chat: (t) => {
      chats.push(t);
      // 실제 Chat 처럼 큐를 거쳐 나중에 run 을 시작 → AsyncLocalStorage 로 부모가 따라온다
      Promise.resolve().then(() => setTimeout(() => { const c = reg.startRun({ kind: "chat", title: "채팅" }); chatRun = c.id; c.end("done"); }, 5));
      return "chat-1";
    },
  });
  const res = f.continueRun(b.id, "메일은 누구한테 온 거야?") as any;
  assert.equal(res.mode, "chat");
  assert.equal(res.chatId, "chat-1");
  assert.match(chats[0], /^\[작업 세션 이어서 — 브리핑 "정기 브리핑"\]\n메일은 누구한테 온 거야\?/);
  assert.match(chats[0], /오늘 회의 3개/);
  await until(() => !!chatRun);
  assert.equal(reg.summary(chatRun)!.parentId, b.id);
  assert.equal(reg.summary(chatRun)!.routine, false);
  f.onChatEvent({ chatId: "chat-1", status: "step" });
  f.onChatEvent({ chatId: "chat-1", status: "done", text: "김OO 님이 보냈어요" });
  f.onChatEvent({ chatId: "chat-1", status: "done", text: "중복" }); // 한 번만
  const ev = reg.getRun(b.id)!.events;
  assert.ok(ev.some((e) => e.type === "user" && e.followUp && e.injected && e.text === "메일은 누구한테 온 거야?"));
  assert.deepEqual(ev.filter((e) => e.type === "assistant" && e.followUp).map((e) => e.text), ["김OO 님이 보냈어요"]);
  assert.equal(finalOutput(ev), "오늘 회의 3개, 답장 필요한 메일 1개."); // 이어서 한 답은 '결과'가 아님
});

test("새 작업: 레포 + 지시 → 명시 요청 제안(승인 대기), 허용 밖 400 · 레포 목록", async () => {
  const o = setupRepo();
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const store = new Store(":memory:");
  const { f, proposed } = ports(o, reg, store);
  const r = await f.newTask(o.app, "README에 설치 방법 추가\n자세히는 npm i 부터");
  assert.equal(r.ok, true);
  assert.deepEqual(proposed[0], { repo: o.app, title: "README에 설치 방법 추가", plan: "README에 설치 방법 추가\n자세히는 npm i 부터" });
  assert.equal((r as any).proposal.status, "pending");
  assert.equal(((await f.newTask("/etc", "x")) as any).status, 400);
  assert.equal(((await f.newTask(o.app, " ")) as any).status, 400);
  assert.deepEqual(f.repos().map((x) => x.name).sort(), ["app", "seed"]);
});

test("정기 작업 표시: asRoutine 안(타이머 뒤 포함)에서 시작한 run 은 routine, 바깥은 아님, 맥락은 섞이지 않음", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let a = "", b = "";
  asRoutine(() => { setTimeout(() => { a = reg.startRun({ kind: "briefing", title: "정기 브리핑" }).id; }, 1); })();
  b = reg.startRun({ kind: "briefing", title: "지금 브리핑" }).id;
  await until(() => !!a);
  assert.equal(reg.summary(a)!.routine, true);
  assert.equal(reg.summary(b)!.routine, false);
  const p = reg.startRun({ kind: "briefing", title: "부모" });
  const c = inRunContext({ parentId: p.id }, () => reg.startRun({ kind: "chat", title: "자식" }));
  assert.equal(reg.summary(c.id)!.parentId, p.id);
  assert.equal(inRunContext({ parentId: "없는-run" }, () => reg.startRun({ kind: "chat", title: "x" })).id && reg.listRuns()[0].parentId, undefined);
});

test("summarizeRun: 첫 요청·주입·수정 파일·결과, 길면 뒤쪽을 남긴다 · followUpChatText", () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const r = reg.startRun({ kind: "fix", title: "버튼", branch: "cy/b", prUrl: "https://x/pull/1" });
  r.log({ type: "user", text: "버튼을 파랗게" });
  for (let i = 0; i < 200; i++) r.log({ type: "assistant", text: `단계 ${i}` });
  r.log({ type: "tool_use", name: "Edit", diff: [{ file: "a.css", old: "", new: "x" }] });
  r.log({ type: "user", text: "더 진하게", injected: true });
  r.log({ type: "result", text: "완료" });
  r.end("done");
  const g = reg.getRun(r.id)!;
  const s = summarizeRun(g.run, g.events, 1500);
  assert.ok(s.length <= 1500);
  assert.match(s, /제목: 버튼/);
  assert.match(s, /브랜치: cy\/b/);
  assert.match(s, /처음 요청:\n버튼을 파랗게/);
  assert.match(s, /앞부분 생략/);
  assert.match(s, /수정: a\.css/);
  assert.match(s, /사용자: 더 진하게/);
  assert.match(s, /결과: 완료/);
  assert.match(followUpChatText(g.run, "", "왜?"), /남긴 결과가 없어요/);
});

test("라우트: POST /runs/:id/continue · POST /proposals · GET /repos — CSRF 403, 입력 400, 결과 상태 코드", async () => {
  const bus = new Bus();
  const got: any[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    runContinue: (id, text) => { got.push([id, text]); return id === "gone" ? { ok: false, status: 404, error: "no such run" } : { ok: true, mode: "fix", runId: "r2" }; },
    newTask: async (repo, text) => (repo === "/etc" ? { ok: false, status: 400, error: "nope" } : { ok: true, proposal: { id: "p1", repo, title: text, status: "pending" } }),
    repos: () => [{ path: "/r/app", name: "app" }],
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/runs/r1/continue", { text: "x" }, {})).status, 403);
    assert.equal((await post("/runs/r1/continue", { text: "x" }, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/runs/r1/continue", { text: " " })).status, 400);
    const ok = await post("/runs/r1/continue", { text: " 이어서 " });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { ok: true, mode: "fix", runId: "r2" });
    assert.deepEqual(got[0], ["r1", "이어서"]);
    assert.equal((await post("/runs/gone/continue", { text: "x" })).status, 404);
    assert.equal((await post("/proposals", { repo: "/r/app", text: "x" }, {})).status, 403);
    assert.equal((await post("/proposals", { repo: "", text: "x" })).status, 400);
    assert.equal((await post("/proposals", { repo: "/r/app" })).status, 400);
    assert.equal((await post("/proposals", { repo: "/etc", text: "x" })).status, 400);
    const np = await post("/proposals", { repo: "/r/app", text: "README" });
    assert.equal(np.status, 201);
    assert.equal((await np.json()).proposal.id, "p1");
    assert.deepEqual(await (await fetch(`${base}/repos`)).json(), { repos: [{ path: "/r/app", name: "app" }] });
  } finally { bus.close(); }
  // 핸들러가 없으면 503
  const bare = new Bus();
  await bare.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  const b2 = `http://127.0.0.1:${(bare.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${b2}/runs/r1/continue`, { method: "POST", headers: { "x-cy-agent": "1" }, body: JSON.stringify({ text: "x" }) })).status, 503);
    assert.equal((await fetch(`${b2}/repos`)).status, 503);
  } finally { bare.close(); }
});
