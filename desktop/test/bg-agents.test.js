// 백그라운드 에이전트(채팅이 넘긴 서브에이전트) 카드: 백그라운드·워크트리 표시·멈추기 가능 여부·캐릭터 캡션 수(대기 상태 없음 — 전부 바로 돈다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normAgents, agentCard, agentStrip, canStopAgent, runningCount, runningLine } from '../src/agents.js';
import { buildItems, BG_MARK } from '../src/session.js';
import { subagentSummary } from '../src/tool-view.js';

const at = '2026-10-12T12:51:48.000Z';
const base = { runId: 'r1', toolUseId: 'toolu_1', description: 'PR #271 코드 점검', tools: 20, last: 'Bash(gh pr diff 271)', startedAt: at };

test('normAgents: background·worktree 표시를 받는다(모르는 값·옛 queued 는 버림)', () => {
  const wt = { path: '/Users/u/.cy-agent/worktrees/app-atoolu1', branch: 'cy/agent-pr-271-toolu1' };
  const list = normAgents({ agents: [{ ...base, status: 'running', background: true, worktree: wt }, { ...base, toolUseId: 't2', status: 'queued', background: 'yes', worktree: { path: 'rel' } }] });
  assert.deepEqual(list.map((a) => [a.status, a.background, a.worktree]), [['running', true, wt], ['stopped', undefined, undefined]]);
});

test('agentCard: 백그라운드 진행 중 — 「따로 돌아요」 안내, 워크트리 — 브랜치·경로, 끝남 — 결과는 아래 답에', () => {
  const run = agentCard({ ...base, status: 'running', background: true });
  assert.equal(run.status, '백그라운드 · 진행 중 · 도구 20번');
  assert.match(run.note, /다른 말을 해도 기다리지 않아요/);
  const w = agentCard({ ...base, status: 'running', background: true, worktree: { path: '/w/app-a1', branch: 'cy/agent-x-1' } });
  assert.equal(w.worktree, '🌿 cy/agent-x-1 · /w/app-a1');
  assert.equal(run.worktree, undefined);
  assert.match(runningLine({ ...base, status: 'running', background: true, worktree: { path: '/w/app-a1', branch: 'cy/agent-x-1' } }), /🌿 cy\/agent-x-1/);
  const done = agentCard({ ...base, status: 'done', background: true });
  assert.equal(done.status, '끝남 ✓ · 도구 20번 · 결과는 아래 답에');
  assert.equal(done.note, undefined);
  // 예전(답 안에서 돈) 에이전트는 그대로
  assert.deepEqual(agentCard({ ...base, status: 'running' }).status, '진행 중 · 도구 20번');
});

test('멈추기는 백그라운드 에이전트가 돌 때만 · 캐릭터 캡션 수는 도는 것 전부', () => {
  assert.equal(canStopAgent({ ...base, status: 'running', background: true }), true);
  assert.equal(canStopAgent({ ...base, status: 'done', background: true }), false);
  assert.equal(canStopAgent({ ...base, status: 'running' }), false);
  const list = Array.from({ length: 20 }, (_, i) => ({ ...base, toolUseId: `t${i}`, status: 'running', background: true }));
  assert.equal(runningCount(list), 20);
  const strip = agentStrip(list);
  assert.equal(strip.running.length, 20);
  assert.match(runningLine(list[0]), /백그라운드 · 도구 20번/);
});

test('세션 창: 채팅 run 의 Agent 줄이 백그라운드로 넘어갔으면 실패가 아니라 「백그라운드로 넘김」', () => {
  const items = buildItems([
    { seq: 1, type: 'user', text: '점검해' },
    { seq: 2, type: 'tool_use', name: 'Agent', input: 'PR #271 코드 점검', toolUseId: 'toolu_1' },
    { seq: 3, type: 'tool_result', toolUseId: 'toolu_1', output: `${BG_MARK} 「PR #271 코드 점검」 — 지금 백그라운드로 시작했어요`, isError: true },
  ]);
  const tool = items.find((i) => i.type === 'tools').tools[0];
  assert.equal(tool.isError, false);
  assert.equal(tool.handedOff, true);
  assert.match(subagentSummary(tool).state, /백그라운드로 넘김/);
});
