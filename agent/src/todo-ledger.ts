// 할 일 일지(store.ts todo_ledger) 읽기 도우미: "사용자가 지우거나 끝낸 일" 기억 → 브리핑 맥락·cy todos_list·GET /todos/ledger.
// 기록은 store 의 할 일 변경 경로가 남긴다(added·edited·done·reopened·trashed·restored·purged·progress·blocked·merged, by user|briefing|rule|auto).
import { kstDay, type LedgerAction, type LedgerEntry, type Store, type TodoActor } from "./store.ts";

export const MEMORY_DAYS = 14;
const LIFE: LedgerAction[] = ["added", "done", "reopened", "trashed", "restored", "purged"];

const ACTION_KO: Record<LedgerAction, string> = {
  added: "추가", edited: "수정", done: "완료", reopened: "다시 엶", trashed: "휴지통", restored: "되살림", purged: "영구 삭제",
  progress: "진행", blocked: "되살리기 막음", merged: "합침",
};
const BY_KO: Record<TodoActor, string> = { user: "사용자", briefing: "브리핑", rule: "규칙", auto: "자동" };
export const actionKo = (a: LedgerAction) => ACTION_KO[a] ?? a;
export const byKo = (b: TodoActor) => BY_KO[b] ?? b;

// 지금 지워졌거나 끝난 상태로 남은 일(days 안의 마지막 상태 기준 — 되살리거나 다시 연 건 빠진다), 최신 먼저
export function removedRecently(store: Store, now = new Date(), days = MEMORY_DAYS, limit = 40): LedgerEntry[] {
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const last = new Map<string, LedgerEntry>();
  // 마지막 상태 = 가장 나중에 남긴 기록(n). 시각은 옮긴 때를 따로 받을 수 있어 순서는 n 으로
  for (const e of store.ledger({ since, actions: LIFE, limit: 1000 }).sort((a, b) => b.n - a.n)) if (!last.has(e.todoId)) last.set(e.todoId, e);
  return [...last.values()].sort((a, b) => b.at.localeCompare(a.at) || b.n - a.n).filter((e) => e.action === "trashed" || e.action === "purged" || e.action === "done").slice(0, limit);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const memoryLine = (e: LedgerEntry) => `- ${e.day.slice(5)} ${actionKo(e.action)}(${byKo(e.by)}) id=${e.todoId} ${clip(e.title.replace(/\s+/g, " "), 70)}`;

// 브리핑 맥락용(짧게): 지운 일 먼저(최대 30), 그다음 끝낸 일(최대 15 — 열린 할 일 바로 위 "최근 끝낸 할 일"과 겹쳐도 짧게)
export function ledgerContext(store: Store, now = new Date()): string {
  const xs = removedRecently(store, now, MEMORY_DAYS, 200);
  if (!xs.length) return "";
  const gone = xs.filter((e) => e.action !== "done"), done = xs.filter((e) => e.action === "done");
  return [`## 최근 ${MEMORY_DAYS}일 지우거나 끝낸 할 일 (할 일 일지 — 같은 일이면 다른 key·다른 제목으로도 다시 올리지 마라)`,
    ...gone.slice(0, 30).map(memoryLine), ...done.slice(0, 15).map(memoryLine)].join("\n");
}

// 하루치 일지(GET /todos/ledger) — day 없으면 오늘(KST)
export function ledgerDay(store: Store, day?: string, now = new Date()): { day: string; entries: LedgerEntry[]; days: { day: string; count: number }[] } {
  const d = day ?? kstDay(now);
  return { day: d, entries: store.ledger({ day: d, limit: 500 }), days: store.ledgerDays(30) };
}
