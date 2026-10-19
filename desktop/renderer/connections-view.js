// 연결 관리: 연결마다 카드 하나 — 지금 상태(초록·회색·주황) + 그 자리에서 끝나는 연결 버튼/입력칸. 터미널은 쓰지 않는다.
// AI 작업(Claude Code·Codex·Hermes) · Slack · 메일 · 캘린더 · 노션 · GitHub
import { MAIL_SERVICES, mailConnectBody, mailFormCheck, guessService } from '../src/mail-connect.js';
import { SLACK_APP_URL } from '../src/setup.js';

const APP_PW = { gmail: 'https://myaccount.google.com/apppasswords', naver: 'https://nid.naver.com/user2/help/myInfoV2?m=viewSecurity&lang=ko_KR', daum: 'https://accounts.kakao.com/weblogin/account/security' };

export function createConnectionsView({ h, cy, el }) {
  let visible = false;
  let d = { ov: null, local: null, cals: [], mac: null, macErr: '' };
  const ui = { open: '', busy: '', msg: {}, slackToken: '', mail: { service: 'gmail', user: '', password: '' }, notion: { token: '', email: '' }, ical: { name: '', url: '' } };

  async function load() {
    const [ov, local, cals] = await Promise.all([
      cy.connectionsOverview?.().catch(() => null),
      cy.localIntegrations?.().catch(() => null),
      cy.calendarList?.().catch(() => null),
    ]);
    d.ov = ov?.ok ? ov.data : d.ov;
    d.local = local ?? d.local;
    d.cals = cals?.ok && Array.isArray(cals.items) ? cals.items : d.cals;
    if (!ui.notion.email) ui.notion.email = d.ov?.mail?.accounts?.[0]?.user ?? '';
    render();
  }
  const say = (key, ok, text) => { ui.msg[key] = { ok, text }; render(); };
  const run = async (key, fn) => {
    if (ui.busy) return;
    ui.busy = key; render();
    try { await fn(); } finally { ui.busy = ''; await load(); }
  };

  // ---- 작은 조각 ----
  const btn = (label, cls, fn, opts = {}) => h(`button.${cls || 'ghost'}`, { type: 'button', disabled: opts.disabled || null, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  const link = (label, url) => btn(label, 'ghost', () => cy.openLink(url));
  const input = (key, obj, field, attrs = {}) => {
    const i = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs, value: obj[field] ?? '' });
    i.addEventListener('input', () => { obj[field] = i.value; });
    return i;
  };
  const msg = (key) => { const m = ui.msg[key]; return m ? h(m.ok ? 'p.conn-ok' : 'p.conn-err', { text: m.text }) : null; };
  const steps = (xs) => h('ol.conn-steps', {}, xs.map((t) => h('li', { text: t })));
  function card({ key, icon, title, tone, status, body, actions }) {
    const open = ui.open === key;
    const head = h('div.conn-head', { onclick: () => { ui.open = open ? '' : key; render(); } },
      h('span.conn-icon', { text: icon }),
      h('div.conn-title', {}, h('b', { text: title }), h(`span.conn-status.${tone}`, {}, h('i'), status)),
      h('div.conn-actions', { onclick: (e) => e.stopPropagation() }, ...(actions ?? [])),
      h('span.conn-chev', { text: open ? '▾' : '▸' }));
    return h(`section.conn-card${open ? '.open' : ''}`, {}, head, open ? h('div.conn-body', {}, ...[body].flat().filter(Boolean), msg(key)) : msg(key));
  }

  // ---- 카드들 ----
  function aiCard() {
    const l = d.local ?? {};
    const codex = d.ov?.codex?.available;
    const on = [l.claudeHooks && 'Claude Code', codex && 'Codex', l.hermes?.on && 'Hermes'].filter(Boolean);
    const row = (name, state, desc, action) => h('div.conn-row', {}, h('div', {}, h('b', { text: name }), h('small', { text: desc })), h(`span.conn-status.${state ? 'ok' : 'off'}`, {}, h('i'), state ? '켜짐' : '꺼짐'), action);
    return card({
      key: 'ai', icon: '🤖', title: 'AI 작업 연동', tone: on.length ? 'ok' : 'off', status: on.length ? `${on.join(' · ')} 연결됨` : '꺼짐',
      body: [
        h('p.conn-blurb', { text: 'AI 가 일하는 동안 캐릭터가 같이 움직이고, 끝나거나 확인이 필요하거나 토큰이 다 되면 알려 줘요.' }),
        row('Claude Code', !!l.claudeHooks, '터미널·Claude 데스크톱(Code 탭)·IDE. 켜면 새 대화부터 적용.', btn(l.claudeHooks ? '끄기' : '켜기', l.claudeHooks ? 'ghost' : 'primary', () => run('ai', async () => { await cy.claudeHooksSet?.(!l.claudeHooks); }))),
        row('Codex', !!codex, codex ? 'ChatGPT 앱의 Codex 기록을 자동으로 지켜봐요(설정 필요 없음).' : 'Codex(ChatGPT 앱)를 쓰면 자동으로 연결돼요.', null),
        l.hermes?.available ? row('Hermes', !!l.hermes.on, '켠 뒤 Hermes 를 한 번 다시 켜면 적용.', btn(l.hermes.on ? '끄기' : '켜기', l.hermes.on ? 'ghost' : 'primary', () => run('ai', async () => { const r = await cy.hermesHooksSet?.(!l.hermes.on); if (r && !r.ok) say('ai', false, r.error); }))) : null,
      ],
    });
  }

  function slackCard() {
    const s = d.ov?.slack ?? {};
    const ok = s.connected && !s.error;
    const tokenRow = (label) => h('div.conn-form', {},
      h('label', {}, h('span', { text: 'User OAuth Token (xoxp-…)' }), input('slack', ui, 'slackToken', { type: 'password', placeholder: 'xoxp-…' })),
      btn(ui.busy === 'slack' ? '확인하는 중…' : label, 'primary', () => run('slack', async () => {
        const r = await cy.slackConnect?.(ui.slackToken.trim());
        const v = r?.data ?? {};
        if (r?.ok && v.ok) { ui.slackToken = ''; say('slack', true, `${v.team} 의 ${v.user} 로 연결했어요.${v.canReply ? ' 답장도 할 수 있어요.' : ''} 잠시 뒤 DM·멘션이 알림함에 들어와요.`); }
        else say('slack', false, v.error || '연결하지 못했어요.');
      }), { disabled: ui.busy === 'slack' }));
    const body = ok ? [
      h('p.conn-blurb', { text: `${s.team} 워크스페이스의 ${s.user} 로 연결돼 있어요. 5분마다 새 DM·나를 부른 멘션을 알림함으로 가져와요.` }),
      s.canReply ? h('p.conn-ok', { text: '알림 카드에서 바로 답장할 수 있어요.' }) : h('details.conn-more', {},
        h('summary', { text: '바로 답장하려면(권한 추가)' }),
        steps(['아래 「Slack 앱 설정 열기」 → 치이카와 매니저 앱 → OAuth & Permissions', 'User Token Scopes(봇 쪽 아님)에 chat:write 추가', '맨 위 노란 안내의 Reinstall → 허용', '새 User OAuth Token 을 Copy 해서 아래에 붙이고 [다시 연결]']),
        link('Slack 앱 설정 열기', 'https://api.slack.com/apps'), tokenRow('다시 연결')),
      btn('연결 해제', 'ghost danger', () => run('slack', async () => { await cy.slackDisconnect?.(); say('slack', true, 'Slack 연결을 끊었어요.'); })),
    ] : [
      h('p.conn-blurb', { text: '읽기 전용 Slack 앱을 하나 만들고 열쇠 하나만 붙이면 끝나요. 회사 워크스페이스는 관리자 승인이 필요할 수 있어요.' }),
      steps(['「Slack 앱 만들기」 → 워크스페이스 고르기 → Next → Create (설정은 채워 둠)', '왼쪽 Install App → Install to Workspace → 허용', 'OAuth & Permissions 의 User OAuth Token 을 Copy', '아래 칸에 붙이고 [연결]']),
      h('div.conn-btns', {}, link('Slack 앱 만들기', SLACK_APP_URL), link('내 Slack 앱 목록', 'https://api.slack.com/apps')),
      tokenRow('연결'),
    ];
    return card({ key: 'slack', icon: '💬', title: 'Slack', tone: ok ? (s.canReply ? 'ok' : 'ok') : s.error ? 'warn' : 'off', status: ok ? `${s.team} · ${s.user}${s.canReply ? ' · 답장 가능' : ''}` : s.error ? s.error : '연결 안 됨', body,
      actions: ok ? [] : [btn('연결하기', 'primary small', () => { ui.open = 'slack'; render(); })] });
  }

  function mailCard() {
    const accs = d.ov?.mail?.accounts ?? [];
    const bad = accs.filter((a) => a.phase === 'failed');
    const svc = MAIL_SERVICES.find((s) => s.id === ui.mail.service) ?? MAIL_SERVICES[0];
    const sel = h('select', { 'aria-label': '메일 서비스' }, MAIL_SERVICES.filter((s) => s.id !== 'custom').map((s) => h('option', { value: s.id, selected: s.id === ui.mail.service || null }, s.title)));
    sel.addEventListener('change', () => { ui.mail.service = sel.value; render(); });
    const user = input('mail', ui.mail, 'user', { inputmode: 'email', placeholder: '아이디@gmail.com' });
    user.addEventListener('change', () => { const g = guessService(ui.mail.user); if (g && g !== ui.mail.service) { ui.mail.service = g; render(); } });
    const add = h('div.conn-form', {},
      h('label', {}, h('span', { text: '서비스' }), sel),
      h('label', {}, h('span', { text: '메일 주소' }), user),
      h('label', {}, h('span', { text: svc.password }), input('mail', ui.mail, 'password', { type: 'password', placeholder: svc.placeholder ?? '' })),
      btn(ui.busy === 'mail' ? '확인하는 중…' : '추가', 'primary', () => {
        const chk = mailFormCheck(ui.mail);
        if (!chk.ok) return say('mail', false, chk.why);
        run('mail', async () => {
          const r = await cy.mailConnect?.(mailConnectBody(ui.mail)).catch(() => null);
          if (r?.ok) { ui.mail.password = ''; ui.mail.user = ''; say('mail', true, '연결했어요. 잠시 뒤 새 메일이 알림함에 들어와요.'); }
          else say('mail', false, r?.error || '연결하지 못했어요.');
        });
      }, { disabled: ui.busy === 'mail' }));
    return card({
      key: 'mail', icon: '✉️', title: '메일', tone: bad.length ? 'warn' : accs.length ? 'ok' : 'off',
      status: accs.length ? `${accs.length}개 계정${bad.length ? ` · ${bad.length}개 확인 필요` : ''}` : '연결 안 됨',
      body: [
        accs.length ? h('ul.conn-list', {}, accs.map((a) => h('li', {}, h(`span.conn-status.${a.phase === 'failed' ? 'warn' : 'ok'}`, {}, h('i')), h('span', { text: a.user }), h('small', { text: a.phase === 'failed' ? a.reason || '못 가져옴' : `최근 ${a.count ?? 0}통` }),
          btn('빼기', 'ghost small', () => run('mail', async () => { await cy.mailRemove?.(a.id); }))))) : null,
        h('p.conn-blurb', { text: '계정마다 「앱 비밀번호」를 만들어 붙여요(계정 비밀번호 아님). 받은 메일을 읽기만 해요.' }),
        h('div.conn-btns', {}, link(`${svc.title} 앱 비밀번호 만들기`, APP_PW[svc.id] ?? APP_PW.gmail)),
        add,
      ],
      actions: [btn('계정 추가', accs.length ? 'ghost small' : 'primary small', () => { ui.open = 'mail'; render(); })],
    });
  }

  function calendarCard() {
    const cals = d.cals ?? [];
    const fails = cals.filter((c) => c.enabled && c.phase === 'failed');
    const macList = d.mac
      ? (d.mac.length ? h('ul.conn-list', {}, d.mac.map((c) => h('li', {}, h('span.conn-dot', { style: c.color ? `background:${c.color}` : null }), h('span', { text: c.title }), h('small', { text: c.account || '맥 캘린더' }),
        btn('추가', 'primary small', () => run('cal', async () => {
          const r = await cy.calendarAdd?.({ name: c.title, url: c.url }).catch(() => null);
          const v = r?.data ?? r ?? {};
          say('cal', !!(r?.ok && v.ok !== false), r?.ok && v.ok !== false ? `「${c.title}」을 추가했어요.` : v.error || '추가하지 못했어요.');
        }))))) : h('p.conn-blurb', { text: '맥 캘린더에 일정 캘린더가 없어요.' }))
      : btn(ui.busy === 'mac' ? '불러오는 중…' : '맥 캘린더 목록 불러오기', 'primary', () => run('mac', async () => {
        const r = await cy.macCalendars?.().catch(() => null);
        if (r?.ok && Array.isArray(r.data?.calendars)) d.mac = r.data.calendars; else say('cal', false, r?.data?.error || '맥 캘린더를 못 읽었어요.');
      }));
    return card({
      key: 'cal', icon: '📅', title: '캘린더', tone: fails.length ? 'warn' : cals.length ? 'ok' : 'off',
      status: cals.length ? `${cals.length}개 연결${fails.length ? ` · ${fails.length}개 확인 필요` : ''} · 회의 알림 30·10분 전` : '연결 안 됨',
      body: [
        cals.length ? h('ul.conn-list', {}, cals.map((c) => h('li', {}, h(`span.conn-status.${!c.enabled ? 'off' : c.phase === 'failed' ? 'warn' : 'ok'}`, {}, h('i')), h('span', { text: c.name }), h('small', { text: !c.enabled ? '꺼 둠' : c.phase === 'failed' ? c.reason || '못 가져옴' : c.meetings != null ? `일정 ${c.meetings}개` : c.label || '' }),
          btn(c.enabled ? '끄기' : '켜기', 'ghost small', () => run('cal', async () => { await cy.calendarToggle?.(c.id, !c.enabled); })),
          btn('빼기', 'ghost small', () => run('cal', async () => { await cy.calendarRemove?.(c.id); }))))) : null,
        h('h4', { text: '맥 캘린더에서 고르기 (추천)' }),
        h('p.conn-blurb', { text: '회사 구글·네이버·iCloud 캘린더를 맥 「캘린더」 앱에 계정으로 추가해 두면, 비공개 주소 없이 여기서 바로 고를 수 있어요.' }),
        steps(['맥 캘린더 앱 → 설정 → 계정 → ＋', '회사 구글: Google 로 로그인 · 네이버: 「기타 CalDAV 계정」 → 서버 caldav.calendar.naver.com', '아래 목록에서 [추가]']),
        h('div.conn-btns', {}, btn('맥 캘린더 앱 열기', 'ghost', () => cy.openMacApp?.('Calendar'))),
        macList,
        h('details.conn-more', {}, h('summary', { text: '또는 iCal 비공개 주소로' }),
          h('div.conn-form', {},
            h('label', {}, h('span', { text: '이름' }), input('cal', ui.ical, 'name', { placeholder: '회사' })),
            h('label', {}, h('span', { text: 'iCal 주소' }), input('cal', ui.ical, 'url', { placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics' })),
            btn('추가', 'primary', () => run('cal', async () => {
              const r = await cy.calendarAdd?.({ name: ui.ical.name.trim(), url: ui.ical.url.trim() }).catch(() => null);
              const v = r?.data ?? r ?? {};
              if (r?.ok && v.ok !== false) { ui.ical = { name: '', url: '' }; say('cal', true, '추가했어요.'); } else say('cal', false, v.error || '추가하지 못했어요.');
            })))),
      ],
      actions: [btn('추가', cals.length ? 'ghost small' : 'primary small', () => { ui.open = 'cal'; render(); })],
    });
  }

  function notionCard() {
    const n = d.ov?.notion ?? {};
    const ok = n.connected;
    return card({
      key: 'notion', icon: '📝', title: '노션', tone: ok ? (n.phase === 'failed' ? 'warn' : 'ok') : 'off',
      status: ok ? (n.phase === 'failed' ? n.error || '못 가져옴' : `마감 임박 ${n.mine ?? 0} · 최근 바뀐 페이지 ${n.recent ?? 0}`) : '연결 안 됨',
      body: ok ? [
        h('p.conn-blurb', { text: `연결한 페이지의 내 할 일 마감·수정·새 댓글을 알려 줘요.${n.email ? ` (${n.email})` : ''} 알림받을 페이지마다 노션에서 ··· → 연결 → 「치이카와 매니저」를 추가해 두세요.` }),
        btn('연결 해제', 'ghost danger', () => run('notion', async () => { await cy.notionDisconnect?.(); say('notion', true, '노션 연결을 끊었어요.'); })),
      ] : [
        steps(['「노션 통합 만들기」 → 새 통합 → 이름 「치이카와 매니저」, 종류 내부', '기능: 콘텐츠 읽기 · 댓글 읽기 · 사용자 정보(이메일 포함) 읽기', '「내부 통합 시크릿」(ntn_…)을 아래에 붙이고 이메일 확인 → [연결]', '알림받을 페이지·DB 에서 ··· → 연결 → 「치이카와 매니저」']),
        h('div.conn-btns', {}, link('노션 통합 만들기', 'https://www.notion.so/profile/integrations')),
        h('div.conn-form', {},
          h('label', {}, h('span', { text: '내부 통합 시크릿' }), input('notion', ui.notion, 'token', { type: 'password', placeholder: 'ntn_…' })),
          h('label', {}, h('span', { text: '노션 로그인 이메일' }), input('notion', ui.notion, 'email', { placeholder: 'me@company.com' })),
          btn(ui.busy === 'notion' ? '확인하는 중…' : '연결', 'primary', () => run('notion', async () => {
            const r = await cy.notionConnect?.({ token: ui.notion.token.trim(), email: ui.notion.email.trim() }).catch(() => null);
            const v = r?.data ?? {};
            if (r?.ok && v.ok !== false) { ui.notion.token = ''; say('notion', true, `「${v.workspace || v.bot || '노션'}」 연결했어요.`); } else say('notion', false, v.error || '연결하지 못했어요.');
          }), { disabled: ui.busy === 'notion' })),
      ],
      actions: ok ? [] : [btn('연결하기', 'primary small', () => { ui.open = 'notion'; render(); })],
    });
  }

  function githubCard() {
    const g = d.ov?.github ?? {};
    return card({
      key: 'github', icon: '🐙', title: 'GitHub', tone: g.loggedIn ? 'ok' : 'off', status: g.loggedIn ? `${g.user} · 리뷰 요청·멘션·머지 알림` : g.installed === false ? 'gh 가 없어요' : '로그인 안 됨',
      body: [
        h('p.conn-blurb', { text: '리뷰 요청·나를 부른 댓글·승인된 내 PR 을 알려 주고, 카드에서 바로 답장·머지할 수 있어요.' }),
        g.loggedIn ? null : steps(['[GitHub 로그인]을 누르면 터미널 창이 열려요', 'Y → Enter → 브라우저에서 코드 입력 → Authorize', '이 화면에서 [새로 고침]']),
        g.loggedIn ? null : h('div.conn-btns', {}, btn('GitHub 로그인', 'primary', () => cy.githubLogin?.()), btn('새로 고침', 'ghost', () => load())),
      ],
      actions: g.loggedIn ? [] : [btn('로그인', 'primary small', () => cy.githubLogin?.())],
    });
  }

  function render() {
    if (!visible) return;
    const cards = [aiCard(), slackCard(), mailCard(), calendarCard(), notionCard(), githubCard()];
    el.replaceChildren(
      h('div.conn-top', {}, h('p.conn-blurb', { text: '카드를 누르면 연결 방법이 펼쳐져요. 초록 = 연결됨 · 주황 = 확인 필요 · 회색 = 안 씀. 열쇠·비밀번호는 이 맥의 설정 파일에만 저장해요.' }), btn('새로 고침', 'ghost small', () => load())),
      ...cards,
    );
  }

  return { show() { visible = true; load(); }, hide() { visible = false; }, changed() { if (visible) load(); } };
}
