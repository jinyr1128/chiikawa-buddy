// 사용법 둘러보기(설치 마법사가 끝나면 한 번, 메뉴·설정 「사용법 다시 보기」로 언제든) — 순수 로직.
// 캐릭터가 말풍선으로 하나씩 가리킨다. 연결된 것에 맞춰 문구가 바뀌고, 안 된 기능은 "연결하면 이런 것도 돼요"로.
import { TOUR_SAY, tourOf } from './character-say.js';

export const TOUR_VERSION = 1;

// view: brain-state.js brainView 결과
// character: 고른 캐릭터 id — 시사가 아니면 그 캐릭터 말투(character-say.js TOUR_SAY)
// 시사의 둘러보기 글(lines.json 의 tour 와 같은 모양 — 설정 창에서 고치면 이 위에 덮어쓴다)
export const SISA_TOUR = {
  character_ready: '안녕하세요, 시사예요! 저를 **한 번** 누르면 패널, **두 번** 누르면 바로 말 걸 수 있어요. 오른쪽 클릭은 메뉴, 끌어서 옮길 수도 있어요.',
  character_noai: '안녕하세요, 시사예요! 저를 **한 번** 누르면 패널이 열려요. **두 번** 누르면 바로 답해 주는 질문이 떠요. 뇌(AI)를 연결하면 자유롭게 말을 걸 수도 있어요.',
  todos: '패널엔 할 일이 모여요. 줄을 **두 번** 누르면 제목·설명을 바로 고칠 수 있어요. **▶** 로 「진행 중」 표시{slack_on}, 지운 건 **휴지통**에 30일 남아요.',
  todos_slack: ', **새로고침**으로 Slack 새로 읽기',
  chat_ready: '채팅에선 길게 이야기하고 파일도 붙일 수 있어요. 대화는 왼쪽 목록에 남아요.',
  chat_noai: 'AI 없이도 할 일은 정해진 말로 알려 드려요. 뇌(AI)를 연결하면 여기서 자유롭게 대화할 수 있어요.',
  today: '**오늘 할 일** 표예요. 아침마다 적어 달라고 물어볼게요.{cal}',
  today_cal: ' 일정 10분 전엔 춤추며 알려 드려요(설정에서 바꿀 수 있어요).',
  today_nocal: ' 캘린더를 연결하면 일정 전에도 알려 드려요.',
  settings: '설정(⚙)에서 연결·문구·모델·캐릭터를 바꿀 수 있어요.{slack_off} 이 안내는 메뉴 「사용법 다시 보기」로 다시 볼 수 있어요.',
  settings_noslack: ' 슬랙을 연결하면 DM·멘션도 바로 할 일로 만들어요.',
};
const SISA_TOUR_SAY = tourOf(SISA_TOUR);

export function tourSteps(view = {}, character) {
  const ready = view.ready !== false;
  const cal = (view.connected ?? []).includes('calendar');
  const slack = (view.connected ?? []).includes('slack');
  const own = Object.hasOwn(TOUR_SAY, character ?? '') ? TOUR_SAY[character] : SISA_TOUR_SAY;
  const o = { ready, cal, slack };
  const steps = [
    { id: 'character' },
    { id: 'todos', section: 'todos' },
    { id: 'chat', section: 'chat' },
    { id: 'today', section: 'today' },
    { id: 'settings' },
  ];
  return steps.map((s, i) => ({ ...s, text: (own[s.id] ?? SISA_TOUR_SAY[s.id])(o), step: i + 1, total: steps.length }));
}

// 한 장면 → 캐릭터 말풍선
export function tourBubble(s) {
  return { id: 'local-tour', text: `${s.text}`, kind: 'info', ttlMs: 600000, tour: { step: s.step, total: s.total } };
}
