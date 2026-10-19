// 서브에이전트(SDK Agent 도구, 옛 이름 Task) — 대화형 채팅 run·수정 run 에서만 켠다(정기·읽기 전용 run 은 막은 그대로).
//
// 안전: 서브에이전트 안의 도구 호출도 같은 PreToolUse 훅·canUseTool 을 거친다(SDK 보장 —
//   @anthropic-ai/claude-agent-sdk sdk.d.ts `BaseHookInput.agent_id`: "Present only when the hook fires from within a
//   subagent (e.g., a tool called by an AgentTool worker)" · `CanUseTool` options `agentID`: "If running within the context
//   of a sub-agent, the sub-agent's ID"). 그래서 승인 브로커 하드 차단·수정 run 의 noShipHook 은 서브에이전트에도 그대로다.
// 여기서는 Agent 호출 자체만 다듬는다:
//   - SDK 백그라운드 실행 금지(run_in_background 기본값이 true 다): 답·수정 run 이 끝난 뒤에도 돌면 기록·커밋과 엇갈린다 → 늘 false 로.
//     패널·캐릭터 채팅의 서브에이전트는 대신 데몬이 따로 돌린다(bg-agents.ts — 승인 브로커 훅이 넘김, 채팅 답과 같은 권한). 그래야 답이 바로 끝나고
//     다음 말이 기다리지 않는다. 수정 run·할 일 팝오버·Slack DM 은 포그라운드(한 답에 여러 개를 부르면 SDK 가 동시에 돌린다)
//   - isolation: "worktree" 는 데몬이 받는다(agent-worktrees.ts — 서브에이전트마다 새 워크트리, SDK 가 레포 안에 만들지 않게 입력에서 뗀다).
//     isolation: "remote" 는 금지(로컬 밖으로 나간다)
//   - 내장 종류만(general-purpose·Explore·Plan): ~/.claude/agents 의 사용자 정의 에이전트는 permissionMode 를 스스로 바꿀 수 있다
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Task"];
export const isSubagentTool = (name: string) => SUBAGENT_TOOLS.includes(name);
export const SUBAGENT_TYPES: readonly string[] = ["general-purpose", "Explore", "Plan"];

export type SubagentVerdict =
  | { allow: false; reason: string }
  | { allow: true; input: Record<string, unknown>; worktree?: true }; // worktree: isolation "worktree" 를 데몬이 받아 워크트리를 판다

export function subagentCall(input: unknown): SubagentVerdict {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const wt = i.isolation === "worktree";
  if (!wt && i.isolation !== undefined && i.isolation !== null && i.isolation !== "")
    return { allow: false, reason: `서브에이전트 isolation(${String(i.isolation)})은 쓰지 않아요 — isolation: "worktree" 나 isolation 없이 다시 불러요` };
  const type = i.subagent_type;
  if (type !== undefined && type !== null && type !== "" && !SUBAGENT_TYPES.includes(String(type)))
    return { allow: false, reason: `서브에이전트 종류 ${String(type)} 은(는) 못 써요 — ${SUBAGENT_TYPES.join(", ")} 중 하나로` };
  const { isolation: _i, ...rest } = i;
  return { allow: true, input: { ...rest, run_in_background: false }, ...(wt ? { worktree: true as const } : {}) };
}

// SDK 옵션에 덧붙일 것: 서브에이전트 글도 받아 기록(thinking 은 기록 단계에서 버린다), 백그라운드 작업 끄기
export const SUBAGENT_SDK_OPTIONS = { forwardSubagentText: true } as const;
export const subagentEnv = (base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> =>
  ({ ...base, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
