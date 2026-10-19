// 윈도우 절대 경로(C:\…)도 받는 곳: 도구 줄 경로 줄이기 · 워크트리 카드 · 격리 에이전트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortPath, toolHeader } from '../src/tool-view.js';
import { normWorktrees } from '../src/worktrees.js';
import { normAgents } from '../src/agents.js';
import { isAbsPath } from '../src/resume.js';

test('isAbsPath: /… · C:\\… · C:/… 만', () => {
  for (const p of ['/x', 'C:\\x', 'd:/x']) assert.equal(isAbsPath(p), true, p);
  for (const p of ['x', 'C:x', '\\x', '', null, 3]) assert.equal(isAbsPath(p), false, String(p));
});

test('shortPath 윈도우: run 폴더 아래는 상대(대소문자 무시), 홈은 ~, 맥 규칙은 그대로', () => {
  const cwd = 'C:\\Users\\me\\.cy-agent\\worktrees\\app-1';
  assert.equal(shortPath(`${cwd}\\src\\a.ts`, cwd), 'src\\a.ts');
  assert.equal(shortPath('c:\\users\\ME\\.cy-agent\\worktrees\\app-1\\b.ts', `${cwd}\\`), 'b.ts');
  assert.equal(shortPath(cwd, cwd), '.');
  assert.equal(shortPath(`${cwd}-2\\x`, cwd), '~\\.cy-agent\\worktrees\\app-1-2\\x');
  assert.equal(shortPath('C:\\Users\\me\\code\\x.js', '/Users/me'), '~\\code\\x.js');
  assert.equal(shortPath('D:\\work\\x.js', cwd), 'D:\\work\\x.js');
  assert.equal(shortPath('/Users/me/code/x.js', '/Users/me/code'), 'x.js');
  assert.equal(shortPath('/Users/me/y', null), '~/y');
  assert.equal(toolHeader('Grep', 'foo in C:\\Users\\me\\r\\src', { cwd: 'C:\\Users\\me\\r' }).arg, 'foo in src');
});

test('normWorktrees·normAgents: 윈도우 경로도 남기고, 상대 경로는 뺀다', () => {
  const at = '2026-10-01T00:00:00Z';
  const wt = normWorktrees({ worktrees: [
    { key: 'a', kind: 'fix', askedAt: at, path: 'C:\\Users\\me\\.cy-agent\\worktrees\\a' },
    { key: 'b', kind: 'fix', askedAt: at, path: 'rel\\b' },
  ] });
  assert.deepEqual(wt.map((w) => w.path), ['C:\\Users\\me\\.cy-agent\\worktrees\\a', undefined]);
  const ag = normAgents([
    { runId: 'r1', toolUseId: 't1', startedAt: at, worktree: { path: 'C:\\w\\x', branch: 'cy/x' } },
    { runId: 'r2', toolUseId: 't2', startedAt: at, worktree: { path: 'x' } },
  ]);
  assert.deepEqual(ag.map((a) => a.worktree), [{ path: 'C:\\w\\x', branch: 'cy/x' }, undefined]);
});
