// 캐릭터 위 알림 팝업(맥 알림처럼 반투명 카드) — 순수 로직: 몇 개를 보일지, 몰려 오면 묶기
// 한 출처에서 burstMs 안에 burstN 개 이상 오면(처음 연결·밀린 알림) 「Slack 새 알림 12개」 한 장으로 묶는다
export const TOAST_DEFAULTS = { max: 3, burstMs: 3000, burstN: 4 };

export function createToastQueue(opts = {}) {
  const o = { ...TOAST_DEFAULTS, ...opts };
  let toasts = [];            // [{ id, item } | { id, summary: { source, n, latest } }]
  const recent = new Map();   // source → 최근 도착 시각들

  function push(item, now = Date.now()) {
    if (!item || typeof item.id !== 'string') return toasts;
    const src = item.source || 'system';
    const times = (recent.get(src) ?? []).filter((t) => now - t < o.burstMs);
    times.push(now);
    recent.set(src, times);
    const sumId = `sum:${src}`;
    const sum = toasts.find((t) => t.id === sumId);
    if (sum) {
      sum.summary = { ...sum.summary, n: sum.summary.n + 1, latest: item };
      toasts = [sum, ...toasts.filter((t) => t !== sum)];
    } else if (times.length >= o.burstN) {
      // 이미 따로 뜬 같은 출처 카드들을 한 장으로 접는다
      const same = toasts.filter((t) => t.item?.source === src);
      toasts = [{ id: sumId, summary: { source: src, n: same.length + 1, latest: item } }, ...toasts.filter((t) => !same.includes(t))];
    } else {
      toasts = [{ id: item.id, item }, ...toasts.filter((t) => t.id !== item.id)];
    }
    toasts = toasts.slice(0, o.max);
    return toasts;
  }
  function remove(id) {
    toasts = toasts.filter((t) => t.id !== id);
    return toasts;
  }
  return { push, remove, list: () => toasts };
}
