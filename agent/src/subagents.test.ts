// 서브에이전트: Agent 호출 다듬기(포그라운드·isolation remote 금지·내장 종류만) + 서브에이전트 안 도구 호출도 같은 훅·canUseTool 판정.
// 진짜 SDK 는 부르지 않는다 — SDK 가 서브에이전트 도구 호출에 붙이는 표시(훅 입력 agent_id, canUseTool agentID)를 흉내 낸
// 입력으로 우리 훅·승인 브로커를 직접 부른다(SDK 보장: sdk.d.ts BaseHookInput.agent_id · CanUseTool options agentID).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentCall, SUBAGENT_TYPES, subagentEnv } from "./subagents.ts";
import { PermissionBroker, PermissionRules, type PermQueue } from "./permissions.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { toolOptions } from "./brain.ts";
import { fixSubagentHook, noShipHook } from "./fixer.ts";

const root = mkdtempSync(join(tmpdir(), "cy-sub-"));
const repo = join(root, "ax", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
const cfg = () => ({ ...loadConfig(), repoRoots: [join(root, "ax")], claudeProjectsDir: "/none", codexSessionsDir: "/none", localAutoAllow: false });
const sig = { signal: new AbortController().signal };
const pre = (tool_name: string, tool_input: unknown, agent_id?: string) =>
  ({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s", transcript_path: "/x", cwd: repo, tool_use_id: "tu", ...(agent_id ? { agent_id, agent_type: "general-purpose" } : {}) }) as any;
const decision = (o: any) => o?.hookSpecificOutput?.permissionDecision;

function rig() {
  const asked: any[] = [];
  const queue: PermQueue = {
    requestPermission(req) {
      asked.push(req);
      return { action: {} as any, decision: Promise.resolve({ behavior: "allow" } as any) };
    },
  };
  const broker = new PermissionBroker(new PermissionRules(new Store(":memory:")), queue);
  const t = toolOptions(cfg() as any, { interactive: { origin: { via: "chat", threadId: "t1" }, broker }, code: { roots: [join(root, "ax")], cwd: repo } });
  return { asked, broker, t };
}

test("subagentCall: 백그라운드는 포그라운드로, isolation worktree 는 데몬이 받고 remote·사용자 정의 종류는 거부", () => {
  const ok = subagentCall({ description: "찾기", prompt: "p", subagent_type: "Explore", run_in_background: true });
  assert.ok(ok.allow);
  assert.equal((ok as any).input.run_in_background, false);
  assert.equal((ok as any).input.prompt, "p");
  const plain = subagentCall({ description: "d", prompt: "p" });
  assert.ok(plain.allow && plain.input.run_in_background === false);
  for (const t of SUBAGENT_TYPES) assert.ok(subagentCall({ description: "d", prompt: "p", subagent_type: t }).allow, t);
  const wt = subagentCall({ description: "d", prompt: "p", isolation: "worktree" });
  assert.ok(wt.allow && wt.worktree && wt.input.isolation === undefined); // 데몬이 워크트리를 판다(agent-worktrees.ts)
  assert.equal(subagentCall({ description: "d", prompt: "p", isolation: "remote" }).allow, false);
  const custom = subagentCall({ description: "d", prompt: "p", subagent_type: "my-yolo-agent" });
  assert.equal(custom.allow, false);
  assert.match((custom as any).reason, /my-yolo-agent/);
  assert.equal(subagentEnv({ PATH: "/bin" }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(subagentEnv({ PATH: "/bin" }).PATH, "/bin");
});

test("대화형 채팅: Agent 는 묻지 않고 허용(입력 고침), 서브에이전트 안 호출도 하드 차단·승인 카드 그대로", async () => {
  const { t, asked } = rig();
  assert.ok(!t.disallowedTools.includes("Agent"));
  // Agent 호출 자체: allow + 포그라운드로 고친 입력
  const a = await t.hook(pre("Agent", { description: "조사", prompt: "p" }), "tu", sig) as any;
  assert.equal(decision(a), "allow");
  assert.equal(a.hookSpecificOutput.updatedInput.run_in_background, false);
  assert.equal(decision(await t.hook(pre("Task", { description: "d", prompt: "p", isolation: "worktree" }), "tu", sig)), "deny");
  // 서브에이전트 안(agent_id 있음): 하드 차단은 그대로 deny
  assert.equal(decision(await t.hook(pre("Bash", { command: "git push origin main" }, "agent-1"), "tu", sig)), "deny");
  assert.equal(decision(await t.hook(pre("Read", { file_path: join(repo, ".env") }, "agent-1"), "tu", sig)), "deny");
  // 쓰기는 ask → canUseTool(agentID 와 함께 옴)이 승인 카드
  assert.equal(decision(await t.hook(pre("Write", { file_path: join(repo, "a.txt"), content: "x" }, "agent-1"), "tu", sig)), "ask");
  const d = (await t.canUseTool!("Write", { file_path: join(repo, "a.txt"), content: "x" }, { ...sig, toolUseID: "tu", agentID: "agent-1", requestId: "r" } as any)) as any;
  assert.equal(d.behavior, "allow");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolName, "Write");
  const hd = (await t.canUseTool!("Bash", { command: "git -C x commit -m y" }, { ...sig, toolUseID: "tu2", agentID: "agent-1", requestId: "r2" } as any)) as any;
  assert.equal(hd.behavior, "deny");
  assert.equal(asked.length, 1); // 하드 차단은 카드 없이
  // canUseTool 로 온 Agent 도 같은 판정(포그라운드)
  const ag = (await t.canUseTool!("Agent", { description: "d", prompt: "p", run_in_background: true }, { ...sig, toolUseID: "tu3", requestId: "r3" } as any)) as any;
  assert.equal(ag.behavior, "allow");
  assert.equal((ag as any).updatedInput.run_in_background, false);
});

test("정기·읽기 전용 run 은 서브에이전트를 그대로 막는다", async () => {
  const t = toolOptions(cfg() as any, {});
  assert.ok(t.disallowedTools.includes("Agent"));
  assert.equal(t.subagents, false);
  assert.equal(decision(await t.hook(pre("Agent", { description: "d", prompt: "p" }), "tu", sig)), "deny");
});

test("수정 run: noShipHook 은 서브에이전트 안 git commit·push 도 막고, 서브에이전트 가드는 포그라운드·WebFetch 차단", async () => {
  for (const c of ["git commit -m x", "git push origin HEAD", "gh pr create --fill", "git merge main"]) {
    assert.equal(decision(await noShipHook(pre("Bash", { command: c }, "agent-7"), "tu", sig)), "deny", c);
    assert.equal(decision(await noShipHook(pre("Bash", { command: c }), "tu", sig)), "deny", c);
  }
  assert.deepEqual(await noShipHook(pre("Bash", { command: "npm test" }, "agent-7"), "tu", sig), {});
  const a = await fixSubagentHook(pre("Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" }), "tu", sig) as any;
  assert.equal(decision(a), "allow");
  assert.equal(a.hookSpecificOutput.updatedInput.run_in_background, false);
  assert.equal(decision(await fixSubagentHook(pre("Agent", { description: "d", prompt: "p", isolation: "remote" }), "tu", sig)), "deny");
  assert.equal(decision(await fixSubagentHook(pre("WebFetch", { url: "https://x" }, "agent-7"), "tu", sig)), "deny");
  assert.deepEqual(await fixSubagentHook(pre("Edit", { file_path: "a" }, "agent-7"), "tu", sig), {});
});
