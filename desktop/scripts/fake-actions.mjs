// 가짜 확인 카드(회의 응답) — agent/src/actions.ts 흉내. 실행은 진짜로 보내지 않고 0.8초 뒤 done(제목에 "실패"면 failed).
// GET /actions · GET /actions/:id · POST /actions/:id/confirm|cancel, SSE action, 30분 만료(FAKE_ACTION_TTL_MS)
// 도구 승인(type tool_permission — agent/src/permissions.ts 흉내): requestPermission(kind) 가 카드를 만들고 결정을 기다린다.
// POST /actions/:id/confirm {always} · cancel, 10분(FAKE_PERMISSION_TTL_MS) 무응답 → expired. [항상 허용]은 GET /permissions 규칙으로.
// kind: docs · mail · slack · calendar · bash · edit · write — 미리보기 모양(fields·body)을 하나씩 보여 준다. 아무것도 실제로 하지 않는다.
export const PERMISSION_KINDS = {
  docs: { toolName: 'mcp__docs__upload_document', rule: { tool: 'mcp__docs__upload_document', scope: '', label: 'docs · upload_document' },
    card: { icon: '📄', title: 'docs · upload_document', verb: '실행', question: '**docs.upload_document** 를 실행할까요?', notice: '허용하면 바로 실행돼요(되돌릴 수 없을 수 있어요)',
      fields: [{ label: '제목', value: '테스트' }, { label: '그 밖의 값', value: 'visibility: private' }], body: '테스트 문서입니다. 본문 첫 줄… token=«redacted»', bodyKind: 'text' } },
  mail: { toolName: 'mcp__ms365__send_mail', rule: { tool: 'mcp__ms365__send_mail', scope: '', label: 'ms365 · send_mail' },
    card: { icon: '✉️', title: 'ms365 · send_mail', verb: '실행', question: '**ms365.send_mail** 를 실행할까요?', notice: '허용하면 바로 실행돼요(되돌릴 수 없을 수 있어요)',
      fields: [{ label: '받는 사람', value: 'kim@example.com, lee@example.com' }, { label: '제목', value: '견적 회신' }], body: '안녕하세요, 요청하신 견적 회신드립니다.\n첨부 확인 부탁드려요.', bodyKind: 'text' } },
  slack: { toolName: 'mcp__slack__slack_post_message', rule: { tool: 'mcp__slack__slack_post_message', scope: '', label: 'slack · slack_post_message' },
    card: { icon: '💬', title: 'slack · slack_post_message', verb: '실행', question: '**slack.slack_post_message** 를 실행할까요?', notice: '허용하면 바로 실행돼요(되돌릴 수 없을 수 있어요)',
      fields: [{ label: '채널', value: '#cy-dev (C0123)' }], body: '배포 끝났어요 🎉', bodyKind: 'text' } },
  calendar: { toolName: 'mcp__ms365__respond_event', rule: { tool: 'mcp__ms365__respond_event', scope: '', label: 'ms365 · respond_event' },
    card: { icon: '📅', title: '〈디자인 리뷰〉', when: '10/15 목 10:00', verb: '수락', question: '**수락**으로 응답할까요?', notice: '주최자에게 알림이 가요', comment: '조금 늦을 수 있어요' } },
  bash: { toolName: 'Bash', rule: { tool: 'Bash', scope: 'npm test', label: 'Bash(npm test …)' },
    card: { icon: '🖥️', title: '테스트 돌리기', verb: '실행', question: '이 명령을 실행할까요?', notice: '허용하면 이 컴퓨터에서 바로 실행돼요',
      fields: [{ label: '위치(cwd)', value: '/Users/me/code/cy-agent/agent' }], body: 'npm test -- --test-name-pattern=permissions', bodyKind: 'code' } },
  edit: { toolName: 'Edit', rule: { tool: 'Edit', scope: '/Users/me/code/cy-agent', label: '파일 편집 — /Users/me/code/cy-agent 안' },
    card: { icon: '✏️', title: '파일 고치기 — panel.css', verb: '파일 고치기', question: '이 파일을 고칠까요?', notice: '허용하면 바로 바뀌어요',
      fields: [{ label: '파일', value: '/Users/me/code/cy-agent/desktop/renderer/panel.css' }], body: '- .todo { padding: 4px; }\n+ .todo { padding: 6px; }', bodyKind: 'diff' } },
  write: { toolName: 'Write', rule: { tool: 'Edit', scope: '/Users/me/code/notes', label: '파일 편집 — /Users/me/code/notes 안' },
    card: { icon: '✏️', title: '파일 쓰기 — todo.md', verb: '파일 쓰기', question: '이 파일을 쓸까요?', notice: '허용하면 바로 바뀌어요',
      fields: [{ label: '파일', value: '/Users/me/code/notes/todo.md' }], body: '# 할 일\n- 견적 회신\n- 디자인 리뷰', bodyKind: 'code' } },
};
export const permissionKindOf = (text) => /문서|docs/i.test(text) ? 'docs' : /메일/.test(text) ? 'mail' : /슬랙|slack|채널/i.test(text) ? 'slack'
  : /고쳐|수정/.test(text) ? 'edit' : /파일.*써|노트/.test(text) ? 'write' : /명령|돌려|npm/i.test(text) ? 'bash' : null;
const VERB = { accept: ['수락', '으로'], decline: ['거절', '로'], tentative: ['미정(잠정 수락)', '으로'] };
const kstWhen = (iso) => {
  const d = new Date(Date.parse(iso) + 9 * 3600e3).toISOString();
  const wd = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${d.slice(0, 10)}T00:00:00Z`).getUTCDay()];
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${wd} ${d.slice(11, 16)}`;
};

// 머지 승인 카드(type pr_merge — agent/src/merge-request.ts 흉내)의 PR 상태. 진짜 gh 는 부르지 않는다
export const fakeMerge = (o = {}) => ({
  number: 268, repo: 'example/speaker', title: '스피커 dev 설정 분리', url: 'https://github.com/example/speaker/pull/268',
  base: 'develop', head: 'cy/feat-speaker-dev-1c7c7a', draft: false, mergeable: 'MERGEABLE', review: '',
  checks: { pass: 3, pending: 1, fail: 0, failing: [] }, ...o,
});

// mergeDecide(mergeId, 'merge'|'decline') → Promise<{ status, body }>: 가짜 머지 기록(fake-daemon merges)에 같은 결정
export function createFakeActions(emit, { mergeDecide, ttlMs = Number(process.env.FAKE_ACTION_TTL_MS) || 30 * 60e3, permTtlMs = Number(process.env.FAKE_PERMISSION_TTL_MS) || 10 * 60e3, execMs = Number(process.env.FAKE_ACTION_EXEC_MS) || 800, onChange } = {}) {
  const all = new Map();
  const waiters = new Map(); // 도구 승인: id → resolve
  const rules = []; // [항상 허용] 규칙
  let ruleSeq = 0;
  let seq = 0;
  const changed = (a) => { emit('action', { action: a }); onChange?.(a); };
  const expire = () => {
    for (const a of all.values()) if (a.status === 'pending' && a.type !== 'pr_merge' && Date.parse(a.expiresAt) <= Date.now()) {
      if (a.type === 'tool_permission') { settle(a, 'expired', '응답이 없어 취소했어요'); continue; }
      Object.assign(a, { status: 'expired', result: { ok: false, message: '30분이 지나 만료됐어요 — 다시 말해 주세요' } });
      changed(a);
    }
  };
  setInterval(expire, 5000).unref?.();

  function propose(meeting, response, ctx = {}) {
    const [verb, ro] = VERB[response] ?? VERB.accept;
    const card = { icon: '📅', title: `〈${meeting.subject}〉`, when: kstWhen(meeting.start), verb, question: `**${verb}**${ro} 응답할까요?`, notice: '주최자에게 알림이 가요', ...(ctx.comment ? { comment: ctx.comment } : {}) };
    const now = new Date();
    const a = {
      id: `act${++seq}`, type: 'calendar_respond', status: 'pending', card,
      summary: `📅 ${card.title} (${card.when}) — ${card.question} ${card.notice}`,
      via: ctx.via ?? 'chat', ...(ctx.threadId ? { threadId: ctx.threadId } : {}), ...(ctx.msgN ? { msgN: ctx.msgN } : {}),
      created: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      _call: { service: 'ms365', tool: 'respond_event', args: { event_id: meeting.id, response: response === 'tentative' ? 'tentativelyAccept' : response, send_response: true, ...(ctx.comment ? { comment: ctx.comment } : {}) } },
    };
    all.set(a.id, a);
    changed(view(a));
    return view(a);
  }
  const view = ({ _call, _rule, ...a }) => a;

  // ── 도구 승인 ──
  function settle(a, status, message, always = false) {
    Object.assign(a, { status, result: { ok: status === 'done', message } });
    if (always && a._rule && !rules.some((r) => r.tool === a._rule.tool && r.scope === a._rule.scope)) rules.unshift({ id: `rule${++ruleSeq}`, ...a._rule, created: new Date().toISOString(), hits: 0 });
    changed(view(a));
    const w = waiters.get(a.id);
    waiters.delete(a.id);
    w?.(status === 'done' ? { behavior: 'allow', always } : { behavior: 'deny' });
  }
  // kind 의 카드를 만들고 { action, decision } — 규칙이 있으면 카드 없이 바로 허용
  function requestPermission(kind, ctx = {}) {
    const k = PERMISSION_KINDS[kind] ?? PERMISSION_KINDS.docs;
    const hit = rules.find((r) => r.tool === k.rule.tool && r.scope === k.rule.scope);
    if (hit) { hit.hits++; hit.lastUsed = new Date().toISOString(); return { action: null, decision: Promise.resolve({ behavior: 'allow', always: false, byRule: true }) }; }
    const now = new Date();
    const card = { ...k.card, always: k.rule.label };
    const a = {
      id: `perm${++seq}`, type: 'tool_permission', status: 'pending', card, toolName: k.toolName,
      summary: `${card.icon} ${card.title} — ${card.question} ${card.notice}`,
      via: ctx.via ?? 'chat', ...(ctx.threadId ? { threadId: ctx.threadId } : {}), ...(ctx.todoId ? { todoId: ctx.todoId } : {}),
      created: now.toISOString(), expiresAt: new Date(now.getTime() + permTtlMs).toISOString(), _rule: k.rule,
    };
    all.set(a.id, a);
    const decision = new Promise((ok) => waiters.set(a.id, ok));
    setTimeout(expire, permTtlMs + 50).unref?.();
    changed(view(a));
    return { action: view(a), decision };
  }
  function decidePermission(a, allow, always) {
    if (a.status !== 'pending') {
      const same = allow ? a.status === 'done' : a.status === 'cancelled';
      return same ? { status: 200, body: { ok: true, already: true, action: view(a) } } : { status: 409, body: { ok: false, error: `already ${a.status}`, action: view(a) } };
    }
    settle(a, allow ? 'done' : 'cancelled', allow ? (always ? `항상 허용으로 저장했어요 — ${a._rule.label}` : '허용했어요') : '거부했어요', allow && always);
    console.log(`  (가짜) 도구 승인 ${allow ? (always ? '항상 허용' : '허용') : '거부'}: ${a.card.title} — 실제로 실행하지 않음`);
    return { status: 200, body: { ok: true, action: view(a) } };
  }
  const running = new Map();

  // ── 머지 승인 카드: 결정은 가짜 머지 기록 하나로(캐릭터 머지 말풍선과 같은 것), 카드는 mirrorMerge 로 따라간다 ──
  function requestMerge(merge, ctx = {}) {
    const now = new Date();
    const card = {
      icon: '🔀', title: `#${merge.number} ${merge.title}`, verb: '머지',
      question: merge.blocked ? `**머지할 수 없어요** — ${merge.blocked}` : `**#${merge.number}** 을(를) 머지할까요?`, notice: merge.blocked ? '' : '✓ 를 누르면 squash 머지하고 브랜치를 지워요', merge,
    };
    const a = {
      id: `merge${++seq}`, type: 'pr_merge', status: 'pending', card, mergeId: ctx.mergeId, summary: `🔀 ${card.title}`,
      via: ctx.via ?? 'chat', ...(ctx.threadId ? { threadId: ctx.threadId } : {}), ...(ctx.msgN ? { msgN: ctx.msgN } : {}),
      created: ctx.at ?? now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 864e5).toISOString(),
      ...(ctx.status ? { status: ctx.status, result: ctx.result } : {}),
    };
    all.set(a.id, a);
    changed(view(a));
    return view(a);
  }
  function mirrorMerge(mergeId, state, extra = {}) {
    for (const a of all.values()) {
      if (a.type !== 'pr_merge' || a.mergeId !== mergeId) continue;
      const to = state === 'merging' ? (['pending', 'failed'].includes(a.status) ? 'running' : null)
        : state === 'merged' ? (['pending', 'running', 'failed'].includes(a.status) ? 'done' : null)
          : state === 'declined' ? (['pending', 'failed'].includes(a.status) ? 'cancelled' : null)
            : state === 'failed' ? (['pending', 'running'].includes(a.status) ? 'failed' : null) : null;
      if (!to) continue;
      a.status = to;
      a.result = to === 'done' ? { ok: true, message: '머지했어요', ...(extra.link ? { link: extra.link } : {}) } : to === 'cancelled' ? { ok: false, message: '머지 안 함' } : to === 'failed' ? { ok: false, message: `머지 실패: ${extra.error ?? '가짜 오류'}` } : undefined;
      changed(view(a));
    }
  }
  async function decideMergeCard(a, decision) {
    if (['done', 'cancelled', 'expired'].includes(a.status)) {
      const same = decision === 'merge' ? a.status === 'done' : a.status === 'cancelled';
      return same ? { status: 200, body: { ok: true, already: true, action: view(a) } } : { status: 409, body: { ok: false, error: `already ${a.status}`, action: view(a) } };
    }
    if (decision === 'merge' && a.card.merge?.blocked) return { status: 409, body: { ok: false, error: a.card.merge.blocked, action: view(a) } };
    if (!mergeDecide) return { status: 409, body: { ok: false, error: '머지 경로가 없어요', action: view(a) } };
    const r = await mergeDecide(a.mergeId, decision);
    return { status: r.status, body: { ...r.body, action: view(a) } };
  }

  function confirm(id, opts = {}) {
    expire();
    const a = all.get(id);
    if (!a) return Promise.resolve({ status: 404, body: { ok: false, error: 'no such action' } });
    if (a.type === 'tool_permission') return Promise.resolve(decidePermission(a, true, opts.always === true));
    if (a.type === 'pr_merge') return decideMergeCard(a, 'merge');
    if (running.has(id)) return running.get(id).then((r) => ({ ...r, body: { ...r.body, already: true } }));
    if (a.status === 'done') return Promise.resolve({ status: 200, body: { ok: true, already: true, action: view(a) } });
    if (a.status !== 'pending') return Promise.resolve({ status: 409, body: { ok: false, error: `already ${a.status}`, action: view(a) } });
    a.status = 'running';
    changed(view(a));
    console.log('  (가짜) 승인된 호출 — 실제로 보내지 않음:', JSON.stringify(a._call));
    const job = new Promise((ok) => setTimeout(() => {
      const fail = /실패/.test(a.card.title);
      Object.assign(a, { status: fail ? 'failed' : 'done', result: fail ? { ok: false, message: '응답 실패: 가짜 오류' } : { ok: true, message: `${a.card.verb}${a.card.verb === '거절' ? '로' : '으로'} 응답했어요` } });
      changed(view(a));
      ok({ status: 200, body: { ok: true, action: view(a) } });
    }, execMs)).finally(() => running.delete(id));
    running.set(id, job);
    return job;
  }
  function cancel(id) {
    expire();
    const a = all.get(id);
    if (!a) return { status: 404, body: { ok: false, error: 'no such action' } };
    if (a.type === 'tool_permission') return decidePermission(a, false, false);
    if (a.type === 'pr_merge') return decideMergeCard(a, 'decline');
    if (a.status === 'cancelled') return { status: 200, body: { ok: true, already: true, action: view(a) } };
    if (a.status !== 'pending') return { status: 409, body: { ok: false, error: `already ${a.status}`, action: view(a) } };
    Object.assign(a, { status: 'cancelled', result: { ok: false, message: '취소했어요' } });
    changed(view(a));
    return { status: 200, body: { ok: true, action: view(a) } };
  }
  const list = ({ threadId } = {}) => { expire(); return [...all.values()].filter((a) => !threadId || a.threadId === threadId).map(view).reverse(); };
  const attach = (id, msgN, threadId) => { const a = all.get(id); if (a) { a.msgN = msgN; if (threadId) a.threadId = threadId; changed(view(a)); } return a && view(a); };

  // 처리했으면 true
  async function handle(req, res, url, json, body = {}) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/permissions') return json(res, 200, { rules }), true;
    const del = req.method === 'POST' && p.match(/^\/permissions\/([\w-]{1,64})\/delete$/);
    if (del) {
      const i = rules.findIndex((r) => r.id === del[1]);
      if (i < 0) return json(res, 404, { error: 'no such rule' }), true;
      rules.splice(i, 1);
      return json(res, 200, { ok: true }), true;
    }
    if (!p.startsWith('/actions')) return false;
    if (req.method === 'GET') {
      if (p === '/actions') return json(res, 200, { actions: list({ threadId: url.searchParams.get('threadId') ?? undefined }) }), true;
      const m = p.match(/^\/actions\/([\w-]{1,64})$/);
      if (!m) return false;
      const a = all.get(m[1]);
      return (a ? json(res, 200, { action: view(a) }) : json(res, 404, { error: 'no such action' })), true;
    }
    const m = p.match(/^\/actions\/([\w-]{1,64})\/(confirm|cancel)$/);
    if (req.method !== 'POST' || !m) return false;
    if (body && (Object.keys(body).some((k) => k !== 'always') || (body.always !== undefined && typeof body.always !== 'boolean'))) return json(res, 400, { error: 'bad body' }), true;
    const r = m[2] === 'confirm' ? await confirm(m[1], { always: body?.always === true }) : await cancel(m[1]);
    json(res, r.status, r.body);
    return true;
  }
  const pendingPermissions = () => [...all.values()].filter((a) => a.type === 'tool_permission' && a.status === 'pending').map(view);
  return { propose, attach, list, confirm, cancel, handle, requestPermission, pendingPermissions, requestMerge, mirrorMerge, rules: () => rules };
}
