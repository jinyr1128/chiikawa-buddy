// 채팅 입력창 슬래시 명령 자동완성(Claude Code 처럼). 순수 로직만 — 화면은 renderer/slash-menu.js.
// 목록은 GET /commands → { commands: [{ name, description, argumentHint }] }

export const MENU_MAX = 8; // 한 번에 보여 줄 후보 수

// 데몬 응답 → [{ name, description, argumentHint }] (모양이 틀린 줄은 버림, 이름 겹치면 처음 것)
export function cleanCommands(data) {
  const list = Array.isArray(data?.commands) ? data.commands : Array.isArray(data) ? data : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name || /\s/.test(name) || name.length > 100 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      description: typeof c.description === 'string' ? c.description.trim().slice(0, 300) : '',
      argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint.trim().slice(0, 120) : '',
    });
  }
  return out;
}

// 입력이 `/` 로 시작하고 아직 공백이 없으면 `/` 뒤 글(빈 글이면 전부), 아니면 null(메뉴 안 띄움)
export function slashQuery(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const q = value.slice(1);
  return /\s/.test(q) ? null : q;
}

// 이름이 q 로 시작하는 것 먼저(원래 순서), 그다음 q 가 들어 있는 것. 대소문자 무시
export function matchCommands(commands, q, max = MENU_MAX) {
  if (!Array.isArray(commands) || typeof q !== 'string') return [];
  const s = q.toLowerCase();
  const prefix = [], inside = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    if (n.startsWith(s)) prefix.push(c);
    else if (s && n.includes(s)) inside.push(c);
  }
  return [...prefix, ...inside].slice(0, max);
}

// 고르면 입력창에 넣을 글
export const completion = (name) => `/${name} `;

// 메뉴 상태: { open, items, index }. 입력이 바뀌면 다시 맞추고, 같은 후보면 고른 자리를 지킨다
export const closedMenu = () => ({ open: false, items: [], index: 0, dismissed: null });

export function menuFor(prev, value, commands) {
  const q = slashQuery(value);
  if (q === null) return closedMenu();
  if (prev?.dismissed === value) return { ...closedMenu(), dismissed: value }; // Esc 로 닫은 그대로면 다시 안 띄움
  const items = matchCommands(commands, q);
  if (!items.length) return closedMenu();
  const keep = prev?.open ? items.findIndex((c) => c.name === prev.items[prev.index]?.name) : -1;
  return { open: true, items, index: keep >= 0 ? keep : 0, dismissed: null };
}

// 메뉴가 열렸을 때 키 → 'up' | 'down' | 'complete' | 'close' | null(입력창이 처리). 한글 조합 중엔 손대지 않는다
export function menuKey(e, menu) {
  if (!menu?.open || !e || e.isComposing || e.keyCode === 229) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'ArrowDown') return 'down';
  if (e.key === 'ArrowUp') return 'up';
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return 'complete';
  if (e.key === 'Escape') return 'close';
  return null;
}

// 키를 메뉴에 적용 → { menu, insert? }(insert 면 입력창 글을 그것으로)
export function applyMenuKey(menu, key, value) {
  const n = menu.items.length;
  if (key === 'down') return { menu: { ...menu, index: (menu.index + 1) % n } };
  if (key === 'up') return { menu: { ...menu, index: (menu.index - 1 + n) % n } };
  if (key === 'close') return { menu: { ...closedMenu(), dismissed: value } };
  if (key === 'complete') {
    const c = menu.items[menu.index];
    return c ? { menu: closedMenu(), insert: completion(c.name) } : { menu: closedMenu() };
  }
  return { menu };
}

// 목록 캐시(렌더러 하나에 하나): 처음 쓸 때 불러오고, 실패했거나 빈 목록이면 1분 뒤 다시, 아니면 10분 동안 그대로
export function createCommandCache(fetchList, { now = Date.now, ttlMs = 10 * 60_000, retryMs = 60_000 } = {}) {
  let list = [], at = -Infinity, ok = false, loading = null;
  return {
    get: () => list,
    async load() {
      if (now() - at < (ok ? ttlMs : retryMs)) return list;
      loading ??= (async () => {
        try {
          const r = await fetchList();
          const data = r && typeof r === 'object' && 'ok' in r ? (r.ok ? r.data : null) : r;
          if (data) { list = cleanCommands(data); ok = list.length > 0; } else ok = false;
        } catch { ok = false; }
        at = now();
        loading = null;
        return list;
      })();
      return loading;
    },
  };
}

// 창이 직접 처리하는 명령(세션 창 /btw 등)을 데몬 목록 앞에 — 이름이 겹치면 창 것
export function withExtra(commands, extra) {
  const ex = cleanCommands({ commands: Array.isArray(extra) ? extra : [] });
  if (!ex.length) return commands ?? [];
  const names = new Set(ex.map((c) => c.name.toLowerCase()));
  return [...ex, ...(commands ?? []).filter((c) => !names.has(c.name.toLowerCase()))];
}
