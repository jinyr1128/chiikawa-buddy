// 터미널 Claude Code 에서 이어 간 대화 불러오기(↻ 새로고침): 세션 창 줄 표시 · 대화 말 표시 · "Claude Code에서 열기" 기록 찾기 · IPC 배선
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildItems } from '../src/session.js';
import { normThreads, mergeMessages } from '../src/threads.js';
import { planResume, sessionCwd, sessionFile, projectDirName, canSync, syncTip, syncNote, terminalArgs, resumeCommand } from '../src/resume.js';

const HOME = '/Users/a.b';
const SID = '0b5f3c2e-1a2b-4c3d-9e8f-001122334455';

test('buildItems: via cli 줄은 cli 표시, 데몬 답과 터미널 답은 안 합친다, 서브에이전트는 그대로 Agent 줄 sub 로', () => {
  const items = buildItems([
    { seq: 1, type: 'user', text: '처음' },
    { seq: 2, type: 'assistant', text: '데몬 답' },
    { seq: 3, type: 'system', text: '터미널 Claude Code 에서 이어 간 대화', via: 'cli' },
    { seq: 4, type: 'assistant', text: '터미널 답', via: 'cli' },
    { seq: 5, type: 'user', text: '터미널에서 물음', via: 'cli' },
    { seq: 6, type: 'tool_use', name: 'Agent', input: '조사', toolUseId: 'ag', via: 'cli' },
    { seq: 7, type: 'tool_use', name: 'Grep', input: 'x', toolUseId: 'g', parent: 'ag', via: 'cli' },
    { seq: 8, type: 'tool_result', toolUseId: 'ag', output: '끝', via: 'cli' },
  ]);
  assert.deepEqual(items.map((i) => [i.type, !!i.cli]), [['user', false], ['assistant', false], ['system', true], ['assistant', true], ['user', true], ['tools', false]]);
  assert.equal(items[3].text, '터미널 답');
  const ag = items[5].tools[0];
  assert.deepEqual([ag.name, ag.done, ag.sub.tools.map((t) => t.name)], ['Agent', true, ['Grep']]);
});

test('threads: cliSync·via cli 를 살리고(로컬 사본엔 안 붙임)', () => {
  const [t] = normThreads([{ id: 't1', title: 'x', updated: '2026-10-12T00:00:00Z', cliSync: true }]);
  assert.equal(t.cliSync, true);
  assert.equal(normThreads([{ id: 't2', cliSync: 'yes' }])[0].cliSync, undefined);
  const msgs = mergeMessages([], [{ n: 1, role: 'user', text: '터미널', at: '', via: 'cli' }, { n: 2, role: 'assistant', text: '답', at: '' }]);
  assert.deepEqual(msgs.map((m) => m.via), ['cli', undefined]);
});

test('sessionCwd: 프로젝트 폴더와 맞는 cwd 먼저, 없으면 처음 것, 깨진 줄은 건너뜀', () => {
  const text = [
    '{"type":"queue-operation"}',
    'not json "cwd"',
    JSON.stringify({ cwd: `${HOME}/.cy-agent/brain` }),
    JSON.stringify({ cwd: `${HOME}/code/demo` }),
  ].join('\n');
  assert.equal(sessionCwd(text, projectDirName(`${HOME}/code/demo`)), `${HOME}/code/demo`);
  assert.equal(sessionCwd(text), `${HOME}/.cy-agent/brain`);
  assert.equal(sessionCwd('{"cwd":"relative"}'), null);
});

test('planResume: 기록된 cwd(brain) 아래 없으면 다른 프로젝트에서 찾은 실제 cwd 로 연다', () => {
  const claudeDir = `${HOME}/.claude`, brain = `${HOME}/.cy-agent/brain`, repo = `${HOME}/code/demo`;
  const files = new Set([repo, brain, sessionFile(claudeDir, repo, SID)]);
  const exists = (p) => files.has(p);
  const run = { id: 'r1', kind: 'chat', sdkSessionId: SID, cwd: brain };
  const asked = [];
  const ok = planResume(run, { home: HOME, claudeDir, exists, findSession: (sid) => { asked.push(sid); return { cwd: repo }; } });
  assert.deepEqual([ok.ok, ok.cwd, ok.mkdir], [true, repo, false]);
  assert.deepEqual(ok.args, terminalArgs(resumeCommand(repo, SID)));
  assert.deepEqual(asked, [SID]);
  // 찾은 cwd 가 이상하거나(홈 밖) 그 자리에 기록이 없으면 못 연다
  assert.equal(planResume(run, { home: HOME, claudeDir, exists, findSession: () => ({ cwd: '/etc' }) }).error, '이 세션 기록을 찾을 수 없어요.');
  assert.equal(planResume(run, { home: HOME, claudeDir, exists, findSession: () => ({ cwd: `${HOME}/code/other` }) }).ok, false);
  assert.equal(planResume(run, { home: HOME, claudeDir, exists, findSession: () => null }).ok, false);
  assert.equal(planResume(run, { home: HOME, claudeDir, exists }).ok, false); // 예전 호출(찾기 없음)
});

test('canSync·syncTip·syncNote', () => {
  assert.equal(canSync({ sdkSessionId: SID }), true);
  assert.equal(canSync({ sdkSessionId: 'x' }), false);
  assert.match(syncTip({ watching: true }), /지켜보며/);
  assert.doesNotMatch(syncTip({}), /지켜보며/);
  assert.equal(syncNote(3), '터미널에서 이어 간 기록 3줄을 불러왔어요.');
  assert.equal(syncNote(0), '새로 불러올 터미널 기록이 없어요.');
});

test('IPC 배선: 세션 창 ↻ → session-sync → POST /runs/:id/sync · 열기 뒤 watch · 패널 ↻ → chat-thread-sync', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js'), ps = read('preload-session.cjs'), pp = read('preload-panel.cjs');
  const sess = read('renderer/session.js'), html = read('renderer/session.html'), panel = read('renderer/panel.js'), phtml = read('renderer/panel.html');
  assert.match(ps, /syncRun: \(id\) => ipcRenderer\.invoke\('session-sync', String\(id\)\)/);
  assert.match(main, /ipcMain\.handle\('session-sync', \(e, id\) => \(fromOurs\(e\) && okRunId\(id\) \? post\(`\/runs\/\$\{id\}\/sync`\) : denied\(\)\)\)/);
  assert.match(main, /post\(`\/runs\/\$\{id\}\/sync`, \{ watch: true \}\)/);
  assert.match(main, /findSession: \(sid\) => findSessionCwd\(claudeDir, sid\)/);
  assert.match(main, /isSymbolicLink\(\)/);
  assert.match(pp, /chatThreadSync: \(id\) => ipcRenderer\.invoke\('chat-thread-sync', String\(id\)\)/);
  assert.match(main, /ipcMain\.handle\('chat-thread-sync', \(e, id\) => \(fromOurs\(e\) && okThreadId\(id\) \? post\(`\/chat\/threads\/\$\{id\}\/sync`\) : denied\(\)\)\)/);
  assert.match(html, /id="btn-sync"[^>]*>↻ 새로고침</);
  assert.match(sess, /cy\.syncRun\(r\.id\)/);
  assert.match(sess, /'Claude Code'/);
  assert.match(phtml, /id="th-sync"/);
  assert.match(panel, /cy\.chatThreadSync\(id\)/);
  assert.match(panel, /m\.via === 'cli'/);
});
