// 가짜 작업 세션(runs) — agent/src/runs.ts 흉내. fake-daemon.mjs 가 쓴다.
// GET /runs · /runs/:id?since= · POST /runs/:id/message|interrupt|stop · POST /fake/runs/start(새 수정 run)
// 보낸 말은 대기 중(user pending + msgId) → 도는 도구가 끝난 다음 걸음에 delivery delivered · POST /runs/:id/messages/:msgId/now|cancel · POST /runs/:id/btw
// 이어서 하기: POST /runs/:id/continue(수정 → 연결된 새 run, 그 밖 → 대화 답을 그 run 에) · GET /repos · POST /proposals(새 작업 → 승인 → 수정 run)
// SSE: run {id, seq, event} · runs {run, active}
// 원래 화면(origin): chatRun({ title, text, origin, parentId }) — 채팅·할 일 팝오버 run(데몬처럼 origin 을 단다).
// parentId 가 있으면(세션 창 → 원래 대화로 이어 말하기) 물은 말·답이 그 run 기록에도 followUp 으로 붙는다
import { randomUUID } from 'node:crypto';

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

export function createFakeRuns(emit, { onActive = () => {}, stepMs = Number(process.env.FAKE_RUN_STEP_MS) || 1500 } = {}) {
  const runs = new Map(); // id → { run, events, timer, script, paused }
  const childIds = (id) => [...runs.values()].filter((x) => x.run.parentId === id).sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt)).map((x) => x.run.id);
  const summary = (r) => {
    const kids = childIds(r.run.id);
    return { ...r.run, events: r.events.length, dropped: 0, interactive: r.run.status === 'running' && r.run.kind === 'fix', ...(kids.length ? { childIds: kids } : {}) };
  };
  const active = () => [...runs.values()].filter((r) => r.run.status === 'running').map(summary);
  const changed = (r) => { emit('runs', { run: summary(r), active: active() }); onActive(active()); };
  const log = (r, ev) => {
    const seq = r.events.length + 1;
    const event = { seq, at: new Date().toISOString(), ...ev };
    r.events.push(event);
    emit('run', { id: r.run.id, seq, event });
    return event;
  };
  const end = (r, status, error) => {
    clearTimeout(r.timer);
    r.run.status = status;
    r.run.endedAt = new Date().toISOString();
    if (error) r.run.error = error;
    log(r, { type: 'status', text: status + (error ? `: ${error}` : '') });
    changed(r);
  };

  function seedDone(kind, title, minAgo, events, extra = {}) {
    const r = { run: { id: randomUUID(), kind, title, model: kind === 'fix' ? 'claude-opus' : 'claude-sonnet', startedAt: ago(minAgo), endedAt: ago(minAgo - 3), status: 'done', costUsd: 0.21, cwd: kind === 'fix' ? '/Users/me/.cy-agent/worktrees/app-1234' : '/Users/me/.cy-agent/brain', sdkSessionId: 'sess-fake', routine: !['fix', 'chat'].includes(kind), ...(kind === 'fix' ? { repo: '/Users/me/code/app', branch: 'cy/login-btn-a1b2c3', prUrl: 'https://github.com/example/app/pull/12' } : {}), ...extra }, events: [] };
    events.forEach((e, i) => r.events.push({ seq: i + 1, at: ago(minAgo - i * 0.1), ...e }));
    r.events.push({ seq: r.events.length + 1, at: r.run.endedAt, type: 'status', text: r.run.status });
    runs.set(r.run.id, r);
    return r;
  }

  // 정기 작업(스케줄): 세션 창 아래 "정기 작업" 묶음에 들어간다
  for (const [i, min] of [30, 60, 120, 1500].entries()) {
    seedDone('briefing', '정기 브리핑', min, [
      { type: 'assistant', text: `정기 브리핑 #${i + 1}: 오늘 회의 ${3 - (i % 2)}개.` },
      { type: 'result', text: 'ok', costUsd: 0.04 },
    ], { costUsd: 0.04 });
  }
  for (const min of [5, 25, 45]) seedDone('calendar', '캘린더 동기화', min, [{ type: 'result', text: '(본문 3자 — 기록 안 함)', size: 3 }], { costUsd: 0.002 });
  seedDone('profile', '프로필 학습', 70, [{ type: 'assistant', text: '새로 알게 된 것 2개.' }, { type: 'result', text: 'ok' }]);
  seedDone('chat', '채팅: 오늘 뭐 해야 돼?', 26 * 60, [
    { type: 'user', text: '오늘 뭐 해야 돼?' },
    { type: 'assistant', text: '견적 회신이 제일 급해요.' },
  ], { costUsd: 0.02 });

  seedDone('fix', '로그인 버튼 색 고치기', 90, [
    { type: 'user', text: '다음 변경을 이 레포에 구현해.\n\n제목: 로그인 버튼 색 고치기\n계획:\n버튼을 브랜드 보라색으로' },
    { type: 'system', text: '세션 시작 · claude-opus · /Users/me/.cy-agent/worktrees/app-1234' },
    { type: 'assistant', text: '버튼 스타일 파일을 먼저 볼게요.' },
    { type: 'tool_use', name: 'Grep', input: 'login-btn in src', toolUseId: 'a1' },
    { type: 'tool_result', toolUseId: 'a1', output: 'src/Login.css:12:.login-btn {' },
    { type: 'tool_use', name: 'Edit', input: '/w/src/Login.css', toolUseId: 'a2', diff: [{ file: 'src/Login.css', old: '.login-btn {\n  color: #fff;\n  background: #888;\n}', new: '.login-btn {\n  color: #fff;\n  background: #6b5cff;\n}' }] },
    { type: 'tool_result', toolUseId: 'a2', output: 'The file src/Login.css has been updated.' },
    { type: 'tool_use', name: 'Bash', input: 'npm test', toolUseId: 'a3' },
    { type: 'tool_result', toolUseId: 'a3', output: '> app@1.0.0 test\n> node --test\n\n✔ login button (2ms)\nℹ pass 12\nℹ fail 0' },
    { type: 'assistant', text: '**배경색**을 `#6b5cff` 로 바꿨고 테스트 12개 통과했어요.' },
    { type: 'result', text: '완료', costUsd: 0.21 },
  ]);
  // 턴 한도로 멈춘 수정 run(주황 + [이어서 하기]) · 저장 안 된 작업이 있어 남긴 워크트리
  seedDone('fix', '회의록 dev 배포 검증', 150, [
    { type: 'user', text: '다음 변경을 이 레포에 구현해.\n\n제목: 회의록 dev 배포 검증' },
    { type: 'tool_use', name: 'Bash', input: 'psql -c "select count(*) from meetings"', toolUseId: 'm1' },
    { type: 'tool_result', toolUseId: 'm1', output: ' count \n-------\n   42' },
    { type: 'result', text: 'error_max_turns', isError: true, costUsd: 4.99 },
    { type: 'status', text: 'stopped: 턴 한도에 닿아 멈췄어요' },
    { type: 'system', text: '📁 커밋 안 된 변경 2개가 있어서 워크트리를 지우지 않고 남겨 뒀어요: /Users/me/.cy-agent/worktrees/code-notes-app-db4f38a7', worktree: '/Users/me/.cy-agent/worktrees/code-notes-app-db4f38a7' },
  ], { status: 'stopped', error: '턴 한도에 닿아 멈췄어요', costUsd: 4.99, cwd: '/Users/me/.cy-agent/worktrees/code-notes-app-db4f38a7' });
  seedDone('briefing', '정기 브리핑', 40, [
    { type: 'user', text: '(브리핑 맥락 …)' },
    { type: 'tool_use', name: 'mcp__google-calendar__list-events', input: 'today', toolUseId: 'b1' },
    { type: 'tool_result', toolUseId: 'b1', output: '{"events": 3}' },
    { type: 'assistant', text: '오늘 회의 3개, 답장 필요한 메일 1개.' },
    { type: 'result', text: 'ok', costUsd: 0.05 },
  ], { costUsd: 0.05, routine: false, title: '브리핑 (지금 브리핑)' });
  seedDone('slack-ingest', 'Slack 수집', 20, [
    { type: 'user', text: '(본문 812자 — 기록 안 함)', size: 812 },
    { type: 'tool_use', name: 'conversations.history', toolUseId: 'c1', size: 64 },
    { type: 'tool_result', toolUseId: 'c1', size: 18233 },
    { type: 'result', text: '(본문 4자 — 기록 안 함)', size: 4 },
  ], { costUsd: 0.004, startedAt: ago(20) });

  // 돌고 있는 수정 run: 대본을 stepMs 마다 한 줄씩. 메시지를 받으면 다음 턴으로 메아리
  const SCRIPT = [
    { type: 'system', text: '세션 시작 · claude-opus · /Users/me/.cy-agent/worktrees/demo-abcd' },
    { type: 'assistant', text: '어디를 고쳐야 할지 먼저 찾아볼게요.' },
    { type: 'tool_use', name: 'Glob', input: 'src/**/*.ts', id: 1 },
    { type: 'tool_result', id: 1, output: 'src/a.ts\nsrc/b.ts\nsrc/c.ts' },
    // 서브에이전트(Agent): 안쪽 줄은 parent(pid) 로 — 세션 창에서 Agent 줄 아래 접혀 보인다
    { type: 'tool_use', name: 'Agent', input: 'greet 쓰는 곳 찾기', id: 5 },
    { type: 'user', text: 'greet 를 부르는 곳을 모두 찾아 줄 번호와 함께 알려줘', pid: 5 },
    { type: 'tool_use', name: 'Grep', input: 'greet\\( in /w/src', id: 6, pid: 5 },
    { type: 'tool_result', id: 6, output: 'src/b.ts:3\nsrc/c.ts:10', pid: 5 },
    { type: 'assistant', text: '두 군데예요. 파일을 확인할게요.', pid: 5 },
    { type: 'tool_use', name: 'Read', input: '/w/src/b.ts', id: 7, pid: 5 },
    { type: 'tool_result', id: 7, output: 'import { greet } from "./a";\n\ngreet("x");', pid: 5 },
    { type: 'tool_result', id: 5, output: 'greet 호출: src/b.ts:3, src/c.ts:10 — 둘 다 문자열 인자' },
    { type: 'tool_use', name: 'Read', input: '/w/src/a.ts', id: 2 },
    { type: 'tool_result', id: 2, output: 'export const greet = (n) => `hi ${n}`;\n'.repeat(3) },
    { type: 'assistant', text: '`greet` 를 고칠게요.' },
    { type: 'tool_use', name: 'Edit', input: '/w/src/a.ts', id: 3, diff: [{ file: 'src/a.ts', old: 'export const greet = (n) => `hi ${n}`;', new: 'export const greet = (n: string) => `안녕, ${n}`;' }] },
    { type: 'tool_result', id: 3, output: 'The file src/a.ts has been updated.' },
    { type: 'tool_use', name: 'Bash', input: 'npm test', id: 4 },
    { type: 'tool_result', id: 4, output: 'ℹ pass 30\nℹ fail 0' },
    { type: 'assistant', text: '테스트 통과. 마무리할게요.' },
  ];
  // 한 걸음: 받은 메시지 먼저 메아리, 아니면 대본 다음 줄, 대본 끝이면 완료. 중단(paused) 중엔 메시지만 기다린다
  function step(r) {
    if (r.run.status !== 'running') return;
    // 도구가 도는 중(마지막 맨 위 줄이 결과 없는 tool_use)이면 보낸 말은 기다린다 — 진짜 CLI 처럼 도구 경계에서 접어 넣는다
    const last = [...r.events].reverse().find((e) => !e.parent);
    const toolRunning = last?.type === 'tool_use' && !r.now;
    if (r.queue.length && !toolRunning) {
      const { text, msgId } = r.queue.shift();
      if (msgId) log(r, { type: 'delivery', msgId, state: 'delivered', ...(r.now ? { now: true } : {}) });
      r.now = false;
      log(r, { type: 'assistant', text: `받았어요 — 먼저 답할게요: ${text}` });
      const tid = `q${r.events.length}`;
      log(r, { type: 'tool_use', name: 'Edit', input: '/w/README.md', toolUseId: tid, diff: [{ file: 'README.md', old: '# demo', new: `# demo\n${text}` }] });
      log(r, { type: 'tool_result', toolUseId: tid, output: 'The file README.md has been updated.' });
    } else if (r.paused) return;
    else if (r.i < SCRIPT.length) {
      const { id, pid, ...ev } = SCRIPT[r.i++];
      const tid = (n) => `${r.run.id.slice(0, 4)}-${n}`;
      log(r, { ...ev, ...(id ? { toolUseId: tid(id) } : {}), ...(pid ? { parent: tid(pid) } : {}) });
    } else {
      r.run.costUsd = 0.37;
      log(r, { type: 'result', text: '완료', costUsd: 0.37 });
      return end(r, 'done');
    }
    r.timer = setTimeout(() => step(r), stepMs);
  }
  function start(title = '인사말 한국어로 바꾸기', extra = {}, first = null) {
    const r = { run: { id: randomUUID(), kind: 'fix', title, model: 'claude-opus', startedAt: new Date().toISOString(), status: 'running', cwd: '/Users/me/.cy-agent/worktrees/demo-abcd', routine: false, repo: '/Users/me/code/demo', branch: 'cy/demo-abcd12', ...extra }, events: [], queue: [], i: 0, paused: false };
    runs.set(r.run.id, r);
    changed(r);
    if (r.run.parentId && runs.get(r.run.parentId)) changed(runs.get(r.run.parentId)); // 부모의 childIds
    log(r, first ?? { type: 'user', text: `다음 변경을 이 레포에 구현해.\n\n제목: ${title}` });
    r.timer = setTimeout(() => step(r), stepMs);
    return r;
  }
  if (!process.env.FAKE_NO_RUN) start();

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const REPOS = [{ path: '/Users/me/code/app', name: 'app' }, { path: '/Users/me/code/cy-agent', name: 'cy-agent' }, { path: '/Users/me/code/demo', name: 'demo' }];
  const proposals = new Map();
  let proposalSeq = 0;

  // 처리했으면 true
  function handle(req, res, url, body) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/runs') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const status = url.searchParams.get('status');
      let list = [...runs.values()].map(summary);
      if (status) list = list.filter((r) => r.status === status);
      list.sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.startedAt.localeCompare(a.startedAt));
      json(res, 200, { runs: list.slice(0, limit) });
      return true;
    }
    if (req.method === 'GET' && p === '/repos') { json(res, 200, { repos: REPOS }); return true; }
    const g = req.method === 'GET' && p.match(/^\/runs\/([\w-]+)$/);
    if (g) {
      const r = runs.get(g[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      const since = Number(url.searchParams.get('since') ?? 0);
      json(res, 200, { run: summary(r), events: r.events.filter((e) => e.seq > since) });
      return true;
    }
    if (req.method !== 'POST') return false;
    if (p === '/fake/runs/start') { const r = start(body?.title || undefined); json(res, 200, { ok: true, id: r.run.id }); return true; }
    if (p === '/proposals') {
      const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!repo || !text) { json(res, 400, { error: !repo ? 'repo required' : 'text required' }); return true; }
      if (!REPOS.some((x) => x.path === repo)) { json(res, 400, { error: '허용된 레포가 아니에요(repoRoots 안의 git 레포만)' }); return true; }
      const id = `np${++proposalSeq}`;
      const title = text.split('\n')[0].slice(0, 60);
      proposals.set(id, { id, repo, title, plan: text, status: 'pending' });
      json(res, 201, { ok: true, proposal: { id, repo, title, status: 'pending' } });
      return true;
    }
    const pa = p.match(/^\/proposals\/([\w-]+)\/(approve|hold)$/);
    if (pa && proposals.has(pa[1])) { // 세션 창 "새 작업"으로 만든 제안만 여기서(나머지는 가짜 데몬이)
      const pr = proposals.get(pa[1]);
      if (pr.status !== 'pending') { json(res, 200, { ok: true, result: '이미 처리된 제안이에요' }); return true; }
      pr.status = pa[2] === 'approve' ? 'approved' : 'held';
      if (pa[2] === 'approve') setTimeout(() => start(pr.title, { ref: pr.id, repo: pr.repo, branch: `cy/task-${pr.id}`, cwd: `/Users/me/.cy-agent/worktrees/${pr.repo.split('/').pop()}-${pr.id}` }), 300);
      json(res, 200, { ok: true, result: pa[2] === 'approve' ? '승인' : '보류' });
      return true;
    }
    // ↻ 새로고침(터미널 Claude Code 에서 이어 간 대화 불러오기) 흉내: 처음 한 번만 via cli 줄들(서브에이전트 하나 포함)
    const sy = p.match(/^\/runs\/([\w-]+)\/sync$/);
    if (sy) {
      const r = runs.get(sy[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      if (!r.run.sdkSessionId) { json(res, 409, { error: '이 세션에는 Claude Code 세션 id 가 없어요' }); return true; }
      if (r.cliSynced) { json(res, 200, { ok: true, imported: 0 }); return true; }
      r.cliSynced = true;
      const via = 'cli', ag = `toolu_cli_${r.run.id.slice(0, 8)}`;
      const evs = [
        { type: 'system', text: '터미널 Claude Code 에서 이어 간 대화', via },
        { type: 'user', text: '터미널에서: 관련 파일도 한번 찾아봐 줘', via },
        { type: 'tool_use', name: 'Agent', input: '관련 파일 찾기', toolUseId: ag, via },
        { type: 'user', text: '관련 파일 찾아줘', parent: ag, via },
        { type: 'tool_use', name: 'Grep', input: 'login in src', toolUseId: `${ag}_g`, parent: ag, via },
        { type: 'tool_result', toolUseId: `${ag}_g`, output: 'src/login.tsx:12', parent: ag, via },
        { type: 'tool_result', toolUseId: ag, output: 'src/login.tsx 한 곳이에요', via },
        { type: 'assistant', text: '관련 파일은 `src/login.tsx` 한 곳이에요.', via },
      ];
      for (const ev of evs) log(r, ev);
      changed(r);
      json(res, 200, { ok: true, imported: evs.length });
      return true;
    }
    const ct = p.match(/^\/runs\/([\w-]+)\/continue$/);
    if (ct) {
      const r = runs.get(ct[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) { json(res, 400, { error: 'text required' }); return true; }
      if (text.length > 8000) { json(res, 400, { error: 'text too long' }); return true; }
      if (r.run.kind === 'fix') {
        if (r.run.status === 'running') { json(res, 409, { error: 'run is running — use /message' }); return true; }
        const base = r.run.title.replace(/(?:\s·\s이어서)+$/, '');
        const c = start(`${base} · 이어서`, { parentId: r.run.id, ref: r.run.ref, repo: r.run.repo, branch: r.run.branch, prUrl: r.run.prUrl, cwd: r.run.cwd }, { type: 'user', text, injected: true });
        log(c, { type: 'system', text: `🌿 ${r.run.branch ?? 'cy/…'} 에서 이어서 해요${r.run.prUrl ? ` — PR ${r.run.prUrl} 에 올라가요` : ''}` });
        log(c, { type: 'system', text: '↩︎ 이전 세션 이어서(resume sess-fak…)' });
        c.queue.push(text);
        log(r, { type: 'system', text: `이어서 하기 → "${c.run.title}"`, childId: c.run.id });
        json(res, 202, { ok: true, mode: 'fix', runId: c.run.id });
        return true;
      }
      log(r, { type: 'user', text, injected: true, followUp: true });
      const chatId = `chat-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        const out = [...r.events].reverse().find((e) => e.type === 'assistant' && !e.followUp)?.text ?? '';
        log(r, { type: 'assistant', text: `(가짜 답) "${text}" — 이 세션 결과 기준으로: ${out.slice(0, 80) || '남긴 결과가 없어요'}`, followUp: true });
        const cr = { run: { id: randomUUID(), kind: 'chat', title: `채팅: [작업 세션 이어서] ${text.slice(0, 40)}`, model: 'claude-sonnet', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'done', routine: false, parentId: r.run.id }, events: [] };
        runs.set(cr.run.id, cr);
        log(cr, { type: 'user', text });
        log(cr, { type: 'status', text: 'done' });
        changed(cr); changed(r);
      }, Math.min(1200, stepMs));
      json(res, 202, { ok: true, mode: 'chat', chatId, runId: r.run.id });
      return true;
    }
    // 대기 중인 말: 지금 보내기(도는 도구를 멈추고 바로) · 취소
    const pm = p.match(/^\/runs\/([\w-]+)\/messages\/([\w-]+)\/(now|cancel)$/);
    if (pm) {
      const r = runs.get(pm[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      const i = (r.queue ?? []).findIndex((q) => q.msgId === pm[2]);
      if (r.run.status !== 'running' || i < 0) { json(res, 409, { error: 'already delivered (or unknown message)' }); return true; }
      if (pm[3] === 'cancel') {
        r.queue.splice(i, 1);
        log(r, { type: 'delivery', msgId: pm[2], state: 'cancelled' });
      } else {
        r.queue.unshift(...r.queue.splice(i, 1));
        r.now = true;
        log(r, { type: 'system', text: '지금 보내기 — 하던 도구·턴을 멈추고 이 말을 바로 전달해요' });
        const last = [...r.events].reverse().find((e) => !e.parent);
        if (last?.type === 'tool_use') log(r, { type: 'tool_result', toolUseId: last.toolUseId, output: 'Interrupted', isError: true });
        clearTimeout(r.timer);
        r.timer = setTimeout(() => step(r), 300);
      }
      json(res, 200, { ok: true });
      return true;
    }
    // /btw 곁질문: run 기록에 아무것도 안 붙이고 바로 답
    const bt = p.match(/^\/runs\/([\w-]+)\/btw$/);
    if (bt) {
      const r = runs.get(bt[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      const q = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!q) { json(res, 400, { error: 'text required' }); return true; }
      const tools = r.events.filter((e) => e.type === 'tool_use' && !e.parent).length;
      setTimeout(() => json(res, 200, { ok: true, model: 'claude-haiku', answer: `(가짜 btw) 「${r.run.title}」 기록을 보면 지금까지 도구를 ${tools}번 썼어요. 물어본 것: **${q}** — 작업은 그대로 돌고 있어요.` }), 600);
      return true;
    }
    const c = p.match(/^\/runs\/([\w-]+)\/(message|interrupt|stop)$/);
    if (!c) return false;
    const r = runs.get(c[1]);
    if (!r) { json(res, 404, { error: 'no such run' }); return true; }
    if (r.run.status !== 'running' || r.run.kind !== 'fix') { json(res, 409, { error: 'run is not running (read-only)' }); return true; }
    if (c[2] === 'message') {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) { json(res, 400, { error: 'text required' }); return true; }
      if (text.length > 8000) { json(res, 400, { error: 'text too long' }); return true; }
      const msgId = randomUUID();
      const clientId = typeof body?.clientId === 'string' && /^[\w-]{1,64}$/.test(body.clientId) ? body.clientId : undefined;
      r.queue.push({ text, msgId });
      r.paused = false;
      log(r, { type: 'user', text, injected: true, msgId, pending: true, ...(clientId ? { clientId } : {}) });
      clearTimeout(r.timer);
      r.timer = setTimeout(() => step(r), Math.min(800, stepMs));
      json(res, 200, { ok: true, msgId, pending: true });
      return true;
    } else if (c[2] === 'interrupt') {
      r.paused = true;
      clearTimeout(r.timer);
      log(r, { type: 'system', text: '사용자가 중단(interrupt)했어' });
      log(r, { type: 'result', text: 'error_during_execution', isError: true });
      log(r, { type: 'system', text: '중단됨 — 메시지를 보내면 이어서 해' });
    } else {
      log(r, { type: 'system', text: '사용자가 정지(stop)했어' });
      end(r, 'stopped');
    }
    json(res, 200, { ok: true });
    return true;
  }
  // 채팅·팝오버 run 하나: 바로 시작하고 done(답)/fail(이유) 로 끝낸다
  function chatRun({ title, text, origin = null, parentId = null, kind = 'chat' }) {
    const parent = parentId ? runs.get(parentId) : null;
    const r = { run: { id: randomUUID(), kind, title: String(title).slice(0, 200), model: 'claude-sonnet', startedAt: new Date().toISOString(), status: 'running', routine: false, cwd: '/Users/me/.cy-agent/brain', ...(origin ? { origin } : {}), ...(parent ? { parentId } : {}) }, events: [] };
    runs.set(r.run.id, r);
    changed(r);
    if (parent) { log(parent, { type: 'user', text, injected: true, followUp: true }); changed(parent); }
    log(r, { type: 'user', text: `(맥락 …)\n\n## 지금 사용자가 말했다\n"${text}"` });
    return {
      id: r.run.id,
      done(reply) {
        if (r.run.status !== 'running') return;
        log(r, { type: 'assistant', text: reply });
        log(r, { type: 'result', text: 'ok', costUsd: 0.01 });
        r.run.costUsd = 0.01;
        end(r, 'done');
        if (parent) { log(parent, { type: 'assistant', text: reply, followUp: true }); changed(parent); }
      },
      fail(err) {
        if (r.run.status !== 'running') return;
        end(r, 'failed', err);
        if (parent) { log(parent, { type: 'error', text: err, followUp: true }); changed(parent); }
      },
    };
  }
  const has = (id) => runs.has(id);

  return { handle, active, start, chatRun, has, snapshot: () => ({ active: active() }) };
}
