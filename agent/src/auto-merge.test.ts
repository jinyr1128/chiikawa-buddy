// ✓ 없이 머지: 말로 시킨 머지(userSaid + 사용자 말 재확인) · 자동 머지 레포(말·설정 창으로 넣고 빼기, 수정 run PR 자동 머지) ·
// 검사가 안 되면 카드로 · 채팅의 git commit/push 허용 범위(cy 워크트리·cy/ 브랜치, 보호 브랜치·force 는 막힘). 진짜 gh·git 은 부르지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent } from "./core.ts";
import { loadConfig, type Config } from "./config.ts";
import { RunRegistry } from "./runs.ts";
import { Reactions } from "./reactions.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import { Settings, validatePatch } from "./settings.ts";
import { MERGE_TYPE, type PrStatus } from "./merge-request.ts";
import { AUTO_MERGE_SEED, autoMergeConsent, autoMergeList, normSlug, prNumbersIn, readyBlock, saysMerge, textMergeConsent } from "./auto-merge.ts";
import { HARD_DENY, hardDeny, type GitState, type PermCtx } from "./permissions.ts";

const URL282 = "https://github.com/acme/speaker/pull/282";
const pr = (o: Partial<PrStatus> = {}): PrStatus => ({
  url: URL282, number: 282, repo: "acme/speaker", title: "스피커 볼륨", state: "OPEN",
  base: "main", head: "cy/volume-1", draft: false, mergeable: "MERGEABLE", review: "",
  checks: { pass: 3, pending: 0, fail: 0, failing: [] }, ...o,
});
const CY_URL = "https://github.com/example-org/cy-agent/pull/300";
const cyPr = (o: Partial<PrStatus> = {}) => pr({ url: CY_URL, number: 300, repo: "example-org/cy-agent", title: "다크모드", head: "cy/dark-1", ...o });

// ── 순수 로직 ──

test("말로 시킨 머지인가: 머지 동사 · 부정/물음은 아님 · 말에 번호가 있으면 그 번호만 · 「이거」는 하나일 때만", () => {
  for (const t of ["#282 머지해", "이거 머지해", "282번 머지해줘", "PR 282 merge please", "머지해 줄래?", "282 병합해"]) assert.ok(saysMerge(t), t);
  for (const t of ["머지하지 마", "머지는 나중에", "이거 머지해도 될까?", "머지됐어?", "머지 전에 테스트 돌려", "don't merge it", "리뷰해 줘", "머지 상태 어때?"]) assert.ok(!saysMerge(t), t);
  assert.deepEqual(prNumbersIn("#282 랑 /pull/17 그리고 PR 5, 9번"), [282, 17, 5, 9]);
  assert.deepEqual(textMergeConsent("#282 머지해", [{ number: 282, userSaid: true }, { number: 300, userSaid: true }]), [true, false]);
  assert.deepEqual(textMergeConsent("이거 머지해", [{ number: 282, userSaid: true }]), [true]);
  assert.deepEqual(textMergeConsent("이거 머지해", [{ number: 282, userSaid: true }, { number: 283, userSaid: true }]), [false, false]); // 어느 건지 말로 확인 못 함
  assert.deepEqual(textMergeConsent("#282 머지해", [{ number: 282, userSaid: false }]), [false]); // 모델이 표시 안 함
  assert.deepEqual(textMergeConsent("빌드 결과 알려줘", [{ number: 282, userSaid: true }]), [false]); // 모델 생각만
});

test("자동 머지 레포: 말 근거(넣기 = 머지+알아서/자동, 빼기 = 머지+묻고) · owner/name 다듬기 · 씨앗", () => {
  assert.ok(autoMergeConsent("add", "이 프로젝트는 알아서 머지까지 해"));
  assert.ok(autoMergeConsent("add", "speaker 레포는 앞으로 머지해도 돼"));
  assert.ok(!autoMergeConsent("add", "이 프로젝트 테스트 돌려줘"));
  assert.ok(autoMergeConsent("remove", "speaker는 이제 머지 묻고 해"));
  assert.ok(!autoMergeConsent("remove", "speaker 알아서 머지까지 해"));
  assert.equal(normSlug("https://github.com/acme/speaker/pull/3"), "acme/speaker");
  assert.equal(normSlug("git@github.com:acme/speaker.git"), "acme/speaker");
  assert.equal(normSlug("../x"), undefined);
  assert.deepEqual(autoMergeList(undefined), [...AUTO_MERGE_SEED]);
  assert.deepEqual(autoMergeList([]), []);
  assert.deepEqual(autoMergeList(["a/b", "A/B", "bad", 3]), ["a/b"]);
  assert.deepEqual(AUTO_MERGE_SEED, []); // 기본은 비어 있다(사용자가 말·설정 창으로 넣는다)
  assert.deepEqual(loadConfig({}, {}).autoMerge, []);
  assert.equal(readyBlock(pr()), undefined);
  assert.match(readyBlock(pr({ checks: { pass: 1, pending: 2, fail: 0, failing: [] } }))!, /검사 2개가 아직/);
  assert.match(readyBlock(pr({ mergeable: "UNKNOWN" }))!, /GitHub 가 아직/);
  assert.match(readyBlock(pr({ checks: { pass: 1, pending: 0, fail: 1, failing: ["ci"] } }))!, /검사 1개 실패/);
  assert.match(CHAT_SYSTEM, /userSaid: true/);
  assert.match(CHAT_SYSTEM, /auto_merge/);
});

test("설정: autoMerge 검증·저장(config.json 다른 키 그대로)·말로 넣고 빼기(autoMergeOp)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-am-set-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ slackBotToken: "xoxb-keep" }));
  const cfg = { ...loadConfig({}, {}), autoMerge: ["example-org/cy-agent"] } as Config;
  const s = new Settings(cfg, { path, env: {} });
  assert.deepEqual(s.view().autoMerge, ["example-org/cy-agent"]);
  assert.throws(() => validatePatch({ autoMerge: ["not a slug"] }, cfg), /owner\/name/);
  assert.throws(() => validatePatch({ autoMerge: "a/b" }, cfg), /list/);
  const r = s.put({ autoMerge: ["acme/speaker", "https://github.com/acme/speaker", "example-org/cy-agent"] });
  assert.ok(r.ok);
  assert.deepEqual(cfg.autoMerge, ["acme/speaker", "example-org/cy-agent"]);
  let file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.slackBotToken, "xoxb-keep");
  assert.deepEqual(file.autoMerge, ["acme/speaker", "example-org/cy-agent"]);
  const rm = s.autoMergeOp("remove", "ACME/speaker");
  assert.ok(rm.ok && rm.changed);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).autoMerge, ["example-org/cy-agent"]);
  const again = s.autoMergeOp("remove", "acme/speaker");
  assert.ok(again.ok && !again.changed);
  assert.ok(s.put({ autoMerge: [] }).ok); // 빈 목록도 그대로(씨앗으로 안 돌아감)
  file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.autoMerge, []);
  assert.deepEqual(loadConfig({}, file).autoMerge, []);
});

// ── 데몬 경로 ──

type Reply = { reply_md: string; merges?: any[]; auto_merge?: any[]; proposals?: any[] };
function setup(o: { status?: (ref: any) => PrStatus; reply?: (text: string) => Reply; autoMerge?: string[]; runFix?: any } = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  const sse: any[] = [];
  (bus as any).send = (event: string, data: unknown) => sse.push([event, data]);
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  bus.clear = () => {};
  const merged: string[] = [], looked: any[] = [];
  const root = mkdtempSync(join(tmpdir(), "cy-am-"));
  const cfg = { ...loadConfig({}, {}), repoRoots: [root], claudeProjectsDir: "/none", codexSessionsDir: "/none", autoMerge: o.autoMerge ?? [] } as Config;
  const ops: [string, string][] = [];
  const agent = new Agent(cfg, store, bus, undefined, {
    git: async () => [], useBroker: false,
    converse: (async (_c: any, _s: any, _h: any, text: string) => {
      const r = o.reply?.(text) ?? { reply_md: "" };
      return { bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [], auto_merge: [], ...r };
    }) as any,
    ...(o.runFix ? { runFix: o.runFix } : {}),
    actions: { runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) },
    prStatus: async (ref) => { looked.push(ref); return (o.status ?? ((r: any) => (r.repo === "example-org/cy-agent" || r.url === CY_URL ? cyPr() : pr())))(ref); },
    mergeCommit: async (url) => `${url.replace(/\/pull\/\d+$/, "")}/commit/abc1234`,
    mergePr: (url) => { merged.push(url); return "✓ Squashed and merged"; },
    autoMergeOp: (op, slug) => {
      ops.push([op, slug]);
      const cur = cfg.autoMerge ?? [];
      const has = cur.some((x) => x.toLowerCase() === slug.toLowerCase());
      if (op === "add" ? has : !has) return { ok: true, changed: false, list: cur };
      cfg.autoMerge = op === "add" ? [...cur, slug] : cur.filter((x) => x.toLowerCase() !== slug.toLowerCase());
      return { ok: true, changed: true, list: cfg.autoMerge };
    },
    autoMergePoll: { tries: 2, ms: 0 }, sleep: async () => {},
  });
  const reactions = new Reactions(bus, { logPath: join(root, "reactions.json"), random: () => 0.99 });
  agent.setReactions(reactions);
  const done = () => s.sse.filter(([e, d]) => e === "chat" && d.status === "done").at(-1)[1];
  const s = { agent, store, sse, bubbles, merged, looked, root, reactions, cfg, ops, done };
  return s;
}
const mergeCards = (s: ReturnType<typeof setup>) => s.agent.listActions().filter((a) => a.type === MERGE_TYPE);

test("말로 시킨 머지(#282 머지해 + userSaid): 카드 없이 바로 머지, 답에 머지 커밋, 기록에 approved=text", async () => {
  const s = setup({ reply: () => ({ reply_md: "머지할게요", merges: [{ pr: "acme/speaker#282", repo: "", userSaid: true }] }) });
  const sent = s.agent.chat("#282 머지해") as { threadId: string };
  await s.agent.chatIdle();
  assert.deepEqual(s.merged, [URL282]);
  assert.equal(mergeCards(s).length, 0);
  const d = s.done();
  assert.equal(d.actions, undefined);
  assert.match(d.text, /🎉 머지했어요 — #282 스피커 볼륨 \(머지 커밋 https:\/\/github.com\/acme\/speaker\/commit\/abc1234\) · 말씀하신 대로 ✓ 없이 바로/);
  const ans = s.agent.threadMessages(sent.threadId)!.messages.find((m) => m.role === "assistant")!;
  assert.match(ans.text, /머지 커밋/);
  const rec = s.reactions.merge("pr-acme_speaker-282")!;
  assert.equal(rec.state, "merged");
  assert.equal(rec.approved, "text");
  assert.equal(rec.threadId, sent.threadId);
  assert.equal(s.bubbles.filter((b) => b.id === "merge:pr-acme_speaker-282").at(-1).image, "merge_complete");
  assert.equal(s.bubbles.some((b) => b.actions === "merge"), false); // 묻는 말풍선 없음
  assert.equal(s.looked.length, 2); // 읽고 + 머지 직전 다시 확인
});

test("모델 생각만(사용자 말에 머지 없음)·다른 번호·막힌 시도는 userSaid 여도 카드(✓ 필요)", async () => {
  const s = setup({ reply: (t) => ({ reply_md: "", merges: [{ pr: t.includes("#283") ? "acme/speaker#282" : URL282, repo: "", userSaid: true }] }) });
  const a = s.agent.chat("CI 결과 어때?") as { threadId: string };
  await s.agent.chatIdle();
  assert.deepEqual(s.merged, []);
  assert.equal(mergeCards(s).length, 1);
  assert.match(s.done().text, /머지 승인 카드를 띄웠어요/);
  assert.equal(s.reactions.merge("pr-acme_speaker-282")!.state, "asking");
  s.agent.chat("#283 머지해", { threadId: a.threadId }); // 말한 번호와 다른 PR
  await s.agent.chatIdle();
  assert.deepEqual(s.merged, []);
});

test("말로 시켰어도 검사 실패·대기 중이면 바로 머지 안 하고 카드 + 이유", async () => {
  let status = pr({ checks: { pass: 2, pending: 0, fail: 1, failing: ["jest"] } });
  const s = setup({ status: () => status, reply: () => ({ reply_md: "머지할게요", merges: [{ pr: URL282, repo: "", userSaid: true }] }) });
  const sent = s.agent.chat("#282 머지해줘") as { threadId: string };
  await s.agent.chatIdle();
  assert.deepEqual(s.merged, []);
  const d = s.done();
  assert.equal(d.actions.length, 1);
  assert.match(d.text, /⚠️ #282 바로 머지하지 못했어요 — 검사 1개 실패\(jest\)/);
  assert.match(d.actions[0].card.merge.blocked, /jest/);
  // 대기 중 검사: 카드는 ✓ 가능(막히지 않음), 바로 머지는 안 함
  status = pr({ checks: { pass: 2, pending: 1, fail: 0, failing: [] } });
  s.agent.chat("#282 머지해", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.match(s.done().text, /바로 머지하지 못했어요 — 검사 1개가 아직 안 끝났어요/);
  assert.deepEqual(s.merged, []);
  assert.ok(mergeCards(s).some((a) => a.status === "pending" && !a.card.merge!.blocked)); // 새 카드는 ✓ 가능
});

test("자동 머지 레포: 말로 넣기 → 그 레포 채팅 머지 요청은 userSaid 없이도 바로(approved=auto) · 말로 빼기 → 다시 카드", async () => {
  const s = setup({
    reply: (t) => /알아서/.test(t) ? { reply_md: "알겠어요", auto_merge: [{ op: "add", repo: "acme/speaker" }] }
      : /묻고/.test(t) ? { reply_md: "알겠어요", auto_merge: [{ op: "remove", repo: "https://github.com/acme/speaker" }] }
      : /테스트/.test(t) ? { reply_md: "네", auto_merge: [{ op: "add", repo: "acme/other" }] }
      : { reply_md: "", merges: [{ pr: URL282, repo: "", userSaid: false }] },
  });
  const sent = s.agent.chat("이 프로젝트(acme/speaker)는 알아서 머지까지 해") as { threadId: string };
  await s.agent.chatIdle();
  assert.deepEqual(s.cfg.autoMerge, ["acme/speaker"]);
  assert.match(s.done().text, /🤖 acme\/speaker — 이제부터 자동 머지 레포예요/);
  // 사용자 말에 근거 없음 → 안 바뀜
  s.agent.chat("테스트 돌려줘", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.deepEqual(s.cfg.autoMerge, ["acme/speaker"]);
  assert.match(s.done().text, /자동 머지 레포는 바꾸지 않았어요/);
  // 그 레포 PR 머지 요청(모델이 userSaid false) → 자동 머지 레포라 바로
  s.agent.chat("저 PR 상태 봐서 처리해", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.deepEqual(s.merged, [URL282]);
  assert.match(s.done().text, /🤖 자동으로 머지했어요 — #282 .* acme\/speaker 은\(는\) 자동 머지 레포라 ✓ 없이/);
  assert.equal(s.reactions.merge("pr-acme_speaker-282")!.approved, "auto");
  assert.equal(mergeCards(s).length, 0);
  // 빼기
  s.agent.chat("speaker는 이제 머지 묻고 해", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.deepEqual(s.cfg.autoMerge, []);
  assert.match(s.done().text, /이제부터 머지 전에 다시 물어볼게요/);
  assert.deepEqual(s.ops, [["add", "acme/speaker"], ["remove", "acme/speaker"]]);
});

test("수정 run 이 자동 머지 레포에 PR 을 올리면: 검사 끝나길 기다렸다가 ✓ 없이 머지 + 그 대화에 결과(머지 커밋)", async () => {
  let reads = 0;
  let s!: ReturnType<typeof setup>;
  s = setup({
    autoMerge: ["example-org/cy-agent"],
    status: () => cyPr(reads++ === 0 ? { checks: { pass: 1, pending: 1, fail: 0, failing: [] }, mergeable: "UNKNOWN" } : {}),
    reply: () => ({ reply_md: "작업 시작했어요", proposals: [{ repo: s.root, title: "다크모드", plan: "토글" }] }),
    runFix: async () => ({ ok: true, summary: "바꿈", prUrl: CY_URL, branch: "cy/dark-1", log: [] }),
  });
  execFileSync("git", ["init", "-q", s.root]);
  const sent = s.agent.chat("다크모드 넣어줘") as { threadId: string };
  await s.agent.chatIdle();
  await (s.agent as any).queue;
  await s.agent.autoMergeIdle();
  assert.deepEqual(s.merged, [CY_URL]);
  assert.equal(mergeCards(s).length, 0);
  const texts = s.agent.threadMessages(sent.threadId)!.messages.map((m) => m.text);
  assert.ok(texts.some((t) => /자동 머지 레포라 검사가 끝나면 ✓ 없이 머지할게요/.test(t)));
  assert.ok(texts.some((t) => /🤖 자동으로 머지했어요 — #300 다크모드 \(머지 커밋 https:\/\/github.com\/example-org\/cy-agent\/commit\/abc1234\)/.test(t)));
  const p = s.store.db.prepare("SELECT id FROM proposals").get() as any;
  assert.equal(s.reactions.merge(p.id)!.approved, "auto");
});

test("수정 run PR: 자동 머지 레포인데 검사 실패면 머지 안 하고 예전 승인 카드(이유 한 줄) · 레포가 목록 밖이면 카드", async () => {
  let s!: ReturnType<typeof setup>;
  s = setup({
    autoMerge: ["example-org/cy-agent"],
    status: () => cyPr({ checks: { pass: 1, pending: 0, fail: 1, failing: ["test"] } }),
    reply: () => ({ reply_md: "작업 시작했어요", proposals: [{ repo: s.root, title: "다크모드", plan: "토글" }] }),
    runFix: async () => ({ ok: true, summary: "바꿈", prUrl: CY_URL, branch: "cy/dark-1", log: [] }),
  });
  execFileSync("git", ["init", "-q", s.root]);
  const sent = s.agent.chat("다크모드 넣어줘") as { threadId: string };
  await s.agent.chatIdle();
  await (s.agent as any).queue;
  await s.agent.autoMergeIdle();
  assert.deepEqual(s.merged, []);
  assert.equal(mergeCards(s).length, 1);
  assert.ok(s.agent.threadMessages(sent.threadId)!.messages.some((m) => /자동 머지는 못 했어요\(검사 1개 실패\(test\)/.test(m.text)));
});

// ── 채팅의 git commit/push ──

const HOME = "/h";
// Windows(Git Bash): 셸 글의 cd /h/… · git -C /h/… 는 H:\… 로 풀린다 → 같은 상태를 찾게 /h/… 모양으로 되돌려 본다
const unWin = (dir: string) => dir.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const probe = (st: Record<string, GitState>) => (dir: string) => st[dir] ?? (process.platform === "win32" ? st[unWin(dir)] : undefined);
const WT = "/h/.cy-agent/worktrees/app-cy-x";
const CLAUDE_WT = "/h/code/app/.claude/worktrees/agent-1";
const states: Record<string, GitState> = {
  [WT]: { top: WT, branch: "cy/x", defaultBranch: "main", upstream: "origin/cy/x" },
  [CLAUDE_WT]: { top: CLAUDE_WT, branch: "worktree-agent-1", defaultBranch: "main" },
  "/h/code/app": { top: "/h/code/app", branch: "main", defaultBranch: "main", upstream: "origin/main" },
  "/h/code/feat": { top: "/h/code/feat", branch: "cy/feat", defaultBranch: "main" },
  "/h/code/other": { top: "/h/code/other", branch: "feature/z", defaultBranch: "main" },
  "/h/code/trunk": { top: "/h/code/trunk", branch: "cy/t", defaultBranch: "trunk" },
  "/h/code/wt-main": { top: "/h/.cy-agent/worktrees/wt-main", branch: "main", defaultBranch: "main" },
  "/h/code/up": { top: "/h/code/up", branch: "cy/up", defaultBranch: "main", upstream: "origin/develop" },
  "/h/code/adk-eval": { top: "/h/code/adk-eval", branch: "cy/survey", defaultBranch: "main" },
};
const pctx = (cwd: string): PermCtx => ({ roots: ["/h/code"], brainDir: "/h/.cy-agent/brain", cwd, home: HOME, cyHome: "/h/.cy-agent", gitProbe: probe(states) });
const ok = (cwd: string, command: string) => hardDeny("Bash", { command }, pctx(cwd)).allow;

test("채팅 git commit/push: cy 워크트리·cy/ 브랜치에선 됨, 기본·보호 브랜치·force·지우기·워크트리 밖은 막힘", () => {
  for (const c of ["git add -A && git commit -m 'feat: x && y'", "git push", "git push -u origin cy/x", "git push origin HEAD", `git commit -F - <<'EOF'\nfix: git push 문구\nEOF`, "git commit -m \"$(cat <<'EOF'\nfeat: 커밋\nEOF\n)\"", "git merge origin/main"])
    assert.ok(ok(WT, c), c);
  assert.ok(ok(CLAUDE_WT, "git commit -am wip && git push origin worktree-agent-1"));
  assert.ok(ok("/h/code/feat", "git commit -m x && git push origin cy/feat")); // 체크아웃이어도 cy/ 브랜치
  assert.ok(ok("/h/code", `cd ${WT} && git push`)); // cd 로 옮긴 곳
  assert.ok(ok("/h/code", `git -C ${WT} commit -m x`));
  for (const c of ["git push --force", "git push -f origin cy/x", "git push --force-with-lease", "git push origin +cy/x", "git push origin :cy/x", "git push --delete origin cy/x", "git push origin HEAD:main", "git push origin cy/x:develop", "git push --mirror", "git push --all"])
    assert.ok(!ok(WT, c), c);
  assert.ok(!ok("/h/code/app", "git commit -m x")); // 레포 체크아웃의 main
  assert.ok(!ok("/h/code/app", "git push"));
  assert.ok(!ok("/h/code/app", "git merge cy/x")); // main 에 merge
  assert.ok(!ok("/h/code/other", "git commit -m x")); // cy 워크트리도 cy/ 브랜치도 아님
  assert.ok(!ok("/h/code/wt-main", "git commit -m x")); // cy 워크트리여도 main 위
  assert.ok(!ok("/h/code/trunk", "git push origin trunk")); // origin 기본 브랜치
  assert.ok(!ok("/h/code/up", "git push")); // 업스트림이 develop
  assert.ok(!ok("/h/nowhere", "git commit -m x")); // 레포 아님
  assert.ok(!ok(WT, "bash -c 'git push'"));
  assert.ok(!ok(WT, "/bin/sh -c 'git push'"));
  assert.ok(!ok(WT, "eval git push"));
  assert.ok(!ok(WT, "echo x | xargs git commit -m"));
  assert.ok(ok("/h/code", "git -C /h/code/adk-eval commit -m x")); // 레포 이름 속 eval 은 명령이 아님
  assert.ok(ok("/h/code/adk-eval", "git commit -m x && git push -u origin cy/survey"));
  assert.ok(!ok(WT, "echo $(git push)"));
  assert.ok(!ok(WT, "gh pr merge 3 --squash"));
  assert.ok(!ok(WT, "gh api -X PUT repos/o/r/pulls/3/merge"));
  assert.ok(!ok(WT, "cat ~/.cy-agent/config.json")); // 비밀은 그대로
  assert.match((hardDeny("Bash", { command: "git commit -m x" }, pctx("/h/code/app")) as any).reason, /cy\/ 브랜치에서만/);
  assert.match((hardDeny("Bash", { command: "git commit -m x" }, pctx("/h/code/wt-main")) as any).reason, /main 는 기본·보호 브랜치/);
  assert.match((hardDeny("Bash", { command: "git push -f" }, pctx(WT)) as any).reason, /force push/);
  assert.match(HARD_DENY.find((h) => h.id === "git-write")!.what, /cy\/ 브랜치/);
});
