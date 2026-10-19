// 설치 화면(ai-onboard.js SISA_SAY)과 사용법 둘러보기(tour.js)에서 캐릭터가 하는 말. 시사는 원래 글 그대로.
// 글은 assets/characters/lines.json 의 setup·tour(여기는 그 사본 character-lines.js 에서 꺼낸다).
import { CHARACTER_LINES } from './character-lines.js';

export const SETUP_SAY = Object.fromEntries(Object.entries(CHARACTER_LINES).map(([id, c]) => [id, c.setup ?? {}]));

// 둘러보기 장면 글: tour 의 _ready/_noai 와 {slack_on} {slack_off} {cal} 자리를 채운다. o = { ready, cal, slack }
export function tourOf(t) {
  const fill = (s, o) => String(s ?? '')
    .replace('{slack_on}', o.slack ? (t.todos_slack ?? '') : '')
    .replace('{slack_off}', o.slack ? '' : (t.settings_noslack ?? ''))
    .replace('{cal}', o.cal ? (t.today_cal ?? '') : (t.today_nocal ?? ''));
  return {
    character: (o) => fill(o.ready ? t.character_ready : t.character_noai, o),
    todos: (o) => fill(t.todos, o),
    chat: (o) => fill(o.ready ? t.chat_ready : t.chat_noai, o),
    today: (o) => fill(t.today, o),
    settings: (o) => fill(t.settings, o),
  };
}
export const TOUR_SAY = Object.fromEntries(Object.entries(CHARACTER_LINES).filter(([, c]) => c.tour).map(([id, c]) => [id, tourOf(c.tour)]));
