// 읽기 전용 외부 할 일과 오늘 하루 전체 일정. 실패를 빈 목록과 구분한다.
export function createTodaySources({ h, cy, goto }) {
  const el = h('section.today-sources');
  let busy = false;
  let timer = null;
  const note = (text) => h('p.muted', { text });
  const button = (text, fn) => h('button.ghost.small', { type: 'button', text, onclick: fn });
  async function refresh() {
    if (busy) return;
    busy = true;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const results = await Promise.allSettled([
      cy.calendarEvents({ from: start.toISOString(), to: end.toISOString(), fresh: true }),
      cy.notionStatus(),
    ]);
    busy = false;
    const cal = results[0].status === 'fulfilled' && results[0].value?.ok ? results[0].value.data : null;
    const notion = results[1].status === 'fulfilled' && results[1].value?.ok ? results[1].value.data : null;
    const kids = [h('h3', { text: '오늘 전체 일정' }), button('새로고침', refresh), button('연결 관리', () => goto('connect'))];
    if (!cal) kids.push(note('캘린더를 가져오지 못했어요. 연결 상태를 확인해 주세요.'));
    else {
      if (!cal.connected) kids.push(note('캘린더 연결이 필요해요.'));
      for (const c of cal.calendars ?? []) if (c.enabled && c.phase === 'failed') kids.push(note(`${c.name}: ${c.reason || '가져오지 못했어요.'}`));
      if (cal.reason) kids.push(note(cal.reason));
      const events = [...(cal.events ?? [])].sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start));
      if (cal.connected && !events.length && cal.ok !== false) kids.push(note('오늘 등록된 일정이 없어요.'));
      kids.push(...events.map((e) => h('p', {}, h('strong', { text: e.allDay ? '종일 ' : `${new Date(e.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} ` }), h('span', { text: e.title }), h('small.muted', { text: ` · ${(cal.calendars ?? []).find((c) => c.id === e.calId)?.name || '캘린더'}` }))));
    }
    kids.push(h('h3', { text: '노션 할 일 · 접근을 허용한 전체 페이지' }));
    if (!notion) kids.push(note('노션 상태를 가져오지 못했어요.'));
    else if (!notion.connected) kids.push(note('노션 연결 전이에요. 연결 관리에서 통합을 연결하고 노션 페이지에 접근을 허용해 주세요.'));
    else {
      if (notion.phase === 'failed' || notion.warning) kids.push(note(`일부 내용이 최신이 아닐 수 있어요: ${notion.error || notion.warning}`));
      if (!notion.at) kids.push(note('노션을 처음 읽고 있어요. 잠시 뒤 새로고침해 주세요.'));
      const tasks = [...(notion.tasks ?? [])].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
      if (notion.at && notion.phase === 'ok' && !notion.warning && !tasks.length) kids.push(note('공유된 페이지에서 미완료 할 일을 찾지 못했어요. 노션의 연결 권한도 확인해 주세요.'));
      kids.push(...tasks.map((t) => h('div.card', {}, h('strong', { text: t.title }), note(`${t.page}${t.due ? ` · 마감 ${t.due.slice(0, 10)}` : ' · 마감일 없음'}`), button('노션에서 열기', () => cy.openLink(t.url)))));
      kids.push(note('노션의 상태·완료 체크박스가 있는 항목과 미완료 체크리스트를 표시해요. 완료 처리는 노션 원본에서 해 주세요.'));
    }
    el.replaceChildren(...kids);
  }
  return { el, refresh, show() { refresh(); clearInterval(timer); timer = setInterval(refresh, 60_000); }, hide() { clearInterval(timer); timer = null; } };
}
