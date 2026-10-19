// 알림함 탭: 메일·Slack·캘린더·Claude 에서 온 알림을 출처와 함께. 안 읽은 것은 점, 누르면 읽음 + 링크 열기
// 데이터: GET /inbox (agent/src/inbox.ts) · 바뀌면 SSE inbox → reload
import { relativeTime } from '../src/dashboard.js';
import { INBOX_FILTERS, inboxSourceLabel, inboxIcon } from '../src/inbox.js';

export function createInboxView({ h, cy, el, onUnread }) {
  let filter = '';
  let unreadOnly = false;
  let items = [];
  let bySource = {};
  let visible = false;
  let loading = false;

  async function reload() {
    if (loading) return;
    loading = true;
    const r = await cy.inboxList?.({ source: filter, unread: unreadOnly }).catch(() => null);
    loading = false;
    if (r?.ok && r.data) {
      items = Array.isArray(r.data.items) ? r.data.items : [];
      bySource = r.data.bySource ?? {};
      onUnread?.(Number(r.data.unread) || 0);
    }
    render();
  }

  async function markRead(ids, read = true, source) {
    await cy.inboxRead?.(ids, read, source).catch(() => null);
    reload();
  }

  function chip(id, label) {
    const n = id ? bySource[id] ?? 0 : Object.values(bySource).reduce((a, b) => a + b, 0);
    return h('button.inbox-chip', { type: 'button', 'aria-pressed': String(filter === id), onclick: () => { filter = id; reload(); } },
      label, n ? h('span.inbox-chip-n', { text: String(n) }) : null);
  }

  function row(x) {
    const open = () => {
      if (!x.read) markRead([x.id]);
      cy.inboxOpen?.(x);
    };
    return h('div.inbox-row', { role: 'button', tabindex: '0', dataset: { read: x.read ? '1' : '' }, title: x.link ? '눌러서 원래 화면 열기' : '눌러서 읽음 표시', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
      h('span.inbox-dot', { 'aria-label': x.read ? '읽음' : '안 읽음' }),
      h('span.inbox-icon', { text: inboxIcon(x.source), 'aria-hidden': 'true' }),
      h('div.inbox-main', {},
        h('div.inbox-meta', {},
          h('b.inbox-src', { text: inboxSourceLabel(x.source) }),
          x.account ? h('span.inbox-acct', { text: x.account }) : null,
          h('span.inbox-time', { text: relativeTime(x.at), title: new Date(x.at).toLocaleString('ko-KR') })),
        h('div.inbox-title', { text: x.title }),
        x.body ? h('div.inbox-body', { text: x.body }) : null),
      h('button.ghost.small.inbox-toggle', { type: 'button', title: x.read ? '안 읽음으로' : '읽음으로', onclick: (e) => { e.stopPropagation(); markRead([x.id], !x.read); } }, x.read ? '○' : '✓'));
  }

  function render() {
    if (!visible) return;
    const total = Object.values(bySource).reduce((a, b) => a + b, 0);
    el.replaceChildren(
      h('div.inbox-bar', {},
        h('div.inbox-chips', {}, INBOX_FILTERS.map(([id, label]) => chip(id, label))),
        h('div.inbox-actions', {},
          h('label.inbox-only', {}, h('input', { type: 'checkbox', checked: unreadOnly || null, onchange: (e) => { unreadOnly = e.target.checked; reload(); } }), '안 읽은 것만'),
          h('button.ghost.small', { type: 'button', disabled: total ? null : true, onclick: () => markRead('all', true, filter || undefined) }, '모두 읽음'),
          h('button.ghost.small', { type: 'button', onclick: async () => { await cy.inboxClear?.().catch(() => null); reload(); } }, '읽은 것 지우기'))),
      items.length
        ? h('div.inbox-list', {}, items.map(row))
        : h('div.inbox-empty', {}, h('p', { text: unreadOnly ? '안 읽은 알림이 없어요.' : '아직 알림이 없어요.' }),
            h('p.muted', { text: '메일·Slack·캘린더를 연결하면 여기에 쌓여요. Claude Code 작업이 끝나거나 확인이 필요할 때도 와요.' })),
    );
  }

  return {
    show() { visible = true; reload(); },
    hide() { visible = false; },
    changed() { if (visible) reload(); },
  };
}
