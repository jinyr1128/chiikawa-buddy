// 병렬 작업: 수정 run 여러 개가 동시에(같은 레포 git 참조 변경만 줄 세움), 한 세션의 워크트리 격리 서브에이전트 여럿,
// 체크아웃마다의 쓰기 잠금, 채팅 한 답의 여러 제안 → 수정 run 전부 바로 시작.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runFix, userShellArgs } from "./fixer.ts";
import { RunRegistry, trackQuery, usageTokens } from "./runs.ts";
import { threadWorktrees } from "./thread-agents.ts";
import { gitKey, gitMutex } from "./git-mutex.ts";
import { WorktreeIsolation, agentBranch, worktreeSummary } from "./agent-worktrees.ts";
import { PermissionBroker, PermissionRules, type PermQueue, type PermCtx } from "./permissions.ts";
import { RepoLocks } from "./repo-lock.ts";
import { BG_MARK, type BgAgent } from "./bg-agents.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import type { Converse } from "./chat.ts";
import type { Proposal } from "./store.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repoIn(root: string, name: string) {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true }); // Windows 엔 mkdir -p 명령이 없다
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  git(seed, "add", "-A");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: seed });
  git(root, "clone", "-q", "--bare", seed, `${name}.git`);
  git(root, "clone", "-q", join(root, `${name}.git`), name);
  return join(root, name);
}
const until = async (cond: () => boolean, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const author = { name: "Bot", email: "bot@example.com" };
const cfgFor = (root: string) => ({ repoRoots: [root], gitAuthor: author, models: { code: "fake" } }) as unknown as Config;
const proposal = (repo: string, id: string): Proposal => ({ id, repo, title: `작업 ${id}`, plan: "p", status: "approved", created: new Date().toISOString() });
const REPORT = { summary: "s", commit_message: "feat: x", tests_ran: "", tests_passed: true };
const sig = { signal: new AbortController().signal };

// 가짜 SDK: 한 턴 — body(options) 를 돌고 결과
function fakeSdk(body: (o: any) => Promise<void>) {
  return (({ prompt, options }: any) => {
    const buf: any[] = [];
    let wake: (() => void) | undefined, done = false;
    const emit = (m: any) => { buf.push(m); wake?.(); };
    (async () => {
      for await (const _m of prompt as AsyncIterable<any>) {
        emit({ type: "system", subtype: "init", session_id: "s", model: "fake", cwd: options.cwd });
        await body(options);
        emit({ type: "result", subtype: "success", result: "done", structured_output: REPORT });
      }
      done = true; wake?.();
    })();
    return Object.assign((async function* () {
      while (true) { const m = buf.shift(); if (m) { yield m; continue; } if (done) return; await new Promise<void>((r) => { wake = r; }); wake = undefined; }
    })(), { interrupt: async () => {} });
  }) as any;
}

test("수정 run: 같은 레포 둘 + 다른 레포 하나가 동시에 돈다 — 같은 레포 git 참조 변경(fetch·worktree add·push)만 하나씩", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-par-"));
  const a = repoIn(root, "a"), b = repoIn(root, "b");
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inside = 0;
  const sdk = fakeSdk(async (o) => { inside++; await gate; writeFileSync(join(o.cwd, "x.txt"), o.cwd); });
  const runs = [proposal(a, "p1aaaaaaaa"), proposal(a, "p2bbbbbbbb"), proposal(b, "p3cccccccc")].map((p) =>
    runFix(cfgFor(root), p, () => {}, { query: sdk, runs: reg, worktreesDir: join(root, "wts"), gh: async () => "https://github.com/x/y/pull/1" }));
  await until(() => inside === 3); // 셋 다 모델 단계에 들어와 있다(앞 것이 끝나길 기다리지 않음)
  release();
  const rs = await Promise.all(runs);
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.map((r) => r.summary)));
  assert.equal(gitMutex.peak.get(gitKey(a)), 1);
  assert.equal(gitMutex.peak.get(gitKey(b)), 1);
  assert.equal(git(join(root, "a.git"), "branch", "--list", "cy/*").split("\n").length, 2);
});

test("워크트리 격리: 한 세션이 서브에이전트 셋에 워크트리를 하나씩 동시에 판다 — 바뀐 건 커밋해 남기고, 안 바뀐 건 지운다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-iso-"));
  const app = repoIn(root, "app");
  const logs: any[] = [];
  const iso = new WorktreeIsolation({ roots: [root], author, worktreesDir: join(root, "wts"), log: (ev) => logs.push(ev) });
  const prep = await Promise.all(["t1", "t2", "t3"].map((id) => iso.prepare(id, { description: `일 ${id}`, prompt: "고쳐", isolation: "worktree" }, app)));
  assert.ok(prep.every((p) => "input" in p));
  const wts = ["t1", "t2", "t3"].map((id) => iso.list().find((w) => w.label === `일 ${id}`)!);
  assert.equal(new Set(wts.map((w) => w.wt)).size, 3);
  assert.deepEqual(iso.worktrees.sort(), wts.map((w) => w.wt).sort());
  for (const p of prep) assert.match((p as any).input.prompt, /\[워크트리 격리\]/);
  assert.equal((prep[0] as any).input.isolation, undefined);
  assert.equal(wts[0].branch, agentBranch("일 t1", "t1"));
  writeFileSync(join(wts[0].wt, "a.txt"), "a\n");
  writeFileSync(join(wts[1].wt, "b.txt"), "b\n");
  const [n1, n2, n3] = await Promise.all(["t1", "t2", "t3"].map((id) => iso.finish(id)));
  assert.match(n1!, /커밋/);
  assert.match(n2!, /cherry-pick -n/);
  assert.match(n3!, /바뀐 파일이 없어 지웠어요/);
  assert.ok(existsSync(wts[0].wt) && existsSync(wts[1].wt));
  assert.ok(!existsSync(wts[2].wt));
  assert.equal(git(app, "log", "-1", "--format=%an", wts[0].branch), "Bot");
  assert.equal(git(app, "branch", "--list", wts[2].branch), "");
  assert.ok(logs.some((e) => e.worktree === wts[0].wt && e.parent === "t1"));
  assert.equal(iso.worktrees.length, 2);
  assert.equal(gitMutex.peak.get(gitKey(app)), 1);
});

test("쓰기 잠금은 체크아웃마다: 같은 레포라도 워크트리가 다르면 두 run 이 동시에 쓴다, 같은 체크아웃이면 기다린다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-lock-"));
  const app = repoIn(root, "app");
  const iso = new WorktreeIsolation({ roots: [root], author, worktreesDir: join(root, "wts") });
  await iso.prepare("w1", { description: "w1", prompt: "p" }, app);
  await iso.prepare("w2", { description: "w2", prompt: "p" }, app);
  const [w1, w2] = iso.list();
  const locks = new RepoLocks();
  const queue: PermQueue = { requestPermission() { return { action: {} as any, decision: Promise.resolve({ behavior: "allow", always: false } as any) }; } };
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue, undefined, locks);
  const ctx: PermCtx = { roots: [root], brainDir: join(root, "brain"), cwd: app, worktrees: iso.worktrees };
  const pre = (tool: string, input: unknown, id: string) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "/x", cwd: app, tool_use_id: id }) as any;
  const edit = (run: string, file: string) => broker.hook(ctx, { via: "chat", threadId: "t", runId: run })(pre("Edit", { file_path: file, old_string: "a", new_string: "b" }, `e-${run}`), `e-${run}`, sig);
  await Promise.all([edit("r1", join(w1.wt, "README.md")), edit("r2", join(w2.wt, "README.md"))]);
  assert.equal(locks.holder(w1.wt)?.key, "r1");
  assert.equal(locks.holder(w2.wt)?.key, "r2");
  assert.equal(locks.holder(app), undefined);
  // 셸도 `cd <워크트리> && …` 면 그 워크트리
  await broker.hook(ctx, { via: "chat", threadId: "t", runId: "r3" })(pre("Bash", { command: `cd ${app} && npm test` }, "b3"), "b3", sig);
  assert.equal(locks.holder(app)?.key, "r3");
  // 같은 워크트리를 다른 run 이 고치려면 기다린다
  let done = false;
  const wait = edit("r4", join(w1.wt, "x.ts")).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  locks.release("r1");
  await wait;
  assert.equal(locks.holder(w1.wt)?.key, "r4");
  for (const k of ["r2", "r3", "r4"]) locks.release(k);
  await iso.closeAll();
});

test("수정 run 안의 서브에이전트: isolation worktree 로 둘을 동시에 — PreToolUse 가 워크트리를 파고 PostToolUse 가 커밋해 남기거나 지운다", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-fixiso-"));
  const app = repoIn(root, "app");
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const notes: string[] = [];
  const sdk = fakeSdk(async (o) => {
    const preHook = o.hooks.PreToolUse[0].hooks[1];
    const post = o.hooks.PostToolUse[0].hooks[0];
    const call = (id: string) => preHook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: `sub ${id}`, prompt: "p", isolation: "worktree" }, tool_use_id: id, session_id: "s", transcript_path: "/x", cwd: o.cwd }, id, sig);
    const [a, b] = await Promise.all([call("s1"), call("s2")]);
    const wa = String(a.hookSpecificOutput.updatedInput.prompt).match(/워크트리에서 일한다: (\S+)/)![1];
    assert.equal(b.hookSpecificOutput.permissionDecision, "allow");
    assert.ok(o.additionalDirectories?.length);
    writeFileSync(join(wa, "sub.txt"), "sub\n");
    for (const id of ["s1", "s2"]) {
      const r = await post({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {}, tool_response: "", tool_use_id: id, session_id: "s", transcript_path: "/x", cwd: o.cwd }, id, sig);
      notes.push(r.hookSpecificOutput.additionalContext);
    }
    writeFileSync(join(o.cwd, "main.txt"), "m\n");
  });
  const r = await runFix(cfgFor(root), proposal(app, "pfixiso01"), () => {}, { query: sdk, runs: reg, worktreesDir: join(root, "wts"), gh: async () => "https://github.com/x/y/pull/2" });
  assert.equal(r.ok, true, r.summary);
  assert.match(notes[0], /커밋 \w+/);
  assert.match(notes[1], /바뀐 파일이 없어 지웠어요/);
});

test("채팅: 한 답의 제안 셋 → 수정 run 셋이 전부 바로 동시에 시작 · 격리 백그라운드 에이전트는 자기 워크트리에서", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-multi-"));
  const app = repoIn(root, "app"), other = repoIn(root, "other");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started: string[] = [];
  const bgJobs: BgAgent[] = [];
  let bgDone!: (v: string) => void;
  let agent!: Agent;
  const converse: Converse = async (_c, _s, _h, text, _o, _sum, _f, threadId) => {
    if (text.includes("에이전트")) {
      const o = await agent.broker.hook({ roots: [root], brainDir: join(root, "brain"), cwd: app }, { via: "chat", threadId })(
        { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "따로 고치기", prompt: "고쳐", isolation: "worktree" }, tool_use_id: "toolu_iso", session_id: "s", transcript_path: "/x", cwd: app } as any, "toolu_iso", sig);
      assert.ok(String((o as any).hookSpecificOutput.permissionDecisionReason).startsWith(BG_MARK));
      return { reply_md: "시작했어요", bubble: "", show: null, proposals: [] };
    }
    return { reply_md: "작업 시작했어요", bubble: "", show: null, proposals: [
      { repo: app, title: "하나", plan: "1" }, { repo: app, title: "둘", plan: "2" }, { repo: other, title: "셋", plan: "3" },
    ] };
  };
  const bus = new Bus();
  bus.setMood = () => {};
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none"), gitAuthor: author };
  agent = new Agent(cfg, new Store(":memory:"), bus, undefined, {
    converse, git: async () => [], useBroker: false, bgWorktreesDir: join(root, "wts"),
    runFix: async (_c, p) => { started.push(p.title); await gate; return { ok: false, summary: "x", log: [] }; },
    bgRun: (job) => new Promise<string>((res) => { bgJobs.push(job as BgAgent); bgDone = res; }),
  });
  const t0 = agent.chat("세 가지 고쳐줘") as { threadId: string };
  await agent.chatIdle();
  await until(() => started.length === 3);
  assert.deepEqual(started.sort(), ["둘", "셋", "하나"]);
  // 답 끝에 데몬이 실제 워크트리로 「🌿 워크트리 3개 만들었어요」 + 하나씩(제목 — 브랜치)
  const reply0 = agent["store"].threadMessages(t0.threadId).find((m) => m.role === "assistant")!.text;
  const lines = reply0.split("\n");
  const at = lines.indexOf("🌿 워크트리 3개 만들었어요");
  assert.ok(at > 0, reply0);
  assert.deepEqual(lines.slice(at + 1).map((l) => l.replace(/`cy\/[^`]+`/, "B")), ["- 하나 — B", "- 둘 — B", "- 셋 — B"]);
  assert.match(lines[at + 1], /`cy\/change-[0-9a-f]{6}`/);
  release();
  await agent.fixIdle();
  // 격리 백그라운드 에이전트: 워크트리를 파서 그 안에서 돈다, 끝나면 커밋해 남긴 브랜치를 결과에
  const t = agent.chat("에이전트로 따로 고쳐") as { threadId: string };
  await agent.chatIdle();
  await until(() => bgJobs.length === 1);
  const job = agent.bgAgents.get("toolu_iso")!;
  const reply1 = agent["store"].threadMessages(t.threadId).find((m) => m.role === "assistant")!.text;
  assert.match(reply1, new RegExp(`🌿 워크트리 1개 만들었어요\\n- 따로 고치기 — \`${agentBranch("따로 고치기", "toolu_iso")}\``));
  assert.equal(job.worktree!.branch, agentBranch("따로 고치기", "toolu_iso"));
  assert.ok(job.worktree && job.cwd === job.worktree.path && job.worktree.path.startsWith(join(root, "wts")));
  writeFileSync(join(job.worktree!.path, "fix.txt"), "x\n");
  bgDone("고쳤어요");
  await agent.bgAgents.idle();
  const last = agent["store"].threadMessages(t.threadId).at(-1)!.text;
  assert.match(last, /고쳤어요/);
  assert.match(last, new RegExp(`브랜치 ${job.worktree!.branch.replace(/[/.-]/g, "\\$&")} 에 커밋`));
});

test("커밋 전 테스트: 한 번 실패하면 다시 돌리고(불안정), 두 번 실패면 출력 끝 60줄을 세션 기록·실패 글에 — 사용자 셸 환경에서", async () => {
  const root = mkdtempSync(join(tmpdir(), "cy-flaky-"));
  const app = repoIn(root, "app");
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sdk = fakeSdk(async (o) => { writeFileSync(join(o.cwd, "x.txt"), "x\n"); });
  const fail = (n: number) => Object.assign(new Error("exit 1"), { stdout: Array.from({ length: 100 }, (_, i) => `line ${n}-${i}`).join("\n"), stderr: "A worker process has failed to exit gracefully" });
  // 1) 첫 번째만 실패 → 다시 돌려 통과 → 커밋
  let calls = 0;
  const flaky = { label: "unit", cmd: ["npm", "test"], dir: "." };
  const r1 = await runFix(cfgFor(root), proposal(app, "pflaky001"), () => {}, { query: sdk, runs: reg, worktreesDir: join(root, "wts"), gh: async () => "https://github.com/x/y/pull/3",
    testCommands: [flaky], runTest: async () => { if (++calls === 1) throw fail(1); return ""; } });
  assert.equal(r1.ok, true, r1.summary);
  assert.equal(calls, 2);
  assert.ok(reg.getRun(r1.runId!)!.events.some((e) => e.type === "system" && /다시 돌림\(불안정한 실패일 수 있어요\)/.test(e.text ?? "")));
  // 2) 두 번 다 실패 → 실패, 출력 끝이 기록·요약에
  const r2 = await runFix(cfgFor(root), proposal(app, "pflaky002"), () => {}, { query: sdk, runs: reg, worktreesDir: join(root, "wts"),
    testCommands: [flaky], runTest: async () => { throw fail(2); } });
  assert.equal(r2.ok, false);
  assert.match(r2.summary, /두 번 돌려도 실패/);
  assert.match(r2.summary, /line 2-99/);
  assert.match(r2.summary, /failed to exit gracefully/);
  const ev = reg.getRun(r2.runId!)!.events.find((e) => e.type === "system" && /❌ 테스트 실패\(unit\)/.test(e.text ?? ""))!;
  assert.ok(ev);
  assert.match(ev.text!, /line 2-99/);
  assert.doesNotMatch(ev.text!, /line 2-30\n/); // 끝 60줄만
  // 사용자 셸: rc 를 읽고 그 안에서 명령
  const [sh, args] = userShellArgs(["npm", "test"], "/bin/zsh");
  assert.equal(sh, "/bin/zsh");
  assert.equal(args[0], "-lc");
  assert.match(args[1], /\.zshrc/);
  assert.deepEqual(args.slice(2), ["cy-test", "npm", "test"]);
  const [sh2, args2] = userShellArgs(["echo", "hi there"], "/bin/sh");
  if (process.platform !== "win32") assert.equal(execFileSync(sh2, args2, { encoding: "utf8" }).trim(), "hi there"); // Windows 는 testSpawn(plat.test.ts)
});

test("토큰: SDK assistant usage 를 run 에 더하고(같은 message.id 는 한 번), 서브에이전트별로도 — 요약을 다시 보내 실시간으로", async () => {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const run = reg.startRun({ kind: "chat", title: "t" });
  const seen: number[] = [];
  reg.subscribe((u) => { if (u.type === "runs" && u.run.id === run.id && u.run.tokens) seen.push(u.run.tokens); });
  const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 99999 };
  const msgs = [
    { type: "assistant", parent_tool_use_id: null, message: { id: "m1", usage, content: [{ type: "text", text: "a" }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "m1", usage, content: [{ type: "tool_use", id: "tu", name: "Agent", input: {} }] } }, // 같은 응답의 다음 블록
    { type: "assistant", parent_tool_use_id: "tu", message: { id: "m2", usage: { input_tokens: 1000, output_tokens: 234 }, content: [{ type: "text", text: "sub" }] } },
  ];
  for await (const _m of trackQuery(run, (async function* () { yield* msgs; })())) { /* 흘려보냄 */ }
  assert.equal(reg.summary(run.id)!.tokens, 160 + 1234);
  assert.equal(reg.tokensOf(run.id), 1394);
  assert.equal(reg.tokensOf(run.id, "tu"), 1234);
  assert.deepEqual(seen, [160, 1394]);
  assert.equal(usageTokens({ type: "assistant", message: { id: "x", usage: { output_tokens: 7 } } }, new Set()), 7);
  assert.equal(usageTokens({ type: "user" }, new Set()), 0);
});

test("대화 속 워크트리 카드 줄: 수정 run · 격리 백그라운드 · 격리 포그라운드를 시킨 순으로, 토큰은 run(서브에이전트는 그 몫)", () => {
  const list = threadWorktrees({
    fixRuns: [{ id: "r1", title: "하나", status: "running", startedAt: "2026-10-13T10:00:05Z", branch: "cy/hana-1", cwd: "/w/app-1", ref: "p1", tokens: 5000 },
      { id: "r2", title: "이어서", status: "done", startedAt: "2026-10-13T10:00:09Z", parentId: "r1", ref: "p1" }],
    bg: [{ toolUseId: "tu-a", description: "따로", status: "running", queuedAt: "2026-10-13T10:00:02Z", runId: "rb", isolation: "worktree", worktree: { path: "/w/app-a", branch: "cy/agent-a" } },
      { toolUseId: "tu-n", description: "격리 아님", status: "running", queuedAt: "2026-10-13T10:00:02Z" }],
    subs: [{ toolUseId: "tu-s", runId: "rc", title: "서브", branch: "cy/agent-s", path: "/w/app-s", at: "2026-10-13T10:00:03Z", status: "done" }],
    tokensOf: (runId, parent) => (runId === "rb" ? 777 : runId === "rc" && parent === "tu-s" ? 42 : 0),
    askedAt: (pid) => (pid === "p1" ? "2026-10-13T10:00:01Z" : undefined),
  });
  assert.deepEqual(list.map((w) => [w.key, w.kind, w.status, w.tokens, w.branch ?? ""]), [
    ["fix:r1", "fix", "running", 5000, "cy/hana-1"], ["agent:tu-a", "agent", "running", 777, "cy/agent-a"],
    ["sub:tu-s", "sub", "done", 42, "cy/agent-s"], ["fix:r2", "fix", "done", 0, ""],
  ]);
  assert.equal(list[0].askedAt, "2026-10-13T10:00:01Z");
});

test("답 끝 워크트리 줄: 없으면 빈 글, 있으면 「🌿 워크트리 N개 만들었어요」 + 「- 제목 — `브랜치`」", () => {
  assert.equal(worktreeSummary([]), "");
  assert.equal(worktreeSummary([{ title: "a  b", branch: "cy/x" }, { title: "" }]), "🌿 워크트리 2개 만들었어요\n- a b — `cy/x`\n- 작업");
});
