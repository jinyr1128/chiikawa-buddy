// 알림함 표시용 순수 함수(패널 탭·캐릭터 배지)
export const INBOX_FILTERS = [['', '전체'], ['mail', '메일'], ['slack', 'Slack'], ['calendar', '캘린더'], ['notion', '노션'], ['claude', 'Claude'], ['codex', 'Codex'], ['hermes', 'Hermes'], ['github', 'GitHub'], ['system', '기타']];
const LABELS = { mail: '메일', slack: 'Slack', calendar: '캘린더', notion: '노션', claude: 'Claude', codex: 'Codex', hermes: 'Hermes', github: 'GitHub', system: '알림' };
const ICONS = { mail: '✉️', slack: '💬', calendar: '📅', notion: '📝', claude: '🤖', codex: '🧠', hermes: '🪽', github: '🐙', system: '🔔' };
export const inboxSourceLabel = (s) => LABELS[s] ?? '알림';
export const inboxIcon = (s) => ICONS[s] ?? '🔔';
// 캐릭터 머리 위 배지 글: 0 이면 숨김, 99 넘으면 99+
export function badgeText(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v ? (v > 99 ? '99+' : String(v)) : '';
}
// 배지 툴팁: 「메일 3 · Slack 2」
export function badgeTitle(bySource) {
  const parts = Object.entries(bySource ?? {}).filter(([, n]) => n > 0).map(([s, n]) => `${inboxSourceLabel(s)} ${n}`);
  return parts.length ? `안 읽은 알림: ${parts.join(' · ')} — 눌러서 보기` : '';
}
