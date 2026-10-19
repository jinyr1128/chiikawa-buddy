// 홈: 열자마자 지금 상황을 한눈에 — 지금 하는 일(Claude·Codex·Hermes) · 확인할 알림 · 오늘 일정 · 오늘 할 일 · 최근 브리핑 · 연결 상태 한 줄
// 연결은 문제 있을 때만 눈에 띄게(초록 점 = 됨, 회색 = 안 씀, 주황 = 확인 필요). 눌러서 「연결 관리」로.
import { inboxIcon, inboxSourceLabel } from '../src/inbox.js';
import { relativeTime } from '../src/dashboard.js';

const KIND = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes' };
const CAP = { calendar: '캘린더', mail: '메일', slack: 'Slack', issues: '이슈' };
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });

export function createHomeView({ h, cy, el, goto, renderMd, who }) {
  let visible = false;
  let data = { activity: null, inbox: [], unread: 0, events: [], notion: null, dnd: null, usage: null };
  let vm = null;
  let timer = null;

  async function load() {
    const now = new Date();
    const end = new Date(now); end.setDate(end.getDate() + 1); end.setHours(23, 59, 0, 0);
    const [act, inbox, cal, notion, dnd, usage] = await Promise.all([
      cy.activity?.().catch(() => null),
      cy.inboxList?.({ unread: true }).catch(() => null),
      cy.calendarEvents?.({ from: new Date(now.getTime() - 3600e3).toISOString(), to: end.toISOString() }).catch(() => null),
      cy.notionStatus?.().catch(() => null),
      cy.dndGet?.().catch(() => null),
      cy.aiUsage?.().catch(() => null),
    ]);
    data = {
      activity: act?.ok ? act.data : null,
      inbox: inbox?.ok && Array.isArray(inbox.data?.items) ? inbox.data.items : [],
      unread: inbox?.ok ? Number(inbox.data?.unread) || 0 : 0,
      events: cal?.ok && Array.isArray(cal.data?.events) ? cal.data.events.filter((e) => e.allDay !== true && Date.parse(e.end) > Date.now()).sort((a, b) => a.start.localeCompare(b.start)) : [],
      notion: notion?.ok ? notion.data : null,
      dnd: dnd ?? null,
      usage: usage?.ok ? usage.data : null,
    };
    render();
  }

  const card = (title, kids, more) => h('section.home-card', {},
    h('div.home-card-head', {}, h('h3', { text: title }), more ?? null), ...kids.flat().filter(Boolean));
  const link = (text, fn) => h('button.ghost.small', { type: 'button', onclick: fn }, text);
  const empty = (text) => h('p.home-empty', { text });

  function nowCard() {
    const runs = (data.activity?.runs ?? []).filter((r) => r && (KIND[r.kind] || r.kind));
    const ai = runs.filter((r) => KIND[r.kind]);
    const rows = ai.map((r) => h('li.home-row', {}, h('span.home-tag', { text: KIND[r.kind] }), h('span.home-row-main', { text: r.title }), h('span.home-row-side', { text: relativeTime(r.startedAt) })));
    const others = runs.filter((r) => !KIND[r.kind]).map((r) => h('li.home-row', {}, h('span.home-tag.muted', { text: '정리' }), h('span.home-row-main', { text: r.title })));
    return card('지금 하는 일', [rows.length || others.length ? h('ul.home-list', {}, rows, others) : empty('지금은 쉬는 중이에요.')]);
  }

  // AI 사용량: 한도 % 막대(5시간·주간) + 다시 차는 시각 + 오늘 쓴 토큰. 터미널(CLI)에선 남은 양이 안 보여서
  function usageCard() {
    const u = data.usage;
    const tok = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString('ko-KR')}만` : `${n || 0}`);
    const when = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      const same = d.toDateString() === new Date().toDateString();
      return `${same ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${fmtTime(iso)} 초기화`;
    };
    const bar = (label, l) => {
      if (!l) return null;
      const tone = l.pct >= 90 ? 'bad' : l.pct >= 70 ? 'warn' : 'ok';
      return h('div.home-usage-row', {},
        h('span.home-usage-label', { text: label }),
        h(`span.home-usage-bar.${tone}`, {}, h('i', { style: `width:${Math.max(2, l.pct)}%` })),
        h('span.home-usage-pct', { text: `${l.pct}%` }),
        h('span.home-row-side', { text: when(l.resetsAt) }));
    };
    const block = (name, t, hint) => {
      if (!t) return null;
      const bars = [bar('5시간', t.fiveHour), bar('주간', t.week)].filter(Boolean);
      return h('div.home-usage', {},
        h('div.home-usage-head', {}, h('b', { text: name }), t.plan ? h('span.home-tag.muted', { text: t.plan }) : null, h('span.home-row-side', { text: `오늘 ${tok(t.todayTokens)} 토큰` })),
        bars.length ? bars : h('p.home-note', { text: hint }));
    };
    if (!u) return card('AI 사용량', [empty('사용량을 아직 못 읽었어요.')]);
    return card('AI 사용량', [
      block('Claude', u.claude, '한도 %는 터미널에서 Claude Code 를 한 번 쓰면 보여요(연결 관리 → Claude Code 연동 켜기).'),
      block('Codex', u.codex, '한도 %는 Codex 를 한 번 쓰면 보여요.'),
    ]);
  }

  function inboxCard() {
    const xs = data.inbox.slice(0, 6);
    const rows = xs.map((x) => h('li.home-row.clickable', { onclick: () => { cy.inboxOpen?.(x); cy.inboxRead?.([x.id]).then(load); } },
      h('span.home-icon', { text: inboxIcon(x.source) }),
      h('span.home-row-main', {}, h('b', { text: `${inboxSourceLabel(x.source)}${x.account ? ` · ${x.account}` : ''}` }), h('span', { text: ` ${x.title}` })),
      h('span.home-row-side', { text: relativeTime(x.at) })));
    return card(`확인할 알림${data.unread ? ` ${data.unread}` : ''}`, [rows.length ? h('ul.home-list', {}, rows) : empty('새 알림이 없어요.')],
      data.unread ? link('알림 모두 보기', () => goto('inbox')) : null);
  }

  function calendarCard() {
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const now = Date.now();
    const rows = data.events.slice(0, 6).map((e) => {
      const live = Date.parse(e.start) <= now;
      const tomorrow = Date.parse(e.start) > todayEnd.getTime();
      return h(`li.home-row${live ? '.live' : ''}`, {},
        h('span.home-time', { text: live ? '진행 중' : `${tomorrow ? '내일 ' : ''}${fmtTime(e.start)}` }),
        h('span.home-row-main', { text: e.title }),
        e.joinUrl ? h('button.ghost.small', { type: 'button', onclick: () => cy.openLink(e.joinUrl) }, '참석') : null);
    });
    return card('오늘·내일 일정', [rows.length ? h('ul.home-list', {}, rows) : empty('남은 일정이 없어요.')], link('캘린더', () => goto('calendar')));
  }

  function todayCard() {
    const items = (vm?.todayItems ?? []).filter((t) => !t.done).slice(0, 6);
    const done = (vm?.todayItems ?? []).filter((t) => t.done).length;
    const rows = items.map((t) => h('li.home-row', {}, h('span.home-dot'), h('span.home-row-main', { text: t.title })));
    const mine = (data.notion?.mine ?? 0) ? h('p.home-note', { text: `노션 마감 임박 ${data.notion.mine}개는 알림함에 있어요.` }) : null;
    return card(`오늘 할 일${items.length ? ` ${items.length}` : ''}${done ? ` · 끝낸 것 ${done}` : ''}`, [rows.length ? h('ul.home-list', {}, rows) : empty('오늘 할 일이 비어 있어요. 브리핑을 돌리면 정리해 드려요.'), mine], link('할 일', () => goto('today')));
  }

  function briefingCard() {
    const b = vm?.briefing;
    const text = b?.md || b?.bubble || '';
    if (!text) return card('최근 브리핑', [empty('아직 브리핑이 없어요. 「지금 브리핑」을 눌러 보세요.')]);
    const body = h('div.home-brief');
    if (renderMd) renderMd(body, text); else body.textContent = text;
    return card(`최근 브리핑${b.at ? ` · ${relativeTime(b.at)}` : ''}`, [body]);
  }

  function connRow() {
    const chips = [];
    const tone = (t) => (t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : 'off');
    for (const c of vm?.connectors ?? []) {
      if (!CAP[c.cap]) continue;
      const on = c.mode !== 'off';
      chips.push({ label: CAP[c.cap], tone: !on ? 'off' : tone(c.ready ? (c.sync?.phase === 'failed' ? 'warn' : 'ok') : 'warn'), hint: c.sync?.reason || '' });
    }
    const n = data.notion;
    chips.push({ label: '노션', tone: !n?.connected ? 'off' : n.phase === 'failed' ? 'warn' : 'ok', hint: n?.error || '' });
    const warn = chips.filter((c) => c.tone === 'warn');
    return h('div.home-conn', {},
      h('span.home-conn-title', { text: warn.length ? `확인이 필요한 연결 ${warn.length}개` : '연결' }),
      ...chips.map((c) => h(`button.home-chip.${c.tone}`, { type: 'button', title: c.hint || (c.tone === 'off' ? '안 씀 — 눌러서 연결' : '연결됨'), onclick: () => goto('connect') }, h('i'), c.label)),
      h('button.ghost.small', { type: 'button', onclick: () => goto('connect') }, '연결 관리'));
  }

  function headRow() {
    const d = new Date();
    const dnd = data.dnd;
    const quiet = dnd?.until && Date.parse(dnd.until) > Date.now();
    return h('div.home-head', {},
      h('div', {}, h('h2', { text: `${who?.() ?? '치이카와'} 매니저` }), h('p.home-date', { text: d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) + (dnd?.meeting ? ' · 회의 중이라 조용히' : quiet ? ` · 방해 금지 ${fmtTime(dnd.until)}까지` : '') })),
      h('div.home-actions', {},
        h('button.ghost', { type: 'button', onclick: async () => { await cy.dndSet?.(quiet ? 0 : 60); load(); } }, quiet ? '방해 금지 끄기' : '방해 금지 1시간'),
        h('button.primary', { type: 'button', onclick: () => { cy.briefingNow?.(); } }, '지금 브리핑')));
  }

  function render() {
    if (!visible) return;
    el.replaceChildren(
      headRow(),
      h('div.home-grid', {}, nowCard(), usageCard(), inboxCard(), calendarCard(), todayCard()),
      briefingCard(),
      connRow(),
    );
  }

  return {
    show() { visible = true; load(); clearInterval(timer); timer = setInterval(load, 15e3); },
    hide() { visible = false; clearInterval(timer); timer = null; },
    setVm(v) { vm = v; render(); },
    changed() { if (visible) load(); },
  };
}
