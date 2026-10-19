// 가짜 집중하기(agent/src/focus.ts 흉내) — 가짜 데몬이 쓴다. 기록은 메모리에만.
// GET /focus · POST /focus/start|pause|resume|stop · GET /focus/stats?from&to(days[{date,seconds,longest}]) · SSE focus
// 기록 보기(주·월 잔디)가 비어 보이지 않게 지난 몇 주 기록을 지어 넣는다(날마다 양이 다르고, 쉬는 날도 있다).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATS_MAX_DAYS = 3660;

// 이 맥 로컬 날짜(데몬과 같은 기준)
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function dayStart(day) {
  if (!DAY_RE.test(String(day))) return NaN;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return localDay(t) === day ? t : NaN;
}
const nextDayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };

// 날짜 문자열로 정해지는 의사 난수(돌릴 때마다 같은 그림)
function rand(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 지난 days 일(오늘 빼고) + 오늘 아침 기록. 구간 [{start,end}] (ms)
export function seedSpans(now = Date.now(), days = 70) {
  const spans = [];
  const today = localDay(now);
  for (let back = days; back >= 1; back--) {
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0); t0.setDate(t0.getDate() - back);
    const day = localDay(t0.getTime());
    const r = rand(`focus:${day}`);
    const wd = t0.getDay(); // 0 일 · 6 토
    // 하루 목표(분): 주말은 대개 쉬고, 평일은 날마다 다르게
    let goal;
    const x = r();
    if (wd === 0 || wd === 6) goal = x < 0.55 ? 0 : x < 0.8 ? 10 + r() * 18 : 35 + r() * 40;
    else goal = x < 0.08 ? 0 : x < 0.3 ? 10 + r() * 18 : x < 0.55 ? 32 + r() * 26 : x < 0.85 ? 65 + r() * 50 : 125 + r() * 70;
    let left = Math.round(goal);
    let at = t0.getTime() + (9 + Math.floor(r() * 3)) * 3600e3 + Math.floor(r() * 50) * 60e3;
    while (left >= 5) {
      const len = Math.min(left, Math.round(15 + r() * 55));
      spans.push({ start: at, end: at + len * 60e3 });
      left -= len;
      at += (len + 10 + Math.round(r() * 80)) * 60e3; // 쉬는 틈
    }
  }
  // 오늘: 아침에 한 번(48분) + 잠깐(17분)
  const m = new Date(now); m.setHours(9, 40, 0, 0);
  if (localDay(m.getTime()) === today && m.getTime() + 75 * 60e3 < now) {
    spans.push({ start: m.getTime(), end: m.getTime() + 48 * 60e3 });
    spans.push({ start: m.getTime() + 58 * 60e3, end: m.getTime() + 75 * 60e3 });
  }
  return spans;
}

// emit(event, data) 로 SSE focus·완료 말풍선을 보낸다. now 는 테스트용
export function createFakeFocus({ emit = () => {}, now = () => Date.now(), seed = true } = {}) {
  const spans = seed ? seedSpans(now()) : []; // 닫힌 구간
  let cur = null; // { id, startedAt, paused, closed: [{start,end}], since: number|null }
  let n = 0;

  const closedMs = (c) => c.closed.reduce((s, x) => s + (x.end - x.start), 0);
  function view() {
    const t = now();
    let active = null;
    if (cur) {
      const baseMs = closedMs(cur);
      active = { id: cur.id, startedAt: cur.startedAt, paused: cur.paused, baseMs, since: cur.since, seconds: Math.floor((baseMs + (cur.since ? Math.max(0, t - cur.since) : 0)) / 1000) };
    }
    const day = localDay(t);
    return { active, day, today: stats(day, day)?.total ?? 0, now: t };
  }
  const changed = () => emit('focus', view());

  function allSpans() {
    const t = now();
    return [...spans, ...(cur ? cur.closed : []), ...(cur?.since ? [{ start: cur.since, end: Math.max(cur.since, t) }] : [])];
  }
  function stats(from, to) {
    const a = dayStart(from), z = dayStart(to);
    if (Number.isNaN(a) || Number.isNaN(z) || a > z || (z - a) / 864e5 > STATS_MAX_DAYS) return undefined;
    const end = nextDayStart(z);
    const sec = new Map(), long = new Map();
    for (const s of allSpans()) {
      // 자정을 넘긴 구간은 날마다 나눠 센다
      for (let t = Math.max(s.start, a); t < Math.min(s.end, end); t = nextDayStart(t)) {
        const ms = Math.min(s.end, nextDayStart(t), end) - t;
        const d = localDay(t);
        sec.set(d, (sec.get(d) ?? 0) + ms);
        long.set(d, Math.max(long.get(d) ?? 0, ms));
      }
    }
    const days = [];
    let total = 0;
    for (let t = a; t < end; t = nextDayStart(t)) {
      const date = localDay(t), seconds = Math.floor((sec.get(date) ?? 0) / 1000);
      days.push({ date, seconds, longest: Math.floor((long.get(date) ?? 0) / 1000) });
      total += seconds;
    }
    return { from, to, days, total };
  }

  // 같은 걸 두 번 눌러도 안전
  function start() {
    if (!cur) { const t = now(); cur = { id: `fs-fake${++n}`, startedAt: t, paused: false, closed: [], since: t }; changed(); }
    return view();
  }
  function pause() {
    if (cur && !cur.paused) { const t = now(); cur.closed.push({ start: cur.since, end: Math.max(cur.since, t) }); cur.since = null; cur.paused = true; changed(); }
    return view();
  }
  function resume() {
    if (cur && cur.paused) { cur.since = now(); cur.paused = false; changed(); }
    return view();
  }
  function stop() {
    if (!cur) return { ...view(), stopped: null };
    if (!cur.paused) pause();
    const done = cur;
    spans.push(...done.closed);
    cur = null;
    const seconds = Math.floor(closedMs(done) / 1000);
    changed();
    if (seconds >= 1) emit('bubble', { id: `focus-done:${done.id}`, text: `${duration(seconds)} 집중했어요. 수고했어요!`, kind: 'done', ttlMs: 8000 });
    return { ...view(), stopped: { id: done.id, seconds } };
  }
  const act = (cmd) => (cmd === 'start' ? start() : cmd === 'pause' ? pause() : cmd === 'resume' ? resume() : cmd === 'stop' ? stop() : undefined);

  // 데모용: 집중 중인 것을 ms 만큼 앞당겨 시작한 셈 치기(「집중 중 25:03」 같은 화면)
  function backdate(ms) {
    if (!cur || !(ms > 0)) return view();
    cur.startedAt -= ms;
    if (cur.since) cur.since -= ms;
    else if (cur.closed.length) cur.closed[0].start -= ms;
    changed();
    return view();
  }

  return { view, stats, act, start, pause, resume, stop, backdate };
}

export function duration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}

// HTTP: 처리했으면 true. POST 는 헤더 검사를 마친 뒤 부른다
export function handleFocus(focus, req, res, url, json) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/focus') { json(res, 200, focus.view()); return true; }
  if (req.method === 'GET' && p === '/focus/stats') {
    const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? '';
    const r = DAY_RE.test(from) && DAY_RE.test(to) ? focus.stats(from, to) : undefined;
    json(res, r ? 200 : 400, r ?? { error: 'from/to: YYYY-MM-DD, from <= to' });
    return true;
  }
  const m = req.method === 'POST' && p.match(/^\/focus\/(\w+)$/);
  if (m) {
    const r = ['start', 'pause', 'resume', 'stop'].includes(m[1]) ? focus.act(m[1]) : undefined;
    json(res, r ? 200 : 404, r ?? { error: 'not found' });
    return true;
  }
  return false;
}
