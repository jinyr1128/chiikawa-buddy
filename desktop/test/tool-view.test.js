import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHeader, shortPath, formatArgs, ellipsize, diffSummary, resultPreview, ARG_MAX } from '../src/tool-view.js';
import { buildItems } from '../src/session.js';

const cwd = '/Users/me/code/cy-agent';

test('shortPath: run 폴더 기준 상대 경로, 홈은 ~', () => {
  assert.equal(shortPath('/Users/me/code/cy-agent/agent/src/runs.ts', cwd), 'agent/src/runs.ts');
  assert.equal(shortPath('/Users/me/code/cy-agent', cwd), '.');
  assert.equal(shortPath('/Users/me/code/cy-agent-other/a.js', cwd), '~/code/cy-agent-other/a.js');
  assert.equal(shortPath('/home/u/x', null), '~/x');
  assert.equal(shortPath('/etc/hosts', cwd), '/etc/hosts');
  assert.equal(shortPath('rel/a.js', cwd), 'rel/a.js');
});

test('Bash: 첫 줄만, 120자 넘으면 …, 전체는 full', () => {
  const cmd = `cd ~/code/cy-agent && git cherry-pick 01c0246 2>&1 | tail -1 && (cd agent && npm test ${'x'.repeat(200)})`;
  const h = toolHeader('Bash', cmd, { cwd });
  assert.equal(h.name, 'Bash');
  assert.equal(h.arg.length, ARG_MAX);
  assert.ok(h.arg.endsWith('…'));
  assert.ok(h.arg.startsWith('cd ~/code/cy-agent && git cherry-pick'));
  assert.equal(h.full, cmd);
  const multi = toolHeader('Bash', 'git status\ngit diff');
  assert.equal(multi.arg, 'git status …');
  assert.equal(toolHeader('Bash', 'ls -la').arg, 'ls -la');
});

test('파일 도구: 경로 줄이기(예전 JSON 입력도)', () => {
  assert.equal(toolHeader('Read', '/Users/me/code/cy-agent/docs/contract.md', { cwd }).arg, 'docs/contract.md');
  assert.equal(toolHeader('Edit', '/Users/me/other/a.ts', { cwd }).arg, '~/other/a.ts');
  assert.equal(toolHeader('Write', '{"file_path":"/Users/me/code/cy-agent/b.js","content":"x"}', { cwd }).arg, 'b.js');
});

test('Grep·Glob: 패턴 + 경로', () => {
  assert.equal(toolHeader('Grep', 'tool_use in /Users/me/code/cy-agent/agent', { cwd }).arg, 'tool_use in agent');
  assert.equal(toolHeader('Glob', '**/*.ts', { cwd }).arg, '**/*.ts');
});

test('WebFetch·WebSearch·Agent: url·검색어·설명(예전 JSON 도)', () => {
  assert.equal(toolHeader('WebFetch', 'https://example.com/a').arg, 'https://example.com/a');
  assert.equal(toolHeader('WebFetch', '{"url":"https://x.y","prompt":"요약"}').arg, 'https://x.y');
  assert.equal(toolHeader('WebSearch', 'node 26 release').arg, 'node 26 release');
  assert.equal(toolHeader('Agent', '파일 찾기').arg, '파일 찾기');
  assert.equal(toolHeader('Task', '{"description":"조사","prompt":"..."}').arg, '조사');
});

test('MCP: server · tool(인자)', () => {
  const a = toolHeader('mcp__calendar__list_events', '{"start":"2026-10-12","top":5}');
  assert.equal(a.name, 'calendar · list_events');
  assert.equal(a.arg, 'start: "2026-10-12", top: 5');
  const b = toolHeader('mcp__claude-in-chrome__navigate', '{"url":"https://a.b","tabId":3,"x":1,"y":2}');
  assert.equal(b.name, 'claude-in-chrome · navigate');
  assert.equal(b.arg, 'url: "https://a.b", tabId: 3, x: 1, …');
});

test('그 밖: JSON 앞 키들, JSON 아니면 한 줄로', () => {
  assert.equal(toolHeader('TodoWrite', '할 일 3개').arg, '할 일 3개');
  assert.equal(toolHeader('Foo', '{"a":1}').arg, 'a: 1');
  assert.equal(formatArgs('a\n  b'), 'a b');
  assert.equal(toolHeader('Foo', '').arg, '');
  assert.equal(ellipsize('abc', 2), 'a…');
});

const tool = (o) => ({ name: 'Bash', input: '', diff: null, output: null, isError: false, truncated: false, size: undefined, done: true, ...o });

test('결과: 앞 4줄(빈 줄 빼고) + "… +N줄"', () => {
  const p = resultPreview(tool({ output: '26 files changed\n\nℹ pass 426\nℹ fail 0\nℹ skipped 0\nℹ todo 0\nℹ duration 3s\n' }));
  assert.equal(p.kind, 'lines');
  assert.deepEqual(p.lines, ['26 files changed', 'ℹ pass 426', 'ℹ fail 0', 'ℹ skipped 0']);
  assert.equal(p.more, '… +2줄');
  assert.equal(resultPreview(tool({ output: 'ok' })).more, '');
  assert.equal(resultPreview(tool({ output: 'a\nb\nc\nd\ne', truncated: true, size: 9000 })).more, '… +1줄 이상');
  assert.equal(resultPreview(tool({ output: 'a', truncated: true, size: 9000 })).more, '… 더 있음');
  assert.equal(resultPreview(tool({ output: 'x'.repeat(500) })).lines[0].length, 200);
});

test('결과: 오류·실행 중·출력 없음·기록 안 함', () => {
  const e = resultPreview(tool({ output: 'Error: boom\n  at x', isError: true }));
  assert.equal(e.error, true);
  assert.deepEqual(e.lines, ['Error: boom', '  at x']);
  assert.equal(resultPreview(tool({ done: false })).kind, 'running');
  assert.equal(resultPreview(tool({ output: '  \n' })).kind, 'empty');
  assert.equal(resultPreview(tool({ output: null })).kind, 'empty');
  const q = resultPreview(tool({ output: null, size: 1234 }));
  assert.equal(q.kind, 'quiet');
  assert.match(q.lines[0], /1,234자/);
});

test('결과: 수정은 줄 수 요약, Read 는 읽은 줄 수, 수정 오류는 오류 글', () => {
  const diff = [{ file: '/a', old: 'a\nb', new: 'a\nB\nC\nD' }];
  assert.deepEqual(diffSummary(diff), { add: 3, del: 1, text: '3줄 추가, 1줄 삭제' });
  assert.equal(diffSummary([{ file: '/n', old: '', new: 'x\ny' }]).text, '2줄 작성');
  assert.equal(diffSummary([{ file: '/a', old: 'a\nb', new: 'a' }]).text, '1줄 삭제');
  const ok = resultPreview(tool({ name: 'Edit', diff, output: 'The file /a has been updated.' }));
  assert.equal(ok.kind, 'summary');
  assert.deepEqual(ok.lines, ['3줄 추가, 1줄 삭제']);
  const bad = resultPreview(tool({ name: 'Edit', diff, output: 'String to replace not found', isError: true }));
  assert.equal(bad.error, true);
  assert.deepEqual(bad.lines, ['String to replace not found']);
  assert.deepEqual(resultPreview(tool({ name: 'Read', output: '1→a\n2→b\n3→c' })).lines, ['3줄 읽음']);
  assert.deepEqual(resultPreview(tool({ name: 'Read', output: '1→a', truncated: true, size: 12000 })).lines, ['12,000자 읽음']);
});

test('buildItems 의 도구 줄을 그대로 받는다', () => {
  const items = buildItems([
    { seq: 1, type: 'tool_use', name: 'Bash', input: 'npm test', toolUseId: 'a' },
    { seq: 2, type: 'tool_result', toolUseId: 'a', output: 'ℹ pass 1\nℹ fail 0' },
  ]);
  const t = items[0].tools[0];
  assert.equal(toolHeader(t.name, t.input).arg, 'npm test');
  assert.deepEqual(resultPreview(t).lines, ['ℹ pass 1', 'ℹ fail 0']);
});

test('서브에이전트: parent 이벤트는 Agent 줄 sub 로(맨 위 묶음을 안 끊음), 요약 "도구 N번 · 진행 중…/완료" + 마지막 도구', async () => {
  const { subagentSummary } = await import('../src/tool-view.js');
  const { runningSubagents, toolSig } = await import('../src/session.js');
  const ev = [
    { seq: 1, type: 'tool_use', name: 'Agent', input: '레포 조사', toolUseId: 'ag1' },
    { seq: 2, type: 'user', text: 'README 읽고 요약해', parent: 'ag1' },
    { seq: 3, type: 'assistant', text: '읽어 볼게요', parent: 'ag1' },
    { seq: 4, type: 'tool_use', name: 'Read', input: `${cwd}/README.md`, toolUseId: 's1', parent: 'ag1' },
    { seq: 5, type: 'tool_result', toolUseId: 's1', output: 'a\nb\nc', parent: 'ag1' },
    { seq: 6, type: 'tool_use', name: 'Grep', input: `TODO in ${cwd}/agent`, toolUseId: 's2', parent: 'ag1' },
    { seq: 7, type: 'tool_use', name: 'Bash', input: 'ls', toolUseId: 't2' }, // 맨 위 — 같은 묶음
    { seq: 8, type: 'tool_use', name: 'Read', input: 'x', toolUseId: 'zz', parent: 'nope' }, // Agent 줄 없음 → 안 보임
  ];
  let items = buildItems(ev);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].tools.map((t) => t.name), ['Agent', 'Bash']);
  const ag = items[0].tools[0];
  assert.equal(ag.sub.prompt, 'README 읽고 요약해');
  assert.deepEqual(ag.sub.lines.map((l) => l.type), ['text', 'tool', 'tool']);
  assert.equal(ag.sub.tools[0].done, true);
  assert.equal(ag.sub.tools[1].done, false);
  assert.equal(runningSubagents(items), 1);
  let s = subagentSummary(ag, { cwd });
  assert.equal(s.text, '도구 2번 · 진행 중…');
  assert.deepEqual([s.latest.name, s.latest.arg, s.latest.state], ['Grep', 'TODO in agent', 'run']);
  assert.equal(subagentSummary(ag, { running: false }).text, '도구 2번 · 멈춤');
  const sig1 = toolSig(ag);
  // 안쪽 결과·Agent 최종 결과 → 완료, 최종 결과가 ⎿ 미리보기
  items = buildItems([...ev,
    { seq: 9, type: 'tool_result', toolUseId: 's2', output: '', parent: 'ag1' },
    { seq: 10, type: 'system', text: '… 더 있음 (서브에이전트 기록은 여기까지)', parent: 'ag1' },
    { seq: 11, type: 'tool_result', toolUseId: 'ag1', output: '요약: 데몬과 데스크톱' },
  ]);
  const done = items[0].tools[0];
  assert.notEqual(toolSig(done), sig1); // 렌더 캐시가 안쪽 변화도 본다
  s = subagentSummary(done);
  assert.equal(s.text, '도구 2번 · 완료');
  assert.match(s.more, /더 있음/);
  assert.equal(runningSubagents(items), 0);
  assert.deepEqual(resultPreview(done).lines, ['요약: 데몬과 데스크톱']);
  // Task(옛 이름)도 같다 · 안쪽 서브에이전트도 센다 · 아무 도구도 없으면 상태만
  const nested = buildItems([
    { seq: 1, type: 'tool_use', name: 'Task', input: '바깥', toolUseId: 'o' },
    { seq: 2, type: 'tool_use', name: 'Agent', input: '안쪽', toolUseId: 'i', parent: 'o' },
    { seq: 3, type: 'tool_use', name: 'Read', input: 'a', toolUseId: 'r', parent: 'i' },
  ]);
  assert.equal(runningSubagents(nested), 2);
  assert.equal(nested[0].tools[0].sub.tools[0].sub.tools[0].name, 'Read');
  assert.equal(subagentSummary({ name: 'Agent', done: false, sub: { tools: [], lines: [] } }).text, '진행 중…');
  assert.equal(subagentSummary({ name: 'Agent', done: true, isError: true }).text, '실패');
});
