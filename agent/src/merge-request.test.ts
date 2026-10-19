// 채팅에서 시킨 PR 머지 → 머지 승인 카드: 막힌 gh pr merge 도 카드로 · 카드 상태(검사·충돌·리뷰) · ✓ 는 한 번만 머지 ·
// ✗ 는 아무것도 안 함 · 캐릭터 말풍선과 같은 결정(어느 쪽에서 눌러도 다른 쪽이 따라감). 진짜 gh 는 부르지 않는다(가짜 prStatus·mergePr)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent } from "./core.ts";
import { loadConfig } from "./config.ts";
import { RunRegistry } from "./runs.ts";
import { Reactions } from "./reactions.ts";
import { MERGE_CARD_LINE, CHAT_SYSTEM } from "./chat.ts";
import { GH_MERGE_WHY, hardDeny } from "./permissions.ts";
import { actionStatusLine } from "./actions.ts";
import {
  MERGE_TYPE, checksLine, mergeAttempt, mergeBlock, mergeCard, mergeIdFor, mergeQuestion, parsePrRef, parsePrView, summarizeChecks, type PrStatus,
} from "./merge-request.ts";

const URL268 = "https://github.com/acme/speaker/pull/268";
const ok268 = (o: Partial<PrStatus> = {}): PrStatus => ({
  url: URL268, number: 268, repo: "acme/speaker", title: "스피커 dev 설정", state: "OPEN",
  base: "develop", head: "cy/feat-speaker-dev-1c7c7a", draft: false, mergeable: "MERGEABLE", review: "",
  checks: { pass: 3, pending: 0, fail: 0, failing: [] }, ...o,
});

// ── 순수 로직 ──

test("PR 표기: 링크·owner/repo#N·#N(+레포)·이상한 것", () => {
  assert.deepEqual(parsePrRef(`${URL268}/files`), { url: URL268, repo: "acme/speaker", number: 268 });
  assert.deepEqual(parsePrRef("acme/speaker#268"), { repo: "acme/speaker", number: 268 });
  assert.deepEqual(parsePrRef("#268", "acme/speaker"), { repo: "acme/speaker", number: 268 });
  assert.deepEqual(parsePrRef("268", "/Users/me/code/speaker"), { number: 268 });
  assert.equal(parsePrRef("https://evil.example/pull/1"), null);
  assert.equal(parsePrRef("머지해줘"), null);
  assert.equal(parsePrRef("#0"), null);
});

test("검사 요약: CheckRun·StatusContext 섞여도 통과·대기·실패를 센다", () => {
  const c = summarizeChecks([
    { __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "android release apk", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", context: "jest", state: "FAILURE" },
    { __typename: "StatusContext", context: "deploy", state: "PENDING" },
  ]);
  assert.deepEqual(c, { pass: 2, pending: 2, fail: 1, failing: ["jest"] });
  assert.equal(checksLine(c), "검사 1개 실패");
  assert.equal(checksLine({ pass: 3, pending: 1, fail: 0, failing: [] }), "검사 1개 대기 중");
  assert.equal(checksLine({ pass: 0, pending: 0, fail: 0, failing: [] }), "검사 없음");
  const v = parsePrView(JSON.stringify({ number: 268, title: "t", url: URL268, state: "OPEN", baseRefName: "develop", headRefName: "h", isDraft: false, mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [] }));
  assert.equal(v.mergeable, "CONFLICTING");
  assert.equal(v.review, "APPROVED");
});

test("✓ 를 막는 이유: 실패한 검사·충돌·초안·닫힘. 대기 중 검사는 막지 않는다", () => {
  assert.equal(mergeBlock(ok268()), undefined);
  assert.equal(mergeBlock(ok268({ checks: { pass: 2, pending: 1, fail: 0, failing: [] } })), undefined);
  assert.match(mergeBlock(ok268({ checks: { pass: 2, pending: 0, fail: 1, failing: ["jest"] } }))!, /검사 1개 실패\(jest\)/);
  assert.match(mergeBlock(ok268({ mergeable: "CONFLICTING" }))!, /충돌/);
  assert.match(mergeBlock(ok268({ draft: true }))!, /초안/);
  assert.match(mergeBlock(ok268({ state: "MERGED" }))!, /이미 머지/);
});

test("카드·말풍선 글: base←head · 검사 · 충돌 · 리뷰, 막히면 그 이유", () => {
  const s = ok268({ checks: { pass: 3, pending: 1, fail: 0, failing: [] } });
  const { url: _u, state: _s, title: _t, ...info } = s;
  assert.equal(mergeQuestion(info), "#268 머지할까요? 검사 1개 대기 중·충돌 없음");
  const card = mergeCard(s.title, s.url, info);
  assert.equal(card.icon, "🔀");
  assert.equal(card.title, "#268 스피커 dev 설정");
  assert.deepEqual(card.fields!.map((f) => f.label), ["레포", "대상", "검사", "충돌", "리뷰"]);
  assert.equal(card.fields![1].value, "develop ← cy/feat-speaker-dev-1c7c7a");
  assert.match(card.fields![2].value, /통과 3 · 대기 1 · 실패 0/);
  assert.equal(card.merge!.url, URL268);
  assert.equal(card.merge!.blocked, undefined);
  const bad = mergeCard(s.title, s.url, { ...info, mergeable: "CONFLICTING" }, "충돌이 있어요");
  assert.equal(bad.merge!.blocked, "충돌이 있어요");
  assert.match(bad.question, /머지할 수 없어요/);
  assert.equal(mergeIdFor(s), "pr-acme_speaker-268");
  assert.equal(actionStatusLine({ type: MERGE_TYPE, status: "pending" }), "머지 승인 대기 — [✓ 머지]를 눌러야 머지돼요");
});

test("막힌 gh pr merge 시도에서 PR 꺼내기(-R·링크·cd), 인자 없으면 null", () => {
  assert.deepEqual(mergeAttempt("gh pr merge 268 --squash --delete-branch", "/code/speaker"), { ref: { number: 268 }, cwd: "/code/speaker" });
  assert.deepEqual(mergeAttempt("gh pr merge -R acme/speaker 268 --squash", "/x"), { ref: { repo: "acme/speaker", number: 268 }, cwd: "/x" });
  assert.deepEqual(mergeAttempt(`gh pr merge ${URL268} --squash`, "/x")!.ref, { url: URL268, repo: "acme/speaker", number: 268 });
  const spk = process.platform === "win32" ? "C:\\code\\speaker" : "/code/speaker"; // Windows 절대 경로는 C:\…
  assert.equal(mergeAttempt(`cd ${spk} && gh pr merge 268`, "/brain")!.cwd, spk);
  if (process.platform === "win32") assert.equal(mergeAttempt("cd /c/code/speaker && gh pr merge 268", "/brain")!.cwd, "C:\\code\\speaker"); // Git Bash 모양
  assert.equal(mergeAttempt("gh pr merge --squash", "/x"), null);
  assert.equal(mergeAttempt("gh pr view 268", "/x"), null);
});

test("하드 차단 이유가 다른 데로 보내지 않고 merges 로 카드를 띄우라고 말한다 · 채팅 지시에도", () => {
  const v = hardDeny("Bash", { command: "gh pr merge 268 --squash" }, { roots: [], brainDir: "/b", cwd: "/b" });
  assert.equal(v.allow, false);
  assert.match(v.allow ? "" : v.reason, /merges/);
  assert.match(GH_MERGE_WHY, /GitHub·다른 화면에서 누르라고 안내하지 않는다/);
  assert.match(CHAT_SYSTEM, /merges 에 그 PR 을 넣는다/);
});

// ── 데몬 경로: 채팅 → 카드 + 말풍선, 결정 ──

function setup(o: { status?: (ref: any) => PrStatus; converse?: any; mergePr?: (url: string, headOid?: string) => string; runFix?: any } = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  const sse: any[] = [];
  (bus as any).send = (event: string, data: unknown) => sse.push([event, data]);
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  bus.clear = () => {};
  const merged: string[] = [], looked: any[] = [];
  let status = o.status ?? (() => ok268());
  const root = mkdtempSync(join(tmpdir(), "cy-merge-"));
  const agent = new Agent({ ...loadConfig(), repoRoots: [root], claudeProjectsDir: "/none", codexSessionsDir: "/none" }, store, bus, undefined, {
    git: async () => [], useBroker: false,
    ...(o.converse ? { converse: o.converse } : {}), ...(o.runFix ? { runFix: o.runFix } : {}),
    actions: { runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) },
    prStatus: async (ref) => { looked.push(ref); return status(ref); },
    mergeCommit: async () => "https://github.com/acme/speaker/commit/abc1234",
    mergePr: o.mergePr ?? ((url) => { merged.push(url); return "✓ Squashed and merged"; }),
  });
  const reactions = new Reactions(bus, { logPath: join(root, "reactions.json"), random: () => 0.99 });
  agent.setReactions(reactions);
  return { agent, store, bus, sse, bubbles, merged, looked, root, reactions, setStatus: (f: (ref: any) => PrStatus) => { status = f; } };
}

// 실제 대화처럼: 모델이 gh pr merge 를 시도 → 하드 차단(훅) → 막혔다는 글만 답(merges 없음)
const TRANSCRIPT = "#268 머지를 시도했는데 여기서는 머지가 막혀 있어서 실행되지 않았어요. 머지는 따로 정해진 머지 승인 흐름으로만 할 수 있어요. 👉 GitHub에서 Squash and merge를 눌러 주세요.";
function blockedConverse(s: () => ReturnType<typeof setup>, command = "gh pr merge 268 -R acme/speaker --squash") {
  return async (_c: any, _st: any, _h: any, _t: any, _step: any, _sum: any, _f: any, threadId: string) => {
    const hook = s().agent.broker.hook({ roots: [s().root], brainDir: "/b", cwd: s().root }, { via: "chat", threadId });
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as any, undefined, { signal: new AbortController().signal });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    return { reply_md: TRANSCRIPT, bubble: "막혔어요", show: null, proposals: [], todo_ops: [], rule: null, merges: [] };
  };
}

test("채팅: 막힌 머지 시도 → 글만이 아니라 머지 승인 카드(답 위) + 캐릭터 말풍선, 머지는 안 함", async () => {
  let s!: ReturnType<typeof setup>;
  s = setup({ converse: blockedConverse(() => s) });
  const sent = s.agent.chat("#268 머지해줘") as { threadId: string };
  await s.agent.chatIdle();
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  assert.equal(done.text, MERGE_CARD_LINE); // "GitHub에서 누르세요" 대신
  const cards = done.actions.filter((a: any) => a.type === MERGE_TYPE);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.status, "pending");
  assert.equal(card.threadId, sent.threadId);
  const answer = s.agent.threadMessages(sent.threadId)!.messages.find((m) => m.role === "assistant")!;
  assert.equal(card.msgN, answer.n);
  assert.equal(card.card.merge.number, 268);
  assert.equal(card.card.merge.base, "develop");
  assert.deepEqual(s.looked[0], { repo: "acme/speaker", number: 268 });
  // 캐릭터 말풍선: 그림(merge) + "#268 머지할까요? 검사 통과·충돌 없음" + ✓/✗, 누르면 그 대화
  const b = s.bubbles.filter((x) => x.id === "merge:pr-acme_speaker-268").at(-1);
  assert.equal(b.kind, "proposal");
  assert.equal(b.actions, "merge");
  assert.equal(b.proposalId, "pr-acme_speaker-268");
  assert.equal(b.image, "merge");
  assert.equal(b.text, "#268 머지할까요? 검사 통과·충돌 없음");
  assert.match(b.detail, /acme\/speaker · develop ← cy\/feat-speaker-dev-1c7c7a/);
  assert.deepEqual(b.open, { section: "chat", id: sent.threadId });
  assert.equal(s.bubbles.some((x) => x.actionId === card.id), false); // 확인 카드 말풍선은 따로 안 뜬다(하나만)
  assert.deepEqual(s.merged, []); // 사람이 ✓ 를 누르기 전엔 절대 머지 안 함
});

test("채팅: 모델이 merges 를 넣으면 카드, 답 글은 살리되 카드 안내 한 줄", async () => {
  const s = setup({ converse: async () => ({ reply_md: "확인해 볼게요", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }, { pr: "acme/speaker#268", repo: "" }] }) });
  s.agent.chat("268 머지");
  await s.agent.chatIdle();
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  assert.equal(done.actions.length, 1); // 같은 PR 은 하나
  assert.match(done.text, /^머지 승인 카드를 띄웠어요[\s\S]*확인해 볼게요$/);
});

test("✓ → 머지 한 번(두 화면에서 동시에 눌러도), 카드는 머지 커밋 링크로 접히고 말풍선도 머지 완료", async () => {
  const s = setup({ converse: async () => ({ reply_md: "머지 승인 카드를 띄웠어요", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }] }) });
  const sent = s.agent.chat("머지") as { threadId: string };
  await s.agent.chatIdle();
  const card = s.agent.listActions({ threadId: sent.threadId }).find((a) => a.type === MERGE_TYPE)!;
  const [a, b] = await Promise.all([s.agent.confirmAction(card.id), s.agent.mergeDecide("pr-acme_speaker-268", "merge")]);
  assert.equal(a.ok, true);
  assert.equal((b as any).ok, true);
  assert.deepEqual(s.merged, [URL268]);
  assert.equal(s.looked.length, 2); // 카드 만들 때 + 머지 직전 다시 확인
  const now = s.agent.getAction(card.id)!;
  assert.equal(now.status, "done");
  assert.equal(now.result!.link, "https://github.com/acme/speaker/commit/abc1234");
  assert.ok(s.sse.some(([e, d]) => e === "action" && d.action.id === card.id && d.action.status === "running"));
  const fin = s.bubbles.filter((x) => x.id === "merge:pr-acme_speaker-268").at(-1);
  assert.equal(fin.image, "merge_complete");
  assert.match(fin.detail, /머지 커밋: https:\/\/github.com\/acme\/speaker\/commit\/abc1234/);
  const last = s.agent.threadMessages(sent.threadId)!.messages.at(-1)!;
  assert.equal(last.role, "system");
  assert.match(last.text, /🎉 머지했어요 — #268 스피커 dev 설정 \(머지 커밋 https/);
  // 다시 눌러도 그대로
  const again = await s.agent.confirmAction(card.id);
  assert.equal(again.ok && again.already, true);
  assert.deepEqual(s.merged, [URL268]);
});

test("✗ → 아무것도 머지 안 함, 카드·말풍선 모두 '안 함'", async () => {
  const s = setup({ converse: async () => ({ reply_md: "", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }] }) });
  const sent = s.agent.chat("머지") as { threadId: string };
  await s.agent.chatIdle();
  const card = s.agent.listActions({ threadId: sent.threadId })[0];
  const r = s.agent.cancelAction(card.id);
  assert.equal(r.ok, true);
  assert.equal(s.agent.getAction(card.id)!.status, "cancelled");
  assert.match(s.bubbles.at(-1).text, /머지는 안 할게요/);
  assert.equal(s.bubbles.at(-1).actions, undefined);
  assert.equal((await s.agent.confirmAction(card.id)).ok, false); // 안 함 뒤 ✓ 는 409
  assert.equal((await s.agent.mergeDecide("pr-acme_speaker-268", "merge") as any).ok, false);
  assert.deepEqual(s.merged, []);
});

test("캐릭터 말풍선에서 결정 → 채팅 카드가 따라간다(✗ 도, ✓ 도)", async () => {
  const s = setup({ converse: async () => ({ reply_md: "", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }] }) });
  const sent = s.agent.chat("머지") as { threadId: string };
  await s.agent.chatIdle();
  const card = s.agent.listActions({ threadId: sent.threadId })[0];
  await s.agent.mergeDecide("pr-acme_speaker-268", "decline"); // 오버레이 ✗
  assert.equal(s.agent.getAction(card.id)!.status, "cancelled");
  assert.ok(s.sse.some(([e, d]) => e === "action" && d.action.id === card.id && d.action.status === "cancelled"));
  // 다시 머지해 달라고 하면 새 카드로 다시 묻는다(안 함 → 다시)
  s.agent.chat("아니다 머지해줘", { threadId: sent.threadId });
  await s.agent.chatIdle();
  const card2 = s.agent.listActions({ threadId: sent.threadId }).find((a) => a.status === "pending")!;
  assert.ok(card2 && card2.id !== card.id);
  await s.agent.mergeDecide("pr-acme_speaker-268", "merge"); // 오버레이 ✓
  assert.equal(s.agent.getAction(card2.id)!.status, "done");
  assert.equal(s.agent.getAction(card.id)!.status, "cancelled"); // 끝난 카드는 그대로
  assert.deepEqual(s.merged, [URL268]);
});

test("실패한 검사·충돌이면 ✓ 막힘: 카드·말풍선에 이유, 눌러도(어디서든) 머지 안 함", async () => {
  const s = setup({
    status: () => ok268({ checks: { pass: 2, pending: 1, fail: 1, failing: ["jest"] } }),
    converse: async () => ({ reply_md: "", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }] }),
  });
  const sent = s.agent.chat("머지") as { threadId: string };
  await s.agent.chatIdle();
  const card = s.agent.listActions({ threadId: sent.threadId })[0];
  assert.match(card.card.merge!.blocked!, /검사 1개 실패\(jest\)/);
  const b = s.bubbles.filter((x) => x.id === "merge:pr-acme_speaker-268").at(-1);
  assert.equal(b.text, "#268 머지할 수 없어요 — 검사 1개 실패·충돌 없음");
  assert.match(b.blocked, /jest/);
  const r = await s.agent.confirmAction(card.id);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 409);
  assert.equal((await s.agent.mergeDecide("pr-acme_speaker-268", "merge") as any).status, 409);
  assert.equal(s.agent.getAction(card.id)!.status, "pending");
  assert.deepEqual(s.merged, []);
});

test("카드 뒤 검사가 깨지면: ✓ 를 눌러도 머지 직전 다시 확인해서 실패로(머지 안 함), 말풍선은 다시 묻는다", async () => {
  const s = setup({ converse: async () => ({ reply_md: "", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }] }) });
  const sent = s.agent.chat("머지") as { threadId: string };
  await s.agent.chatIdle();
  const card = s.agent.listActions({ threadId: sent.threadId })[0];
  s.setStatus(() => ok268({ mergeable: "CONFLICTING" }));
  const r = await s.agent.confirmAction(card.id);
  assert.equal(r.ok, false);
  const now = s.agent.getAction(card.id)!;
  assert.equal(now.status, "failed");
  assert.match(now.result!.message, /머지 실패: 충돌이 있어요/);
  assert.deepEqual(s.merged, []);
  assert.match(s.bubbles.at(-1).text, /머지에 실패했어요 \(충돌이 있어요/);
  assert.equal(s.bubbles.at(-1).actions, "merge");
});

test("이미 머지된·못 찾은·레포 모를 PR: 카드 없이 이유", async () => {
  const s = setup({
    status: (ref) => { if (ref.number === 404) throw new Error("no pull requests found"); return ok268({ state: "MERGED" }); },
    converse: async () => ({ reply_md: "봤어요", bubble: "", show: null, proposals: [], todo_ops: [], rule: null, merges: [{ pr: URL268, repo: "" }, { pr: "acme/speaker#404", repo: "" }, { pr: "#5", repo: "" }] }),
  });
  s.agent.chat("머지");
  await s.agent.chatIdle();
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  assert.equal(done.actions, undefined);
  assert.match(done.text, /⚠️ #268 은\(는\) 이미 머지된 PR이에요/);
  assert.match(done.text, /⚠️ acme\/speaker#404 PR 을 읽지 못했어요: no pull requests found/);
  assert.match(done.text, /⚠️ #5 이\(가\) 어느 레포의 PR 인지 몰라요/);
});

test("레포 안에서 번호만으로 막힌 시도(cwd): 그 레포 폴더로 PR 을 찾는다", async () => {
  let s!: ReturnType<typeof setup>;
  s = setup({ converse: blockedConverse(() => s, "gh pr merge 268 --squash") });
  s.agent.chat("머지해줘");
  await s.agent.chatIdle();
  assert.deepEqual(s.looked[0], { number: 268 });
  assert.equal(s.agent.listActions().filter((a) => a.type === MERGE_TYPE).length, 1);
});

test("채팅에서 시킨 수정 작업이 PR 까지 가면 그 대화에 답 한 줄 + 머지 승인 카드", async () => {
  let s!: ReturnType<typeof setup>;
  s = setup({
    converse: async () => ({ reply_md: "작업 시작했어요", bubble: "", show: null, proposals: [{ repo: s.root, title: "다크모드", plan: "토글" }], todo_ops: [], rule: null, merges: [] }),
    runFix: async () => ({ ok: true, summary: "바꿈", prUrl: URL268, branch: "cy/b", log: [] }),
  });
  execFileSync("git", ["init", "-q", s.root]); // 수정 run 은 레포 안에서만(진짜 수정은 가짜 runFix)
  const sent = s.agent.chat("다크모드 넣어줘") as { threadId: string };
  await s.agent.chatIdle();
  await s.agent.fixIdle();
  const cards = s.agent.listActions({ threadId: sent.threadId }).filter((a) => a.type === MERGE_TYPE);
  assert.equal(cards.length, 1);
  const msgs = s.agent.threadMessages(sent.threadId)!.messages;
  const line = msgs.find((m) => /PR을 올렸어요 — 머지 승인 카드를 띄웠어요/.test(m.text))!;
  assert.equal(cards[0].msgN, line.n);
  const bub = s.bubbles.filter((b) => b.actions === "merge").at(-1);
  assert.equal(bub.text, "#268 머지할까요? 검사 통과·충돌 없음");
  // 머지 기록은 제안 id 하나(말풍선 ✓ 와 카드 ✓ 가 같은 것)
  assert.equal(bub.proposalId, JSON.parse((s.store.db.prepare("SELECT payload FROM pending_actions WHERE id = ?").get(cards[0].id) as any).payload).mergeId);
  assert.deepEqual(s.merged, []);
});


test("승인한 커밋만 머지: 그 뒤 새 커밋·대상 브랜치가 바뀌면 머지 안 하고, 머지에는 승인한 SHA 를 넘긴다", async () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  assert.equal(parsePrView(JSON.stringify({ number: 268, title: "t", url: URL268, state: "OPEN", baseRefName: "develop", headRefName: "h", headRefOid: A, statusCheckRollup: [] })).headOid, A);
  assert.equal(parsePrView(JSON.stringify({ number: 268, title: "t", url: URL268, state: "OPEN", headRefOid: "not-a-sha" })).headOid, undefined);
  for (const changed of [{ headOid: B }, { base: "main" }]) {
    const s = setup({ status: () => ok268({ headOid: A }) });
    assert.ok((await s.agent.requestMerge({ pr: URL268 }, { via: "chat" })).action);
    s.setStatus(() => ok268({ headOid: A, ...changed }));
    const r = await s.agent.mergeDecide("pr-acme_speaker-268", "merge");
    assert.equal(r.ok, false);
    assert.match((r as any).error, /새 커밋|대상 브랜치/);
    assert.deepEqual(s.merged, []);
  }
  let pinned: string | undefined;
  const s = setup({ status: () => ok268({ headOid: A }), mergePr: (_u, sha) => { pinned = sha; return "merged"; } });
  await s.agent.requestMerge({ pr: URL268 }, { via: "chat" });
  assert.equal((await s.agent.mergeDecide("pr-acme_speaker-268", "merge")).ok, true);
  assert.equal(pinned, A);
});
