// 캐릭터 위 알림 팝업(맥 알림처럼 반투명 카드) — 순수 로직
// 안 읽은 알림이 기준: 읽음·열기 전에는 사라지지 않는다(앱을 다시 켜도 다시 뜬다). 최신 max 장 + 「N개 더」 한 장
export const TOAST_MAX = 3;

export function toastView(unread, max = TOAST_MAX) {
  const list = (Array.isArray(unread) ? unread : []).filter((x) => x && typeof x.id === 'string' && !x.read);
  return { cards: list.slice(0, max), more: Math.max(0, list.length - max) };
}
