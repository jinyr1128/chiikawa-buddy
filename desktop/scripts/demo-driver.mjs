// 녹화용 데모 타임라인 — scripts/demo.mjs 가 부른다(직접 실행하지 않음).
// 가짜 데몬(데모 데이터)에 SSE 를 쏘게 하고, Electron 창(오버레이·패널·작업 세션)을 CDP 로 조작한다.
// CDP: --remote-debugging-port 로 연 Electron 에 Node 내장 fetch/WebSocket 으로 붙는다(의존성 없음).
// 마우스·키보드는 Input.dispatch*/insertText 로 진짜 이벤트를 보내고, OS 커서는 안 움직이니
// 데모 동안만 페이지에 가짜 커서(점)를 그려 클릭할 곳으로 움직인다.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { IDS, RUN_TITLE, NEW_TODOS_MD, LOTS_MD, BRIEF_MD } from './demo-data.mjs';

// ---- 타임라인 ----
// est: 녹화 속도(pace 1)에서 대략 걸리는 초. 실제 길이는 각 장면의 기다림·데몬 응답으로 정해진다
export const BEATS = [
  { id: 'idle', title: '대기 — 눈 깜빡임·인사', est: 16 },
  { id: 'nobrain', title: '뇌 연결 전 — 더블클릭하면 춤 + 연결 안내', est: 14 },
  { id: 'setup', title: '설치 마법사 — 이름·뇌 고르기·키·더 연결·끝', est: 44 },
  { id: 'tour', title: '사용법 둘러보기 — 캐릭터가 하나씩 가리킴', est: 40 },
  { id: 'briefing', title: '브리핑 — 공부 영상·진행 보고·할 거 많다', est: 30 },
  { id: 'new-todos', title: '새 할 일 스티커 → 눌러서 패널 할 일', est: 18 },
  { id: 'overview', title: '패널 — 개요·프로젝트·숨기기', est: 30 },
  { id: 'todos', title: '할 일 — 펼침·제목·설명 고치기·규칙·끌기·완료', est: 70 },
  { id: 'today', title: '오늘 할 일 — 표에 적기·체크·저장', est: 22 },
  { id: 'focus', title: '집중하기 — 공부 영상·머리 위 집중 시간·일시정지', est: 26 },
  { id: 'focus-stats', title: '오늘 집중 — 주 막대·월 잔디·날짜 눌러 총·최대 연속', est: 30 },
  { id: 'chat', title: '채팅 — 단계 → 표·콜아웃·색 답 → 프로젝트로', est: 36 },
  { id: 'hover', title: '더블클릭 채팅 — 입력창·생각 중·패널에서 보기', est: 26 },
  { id: 'run', title: '스스로 작업 — 공부 영상·진행 보고·작업 세션 창', est: 44 },
  { id: 'merge', title: '머지 승인 — 추가질문 → ✓ → 머지 완료', est: 30 },
  { id: 'settings', title: '설정 창 — 모델·브리핑 출처·문구·연결 상태', est: 16 },
  { id: 'meeting', title: '일정 10분 전 · 춤', est: 14 },
  { id: 'day', title: '하루 진행 — 절반·제안 승인·오류·여유·다 끝', est: 34 },
  { id: 'outro', title: '마무리 — 작별·연결 끊김·다시 연결', est: 24 },
];

// ---- 속도 설정 — 피드백 받고 여기만 고치면 된다 ----
// beats.<id>: 그 장면 안의 모든 기다림(읽을 시간)에 곱하는 배율. 1보다 크면 그 장면이 느려진다
// typing: 글자당 ms(+0~jitter ms 무작위), 띄어쓰기는 space ms 더. mouse: 이동 ms(거리×perPx, min~max)
// --speed 1.5 = 전체 1.5배 빠르게, 0.7 = 느리게(기다림·타이핑·마우스 모두). --fast = --speed 4
export const TIMING = {
  base: 0.9,                                          // 기다림·간격 기본 배율(작을수록 빠름. 타이핑·마우스엔 안 곱함)
  gaps: { afterBeat: 1800, beforeAction: 700, afterType: 450 }, // 장면 사이 · 동작(클릭·탭·팝오버·끌기·입력 시작) 사이 · 다 친 뒤 Enter 전
  holds: { list: 7000, panel: 4200, bubble: 5500 },   // 다 뜬 뒤 읽을 시간: 목록 말풍선 · 패널 화면 · 글 말풍선
  typing: { msPerChar: 85, jitter: 25, space: 30 },   // 글자당 ~85–110ms
  mouse: { perPx: 1.3, min: 320, max: 950, settle: 220 },
  beats: {
    idle: 1, nobrain: 1, setup: 1, tour: 1, briefing: 1, 'new-todos': 1, overview: 1, todos: 1, today: 1, focus: 1, 'focus-stats': 1,
    chat: 1, hover: 1, run: 1, merge: 1, settings: 1, meeting: 1, day: 1, outro: 1,
  },
};
export const FAST_SPEED = 4;
export const FAST_PACE = 1 / FAST_SPEED;

// argv(노드 인자 제외) → 옵션. 모르는 플래그는 오류
export function parseArgs(argv) {
  const o = { pace: 1, from: null, only: null, loop: false, shots: null, exit: false, port: 47950, cdpPort: 9350, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined || v === '') throw new Error(`${a.split('=')[0]} 에 값이 필요해`);
      return v;
    };
    const flag = a.split('=')[0];
    if (flag === '--fast') o.pace = FAST_PACE;
    else if (flag === '--speed') { const v = Number(val()); if (!(v >= 0.1 && v <= 10)) throw new Error('--speed 는 0.1–10 (1.5 = 빠르게, 0.7 = 느리게)'); o.pace = 1 / v; }
    else if (flag === '--pace') { o.pace = Number(val()); if (!(o.pace > 0 && o.pace <= 10)) throw new Error('--pace 는 0 초과 10 이하'); }
    else if (flag === '--from') o.from = val();
    else if (flag === '--only') o.only = val().split(',').map((x) => x.trim()).filter(Boolean);
    else if (flag === '--loop') o.loop = true;
    else if (flag === '--exit') o.exit = true;
    else if (flag === '--list') o.list = true;
    else if (flag === '--shots') o.shots = val();
    else if (flag === '--port') o.port = Number(val());
    else if (flag === '--cdp-port') o.cdpPort = Number(val());
    else throw new Error(`모르는 옵션: ${a}`);
  }
  for (const k of ['port', 'cdpPort']) if (!Number.isInteger(o[k]) || o[k] < 1024 || o[k] > 65535) throw new Error(`--${k === 'port' ? 'port' : 'cdp-port'} 이 이상해`);
  if (o.port === 47823) throw new Error('47823 은 진짜 데몬 포트야 — 데모는 다른 포트를 써');
  if (o.only && o.from != null) throw new Error('--only 와 --from 은 같이 못 써');
  return o;
}

// --from 값(1부터 번호, id, id 앞부분) → 0부터 인덱스
export function resolveFrom(from, beats = BEATS) {
  if (from == null || from === '') return 0;
  const s = String(from).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 1 || n > beats.length) throw new Error(`--from 은 1–${beats.length}`);
    return n - 1;
  }
  const exact = beats.findIndex((b) => b.id === s);
  if (exact >= 0) return exact;
  const pre = beats.map((b, i) => (b.id.startsWith(s) ? i : -1)).filter((i) => i >= 0);
  if (pre.length === 1) return pre[0];
  throw new Error(`--from "${s}" — ${pre.length ? '여러 장면에 맞아' : '그런 장면이 없어'} (${beats.map((b) => b.id).join(', ')})`);
}

// 돌릴 장면 인덱스: --only(번호·id·앞부분, 쉼표) 또는 --from 부터 끝까지
export function selectBeats({ from = null, only = null } = {}, beats = BEATS) {
  if (only?.length) return [...new Set(only.map((x) => resolveFrom(x, beats)))].sort((a, b) => a - b);
  const start = resolveFrom(from, beats);
  return beats.map((_, i) => i).filter((i) => i >= start);
}

// 계획표: 고른 장면들의 예상 시각(초)·길이. from(숫자)는 예전 호출용
export function plan(beats = BEATS, { from = 0, pace = 1, indices = null, timing = TIMING } = {}) {
  let at = 0;
  const idx = indices ?? beats.map((_, i) => i).filter((i) => i >= from);
  return idx.map((i) => {
    const b = beats[i];
    const dur = Math.round((b.est * (timing.beats?.[b.id] ?? 1) + (timing.gaps?.afterBeat ?? 0) / 1000) * pace * (timing.base ?? 1) * 10) / 10;
    const row = { n: i + 1, id: b.id, title: b.title, at, dur };
    at = Math.round((at + dur) * 10) / 10;
    return row;
  });
}
export const totalOf = (rows) => rows.reduce((s, r) => s + r.dur, 0);

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---- 페이지 안 도우미(가짜 커서·요소 찾기). CSP 때문에 <style> 대신 CSSOM 으로 ----
const HELPER = String(function install() {
  if (window.__demo) return;
  const cur = document.createElement('div');
  const dot = document.createElement('div');
  cur.append(dot);
  Object.assign(cur.style, { position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '2147483647', pointerEvents: 'none', opacity: '0', transition: 'opacity .25s ease' });
  Object.assign(dot.style, {
    position: 'absolute', left: '-11px', top: '-11px', width: '22px', height: '22px', borderRadius: '50%',
    background: 'rgba(255,255,255,.92)', border: '2.5px solid rgba(30,30,40,.85)', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
    transition: 'transform .12s ease, background .12s ease', boxSizing: 'border-box',
  });
  document.documentElement.append(cur);
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const find = (spec) => {
    if (typeof spec === 'string') spec = { sel: spec };
    let root = document;
    if (spec.scope) {
      const scopes = [...document.querySelectorAll(spec.scope)].filter(visible);
      root = spec.has == null ? scopes[0] : scopes.find((s) => s.textContent.includes(spec.has));
      if (!root) return null;
    }
    let els = [...root.querySelectorAll(spec.sel)].filter(visible);
    if (spec.text != null) els = els.filter((e) => e.textContent.includes(spec.text));
    return els[spec.index ?? 0] ?? null;
  };
  window.__demo = {
    find,
    leaks() { return BAD.test(document.documentElement.innerText) || [...document.querySelectorAll('[title],[placeholder],[aria-label]')].some((e) => ['title', 'placeholder', 'aria-label'].some((a) => BAD.test(e.getAttribute(a) ?? ''))); },
    point(spec, reveal) {
      const el = find(spec);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (reveal && (r.top < 56 || r.bottom > innerHeight - 8)) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { scrolling: true };
      }
      return { x: r.left + r.width * (spec.fx ?? 0.5), y: r.top + r.height * (spec.fy ?? 0.5), top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    },
    cursor(x, y, down) {
      cur.style.left = `${x}px`;
      cur.style.top = `${y}px`;
      cur.style.opacity = '1';
      dot.style.transform = down ? 'scale(.78)' : 'scale(1)';
      dot.style.background = down ? 'rgba(107,92,255,.95)' : 'rgba(255,255,255,.92)';
    },
    hide() { cur.style.opacity = '0'; },
    ripple(x, y) {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: `${x - 22}px`, top: `${y - 22}px`, width: '44px', height: '44px', borderRadius: '50%', border: '3px solid rgba(107,92,255,.85)', pointerEvents: 'none', zIndex: '2147483646', boxSizing: 'border-box' });
      document.documentElement.append(r);
      r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => r.remove();
    },
  };
});

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};

// ---- CDP 페이지 하나 ----
class Page {
  constructor(kind, target, pace) {
    this.kind = kind;
    this.target = target;
    this.pace = pace;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.pos = { x: 300, y: 300 };
    this.down = false;
    this.waitPace = pace * TIMING.base; // 간격용
    this.lastAction = 0;
  }

  // 동작 사이 최소 간격(앞 동작이 끝난 뒤 beforeAction 만큼은 쉰다)
  async gap(ms = TIMING.gaps.beforeAction) {
    const need = ms * this.waitPace - (Date.now() - this.lastAction);
    if (need > 0) await sleep(need);
  }
  done() { this.lastAction = Date.now(); }

  async open() {
    const ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 연결 실패 (${this.kind})`)), { once: true });
    });
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${this.kind} 창이 닫혔어`)); }
      this.pending.clear();
    });
    // 창이 키 창이 아니어도 포커스·입력이 그대로 먹게
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return this;
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (process.env.DEMO_DEBUG && !/dispatchMouseEvent|insertText/.test(method)) console.error(`  · ${this.kind} ${method} ${method === 'Runtime.evaluate' ? String(params.expression).slice(-80) : ''}`);
    if (this.closed) return Promise.reject(new Error(`${this.kind} 창이 닫혔어`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 시간 초과`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(${HELPER})(); ${expr}`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.kind}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() { try { this.ws?.close(); } catch { /* 이미 닫힘 */ } }

  wait(ms) { return sleep(Math.max(0, Math.round(ms * this.pace))); }

  // 조건(페이지 식)이 참이 될 때까지
  async waitFor(expr, { timeout = 15000, label = expr } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await this.eval(`(() => { try { return ${expr}; } catch { return false; } })()`).catch(() => false);
      if (v) return v;
      if (Date.now() > end) throw new Error(`${this.kind}: 기다리다 시간 초과 — ${label}`);
      await sleep(150);
    }
  }

  async visible() {
    return (await this.eval('document.visibilityState').catch(() => 'hidden')) === 'visible';
  }

  // 요소 가운데 좌표. 화면 밖이면 부드럽게 스크롤한 뒤 다시 잰다
  async point(spec, { timeout = 8000 } = {}) {
    const s = JSON.stringify(spec);
    const end = Date.now() + timeout;
    for (;;) {
      const p = await this.eval(`__demo.point(${s}, true)`);
      if (p?.scrolling) { await sleep(750); const q = await this.eval(`__demo.point(${s}, false)`); if (q) return q; }
      else if (p) return p;
      if (Date.now() > end) throw new Error(`${this.kind}: 못 찾음 ${s}`);
      await sleep(150);
    }
  }

  async cursorAt(x, y) {
    this.pos = { x, y };
    await this.eval(`__demo.cursor(${x}, ${y}, ${this.down})`);
  }
  hideCursor() { return this.eval('__demo.hide()').catch(() => {}); }

  // 곡선을 따라 천천히(가짜 커서 + 진짜 mouseMoved)
  async moveTo(x, y, { ms } = {}) {
    const { x: x0, y: y0 } = this.pos;
    const dist = Math.hypot(x - x0, y - y0);
    const M = TIMING.mouse;
    const dur = Math.max(80, (ms ?? Math.min(M.max, Math.max(M.min, dist * M.perPx))) * this.pace);
    const steps = Math.max(5, Math.round(dur / 18));
    const nx = dist ? -(y - y0) / dist : 0, ny = dist ? (x - x0) / dist : 0;
    const bend = Math.min(40, dist * 0.08);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const arc = Math.sin(Math.PI * e) * bend;
      const px = x0 + (x - x0) * e + nx * arc, py = y0 + (y - y0) * e + ny * arc;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: this.down ? 'left' : 'none', buttons: this.down ? 1 : 0 });
      await this.cursorAt(px, py);
      await sleep(dur / steps);
    }
  }

  async press(x, y, clickCount = 1) {
    this.down = true;
    await this.eval(`__demo.ripple(${x}, ${y}); __demo.cursor(${x}, ${y}, true)`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  }
  async release(x, y, clickCount = 1) {
    this.down = false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
    await this.eval(`__demo.cursor(${x}, ${y}, false)`).catch(() => {});
  }

  // spec: 선택자 문자열 또는 { sel, text?, scope?, has?, index?, fx?, fy? }
  async click(spec, { double = false, settle = TIMING.mouse.settle } = {}) {
    await this.gap();
    const p = await this.point(spec);
    await this.moveTo(p.x, p.y);
    await sleep(Math.max(60, settle * this.pace));
    await this.press(p.x, p.y, 1);
    await sleep(70);
    await this.release(p.x, p.y, 1);
    if (double) { // 패널은 220ms 안의 두 번째 클릭을 더블클릭으로 본다 — 빠르기는 고정
      await sleep(80);
      await this.press(p.x, p.y, 2);
      await sleep(50);
      await this.release(p.x, p.y, 2);
    }
    this.done();
    return p;
  }

  async hover(spec) {
    const p = await this.point(spec);
    await this.moveTo(p.x, p.y);
    return p;
  }

  // 꾹 눌러(350ms) 끌기. to: 끌기 시작한 뒤 잴 목적지 함수 또는 좌표
  async longPressDrag(spec, to) {
    await this.gap();
    const p = await this.point(spec);
    await this.moveTo(p.x, p.y);
    await sleep(200 * this.pace);
    await this.press(p.x, p.y);
    await sleep(Math.max(600, 900 * this.pace)); // 꾹 — 끌기 시작(LONG_PRESS 350ms)
    const dst = typeof to === 'function' ? await to() : to;
    await this.moveTo(dst.x, dst.y, { ms: 1400 });
    await sleep(Math.max(250, 600 * this.pace));
    await this.release(dst.x, dst.y);
    this.done();
  }

  async type(text, { cps } = {}) {
    await this.gap(TIMING.gaps.beforeAction * 0.6);
    for (const ch of text) {
      await this.send('Input.insertText', { text: ch });
      const T = TIMING.typing;
      const base = cps ? 1000 / cps : T.msPerChar + Math.random() * T.jitter;
      await sleep(Math.max(12, base * this.pace) + (ch === ' ' ? T.space * this.pace : 0));
    }
    this.done();
  }

  async key(name) {
    await this.gap(TIMING.gaps.afterType);
    const k = KEYS[name];
    const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    this.done();
  }

  async scroll(sel, dy) {
    await this.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollBy({ top: ${dy}, behavior: 'smooth' })`);
    await sleep(700);
  }
  async scrollTop(sel) {
    await this.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollTo({ top: 0, behavior: 'smooth' })`);
    await sleep(700);
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 8000);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

// ---- 감독: 데몬 호출 + 창 붙이기 + 신호(큐) ----
export class Director {
  constructor({ daemon, cdp, pace = 1, shots = null, log = console.log }) {
    this.daemon = daemon;
    this.cdp = cdp;
    this.pace = pace;
    this.shots = shots;
    this.log = log;
    this.pages = {};
    this.shown = new Set();
    this.snaps = [];
    this.t0 = Date.now();
    this.beat = null;
    this.shownWin = {}; // 창이 보이는지(숨긴 창도 visibilityState 는 visible 이라 직접 기억)
  }

  clock() { return fmtClock((Date.now() - this.t0) / 1000); }
  cue(text) { this.log(`[${this.clock()}]    ${text}`); }
  scale() { return this.pace * TIMING.base * (TIMING.beats[this.beat] ?? 1); }
  hold(kind) { return this.wait(TIMING.holds[kind]); }
  wait(ms) { return sleep(Math.max(0, Math.round(ms * this.scale()))); }
  ttl(ms) { return Math.max(3000, Math.round(ms * this.scale())); }

  async post(p, body = {}) {
    const r = await fetch(`${this.daemon}${p}`, { method: 'POST', headers: { 'X-CY-Agent': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${text.slice(0, 120)}`);
    return text ? JSON.parse(text) : {};
  }
  async get(p) {
    const r = await fetch(`${this.daemon}${p}`, { signal: AbortSignal.timeout(8000) });
    return r.json();
  }
  emit(event, data) { return this.post('/demo/emit', { event, data }); }
  async bubble(b) { this.shown.add(b.id); await this.park(); return this.emit('bubble', b); }
  clear(id) { this.shown.delete(id); return this.emit('clear', { id }); }
  async clearAll() { for (const id of [...this.shown]) await this.clear(id); }
  mood(m) { return this.post('/demo/mood', { mood: m }); }
  activity(k) { return this.post(`/fake/activity/${k}`); }

  // 창(CDP 대상) 찾기 — 패널·세션 창은 처음 열 때 생긴다
  async attach(kind, { timeout = 15000 } = {}) {
    const cur = this.pages[kind];
    if (cur && !cur.closed) return cur;
    const file = { overlay: 'index.html', panel: 'panel.html', session: 'session.html', settings: 'settings.html' }[kind];
    const end = Date.now() + timeout;
    for (;;) {
      const list = await fetch(`${this.cdp}/json/list`).then((r) => r.json()).catch(() => []);
      const t = list.find((x) => x.type === 'page' && x.url.includes(`/renderer/${file}`));
      if (t) {
        const p = await new Page(kind, t, this.pace).open();
        await p.eval('0').catch(() => {}); // 도우미(문구 바꾸기 포함) 바로 설치
        p.pos = { overlay: { x: 320, y: 300 }, panel: { x: 720, y: 600 }, session: { x: 860, y: 640 }, settings: { x: 600, y: 600 } }[kind];
        this.pages[kind] = p;
        return p;
      }
      if (Date.now() > end) throw new Error(`${kind} 창을 못 찾았어`);
      await sleep(250);
    }
  }
  overlay() { return this.attach('overlay'); }
  panel() { return this.attach('panel'); }
  session() { return this.attach('session'); }
  settings() { return this.attach('settings'); }
  has(kind) { return !!this.pages[kind] && !this.pages[kind].closed; }
  isShown(kind) { return this.has(kind) && this.shownWin[kind] !== false; }

  // 가짜 커서를 이 창에만
  async focus(page) {
    for (const p of Object.values(this.pages)) if (p !== page && !p.closed) await p.hideCursor();
    if (page.kind === 'overlay' && !page.parked) page.pos = { ...REST };
    await page.cursorAt(page.pos.x, page.pos.y);
    this.cursorOn = page;
  }
  // 말풍선이 뜨기 전에 오버레이 커서를 말풍선 없는 자리로(커서가 말풍선을 가리지 않게)
  async park() {
    const ov = this.pages.overlay;
    if (!ov || ov.closed || this.cursorOn !== ov || ov.down) return;
    if (Math.hypot(ov.pos.x - REST.x, ov.pos.y - REST.y) > 4) await ov.moveTo(REST.x, REST.y, { ms: 500 });
  }

  // 패널을 그 탭으로(안 열려 있으면 데몬 open_panel 로)
  async ensurePanel(section) {
    let pn = this.has('panel') ? this.pages.panel : null;
    if (!pn || !this.isShown('panel')) {
      await this.emit('open_panel', { section });
      pn = await this.panel();
      await sleep(600);
    }
    this.shownWin.panel = true;
    await pn.waitFor(`!document.getElementById('sec-${section}').hidden || (document.querySelector('#nav button[data-section="${section}"]').click(), false)`, { timeout: 5000 }).catch(() => {});
    await this.focus(pn);
    return pn;
  }
  async hidePanel() {
    if (!this.has('panel')) return;
    const pn = this.pages.panel;
    if (this.shownWin.panel !== false) await pn.eval(`document.getElementById('close').click()`).catch(() => {});
    this.shownWin.panel = false;
    await pn.hideCursor();
  }

  async snap(label) {
    if (!this.shots) return;
    const n = String(this.snaps.length + 1).padStart(2, '0');
    const base = path.join(this.shots, `${n}-${label}`);
    const entry = { n: Number(n), label, beat: this.beat, at: this.clock(), files: {} };
    try {
      // 가짜 커서는 스크린샷에서 뺀다(문서용 그림) — 찍은 뒤 제자리에 다시
      const live = Object.values(this.pages).filter((p) => !p.closed);
      for (const p of live) await p.hideCursor();
      await sleep(320);
      const ov = await this.overlay();
      await ov.screenshot(`${base}-overlay.png`);
      entry.files.overlay = `${base}-overlay.png`;
      entry.leak = [];
      for (const [k, p] of Object.entries(this.pages)) if (!p.closed && (await p.eval('__demo.leaks()').catch(() => false))) entry.leak.push(k);
      for (const k of ['settings', 'session', 'panel']) {
        if (!this.isShown(k)) continue;
        await this.pages[k].screenshot(`${base}-${k}.png`);
        entry.files.main = `${base}-${k}.png`;
        entry.main = k;
        break;
      }
      if (this.cursorOn && !this.cursorOn.closed) await this.cursorOn.cursorAt(this.cursorOn.pos.x, this.cursorOn.pos.y);
    } catch (e) { entry.error = e.message; }
    this.snaps.push(entry);
  }

  // 앞 장면 없이 시작해도 되게: 말풍선·활동·기분 정리
  async reset() {
    await this.clearAll();
    await this.activity('idle').catch(() => {});
    await this.mood('idle').catch(() => {});
  }
}

// 오버레이에서 커서를 쉬게 둘 곳 — 캐릭터 오른쪽 아래(말풍선은 캐릭터 위 가운데라 안 겹친다, 창 420×580)
export const REST = { x: 402, y: 548 };
// 오버레이 캐릭터 가운데(창 360×580, 캐릭터 140px 이 아래 가운데)
const CHAR = { sel: '#char-wrap', fy: 0.55 };
const row = (id) => ({ sel: `.todo.row[data-id="${id}"] .t` });
const rowSel = (id) => `.todo.row[data-id="${id}"]`;

// ---- 장면들 ----
const SCENES = {
  async idle(d) {
    await d.reset();
    const ov = await d.overlay();
    await d.focus(ov);
    d.cue('눈 뜨고 깜빡이며 대기');
    await d.wait(4500);
    await d.bubble({ id: 'demo:hello', text: '안녕하세요~ 오늘도 같이 가 봐요! (스이시~사) ☀️', kind: 'info', ttlMs: d.ttl(10000) });
    await d.snap('idle-hello');
    await d.wait(11000);
  },

  async nobrain(d) {
    await d.hidePanel();
    await d.clearAll();
    await d.post('/demo/brain', { ready: false }); // 뇌(AI) 연결 전
    const ov = await d.overlay();
    await d.focus(ov);
    await d.wait(1500);
    d.cue('뇌 연결 전 더블클릭 → 춤 + 「연결하기」 말풍선');
    await ov.click(CHAR, { double: true });
    await ov.waitFor(`document.querySelector('.item[data-id="local-no-brain"] .bubble')`, { timeout: 6000, label: '연결 안내 말풍선' });
    await ov.moveTo(REST.x, REST.y);
    await d.wait(2000);
    await d.snap('nobrain-dance');
    await d.hold('bubble');
  },

  async setup(d) {
    const ov = await d.overlay();
    await d.focus(ov);
    const hasHint = () => ov.eval(`!!document.querySelector('.item[data-id="local-no-brain"] .bubble')`).catch(() => false);
    if (!(await hasHint())) { // 이 장면만 볼 때: 뇌를 끊고 다시 더블클릭
      await d.post('/demo/brain', { ready: false });
      await d.wait(600);
      await ov.click(CHAR, { double: true });
      await ov.waitFor(`document.querySelector('.item[data-id="local-no-brain"] .bubble')`, { timeout: 6000, label: '연결 안내 말풍선' });
    }
    d.cue('「연결하기」 → 설치 마법사의 뇌 고르기');
    await ov.click({ scope: '.item[data-id="local-no-brain"]', sel: '.meta button', text: '연결하기' });
    await ov.hideCursor();
    const pn = await d.panel();
    d.shownWin.panel = true;
    const h1 = (t) => `!document.getElementById('sec-setup').hidden && document.querySelector('#sec-setup h1')?.textContent.includes(${JSON.stringify(t)})`;
    await pn.waitFor(h1('뇌'), { timeout: 8000, label: '뇌 고르기' });
    await d.focus(pn);
    await d.wait(1500);
    d.cue('이전 → 이름 적기');
    await pn.click({ sel: '#sec-setup .setup-bar button', text: '이전' });
    await pn.waitFor(`document.querySelector('#sec-setup input[aria-label="이름"]')`, { label: '이름 칸' });
    await pn.eval(`(() => { const i = document.querySelector('#sec-setup input[aria-label="이름"]'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await pn.click('#sec-setup input[aria-label="이름"]');
    await pn.type('길동');
    await d.snap('setup-name');
    await pn.click({ sel: '#sec-setup .setup-bar button.primary', text: '다음' });
    await pn.waitFor(h1('뇌'), { label: '뇌 고르기' });
    d.cue('뇌 고르기 — 찾은 Claude Code·Codex 는 「찾았어요 ✓」, 키는 붙여 넣고 바로 확인');
    await d.hold('panel');
    await d.snap('setup-brain');
    d.cue('Gemini 키 → 붙여 넣기 화면');
    await pn.click({ sel: '#sec-setup .setup-pick', text: 'Gemini 키' });
    await pn.waitFor(h1('키 만들기'), { label: '키 화면' });
    await d.hold('panel');
    await d.snap('setup-key');
    d.cue('(데모) 키를 확인한 셈 치고 뇌 연결 — 데몬이 바로 반영(재시작 없음)');
    await d.post('/demo/brain', { ready: true, provider: 'gemini' });
    await pn.click({ sel: '#sec-setup .setup-bar button', text: '이전' });
    await pn.waitFor(h1('뇌'), { label: '뇌 고르기' });
    await pn.click({ sel: '#sec-setup .setup-bar button', text: '나중에' });
    await pn.waitFor(h1('더 연결'), { label: '더 연결하기' });
    d.cue('더 연결하기 — 캘린더 ICS · Slack · 레포 폴더(전부 선택)');
    await d.hold('panel');
    await d.snap('setup-extras');
    await pn.click({ sel: '#sec-setup .setup-bar button.primary', text: '다 했어요' });
    await pn.waitFor(h1('준비됐어요'), { label: '끝 화면' });
    d.cue('끝 — 된 것 요약 + 사용법 둘러보기');
    await d.hold('panel');
    await d.snap('setup-done');
  },

  async tour(d) {
    await d.post('/demo/brain', { ready: true });
    const pn = await d.ensurePanel('setup');
    const btn = await pn.eval(`!!Array.from(document.querySelectorAll('#sec-setup .setup-bar button')).find((b) => b.textContent.includes('사용법 둘러보기'))`).catch(() => false);
    d.cue('사용법 둘러보기 시작');
    if (btn) await pn.click({ sel: '#sec-setup .setup-bar button.primary', text: '사용법 둘러보기' });
    else await pn.eval('window.cy.startTour()');
    await pn.hideCursor();
    const ov = await d.overlay();
    const sel = `.item[data-id="local-tour"]`;
    for (let i = 0; i < 8; i++) {
      const ok = await ov.waitFor(`document.querySelector('${sel} .bubble .meta button.primary')`, { timeout: 6000, label: '둘러보기 말풍선' }).catch(() => false);
      if (!ok) break;
      await d.focus(ov);
      await d.hold('bubble');
      await d.snap(`tour-${i + 1}`);
      const last = await ov.eval(`document.querySelector('${sel} .bubble .meta button.primary').textContent.trim() === '끝'`).catch(() => true);
      await ov.click({ scope: sel, sel: '.meta button.primary' });
      await ov.moveTo(REST.x, REST.y);
      if (last) break;
      await d.wait(900);
    }
    await d.hidePanel();
  },

  async briefing(d) {
    await d.clearAll();
    d.cue('브리핑 시작 — 공부 영상');
    await d.mood('thinking');
    await d.activity('studying');
    await d.wait(2500);
    const id = 'progress:briefing';
    for (const text of ['슬랙 훑어보는 중이에요… 📥', '메일 확인하는 중이에요… ✉️', '오늘 일정 보는 중이에~요 📅']) {
      d.cue(`진행 보고: ${text}`);
      await d.bubble({ id, text, kind: 'info', ttlMs: 60000 });
      if (text.startsWith('메일')) await d.snap('briefing-studying');
      await d.wait(3800);
    }
    await d.mood('working');
    await d.bubble({ id, text: '할 일 정리하고 있어요… (집중하는 시사) ✍️', kind: 'info', ttlMs: 60000 });
    await d.wait(3000);
    await d.clear(id);
    await d.activity('idle');
    await d.mood('idle');
    d.cue('브리핑 말풍선');
    await d.bubble({ id: 'demo:brief', text: '브리핑이에요~ 오늘은 회의가 3개에~요. 급한 일은 이렇게 있어요:', kind: 'info', ttlMs: d.ttl(18000), detail: BRIEF_MD });
    await d.emit('dashboard', {});
    await d.wait(2000);
    await d.snap('briefing-list');
    await d.hold('list');
    d.cue('할 거 많다 스티커(lots) + 급한 할 일 표');
    await d.clear('demo:brief');
    await d.bubble({ id: 'demo:lots', image: 'lots', text: '오늘 할 일이 많네요… 급한 것만 8개예요. 하나씩 같이 해 봐요 (비장한 시사)', kind: 'todo', ttlMs: d.ttl(24000), open: { section: 'todos' }, detail: LOTS_MD });
    await d.wait(2500);
    await d.snap('briefing-lots');
    await d.hold('list');
  },

  async 'new-todos'(d) {
    await d.clearAll();
    await d.hidePanel();
    const ov = await d.overlay();
    await d.focus(ov);
    d.cue('새 할 일 스티커(to_do_new) + 긴 말풍선');
    await d.bubble({
      id: 'demo:todo-new', image: 'to_do_new', kind: 'todo', text: '새 할 일이 2개 생겼어요~', ttlMs: 60000, open: { section: 'todos', id: IDS.slackQ },
      detail: NEW_TODOS_MD,
    });
    await d.wait(2500);
    await d.snap('todo-new-bubble');
    await d.hold('list');
    d.cue('말풍선 클릭 → 패널 할 일(그 할 일 펼침)');
    await ov.click({ sel: '.item[data-id="demo:todo-new"] .bubble .text' });
    d.shown.delete('demo:todo-new');
    await ov.moveTo(REST.x, REST.y);
    await ov.hideCursor();
    const pn = await d.panel();
    d.shownWin.panel = true;
    await pn.waitFor(`document.querySelector('${rowSel(IDS.slackQ)}')?.closest('.todo-wrap')?.querySelector('.origin')`, { timeout: 12000, label: '펼친 설명·원본' });
    await d.focus(pn);
    await d.snap('todo-expanded');
    await d.hold('panel');
  },

  async overview(d) {
    const pn = await d.ensurePanel('overview');
    d.cue('개요 — 오늘 커밋·열린 할 일·브리핑');
    await pn.click('#nav button[data-section="overview"]');
    await d.hold('panel');
    await d.snap('overview');
    await pn.scroll('#content', 330);
    await d.wait(4000);
    await pn.scrollTop('#content');
    d.cue('프로젝트 카드');
    await pn.click('#nav button[data-section="projects"]');
    await d.hold('panel');
    await d.snap('projects');
    await pn.scroll('#content', 420);
    await d.wait(2500);
    d.cue('프로젝트 숨기기 — 개인 메모');
    await pn.click({ scope: 'article.card.proj', has: '개인 메모', sel: '.hide-btn' });
    await d.wait(2500);
    d.cue('숨긴 프로젝트 (1) 펼치기');
    await pn.click('.hidden-toggle');
    await d.wait(1000);
    await pn.scroll('#content', 600);
    await d.snap('projects-hidden');
    await d.wait(3500);
    await pn.scrollTop('#content');
  },

  async todos(d) {
    const pn = await d.ensurePanel('todos');
    await pn.click('#nav button[data-section="todos"]');
    await pn.scrollTop('#content');
    await d.wait(2000);

    d.cue('한 번 누르면 설명·원본(커밋)');
    await pn.click(row(IDS.pr128));
    await pn.waitFor(`document.querySelector('${rowSel(IDS.pr128)}')?.closest('.todo-wrap')?.querySelector('.origin')`, { label: 'PR #128 원본' });
    await d.wait(5000);

    d.cue('두 번 누르면 그 자리에서 제목·설명 고치기');
    await pn.click(row(IDS.qa), { double: true });
    await pn.waitFor(`document.activeElement?.matches('.todo-edit input.edit-title')`, { label: '제목 칸' });
    await d.wait(1000);
    await pn.type(' (급한 3건 먼저)');
    await d.wait(600);
    await pn.click('.todo-edit textarea.edit-desc');
    await pn.waitFor(`document.activeElement?.matches('.todo-edit textarea.edit-desc')`, { label: '설명 칸' });
    await pn.type(' 저장 버튼·토글 간격·다크모드 구분선은 이번 배포 전에.');
    await d.wait(900);
    await d.snap('row-edit');
    await pn.key('Enter');
    await d.wait(3000);

    d.cue('규칙 칩 → 목록');
    await pn.scrollTop('#content');
    await pn.click('.rules-chip');
    await d.wait(1000);
    await d.snap('rules-list');
    await d.wait(3500);
    await pn.click('.rules-chip');
    await d.wait(1200);

    d.cue('꾹 눌러 끌기 — P2 → P1 맨 위');
    await pn.longPressDrag(row(IDS.apiKey), async () => {
      const p = await pn.eval(`(() => { const r = document.querySelector('.group[data-priority="1"] .todo.row:not(.drag-src)')?.getBoundingClientRect(); return r && { x: r.left + r.width * 0.45, y: r.top + 3 }; })()`);
      return p ?? { x: 400, y: 200 };
    });
    await d.wait(2500);
    d.cue('끌어서 언젠가·백로그로');
    await pn.eval(`document.querySelector('.group[data-priority="4"]').scrollIntoView({ block: 'end', behavior: 'smooth' })`);
    await sleep(800);
    await pn.longPressDrag(row(IDS.moa57), async () => {
      const p = await pn.eval(`(() => { const r = document.querySelector('.group[data-priority="4"] .card.todos')?.getBoundingClientRect(); return r && { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
      return p ?? { x: 400, y: 560 };
    });
    await d.wait(1500);
    await pn.click('.group[data-priority="4"] .backlog-head');
    await d.wait(1000);
    await d.snap('backlog-open');
    await d.wait(3000);

    d.cue('체크 → 완료 → 최근 완료');
    for (let k = 0; k < 2; k++) {
      await pn.click(`${rowSel(IDS.okr)} input.check`);
      const ok = await pn.waitFor(`!document.querySelector('${rowSel(IDS.okr)}')`, { timeout: 4000, label: '완료 처리' }).then(() => true, () => false);
      if (ok) break;
    }
    await d.wait(2200);
    await pn.eval(`document.querySelector('.group.done')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    await sleep(800);
    await pn.hover({ sel: '.group.done .chip.auto' });
    d.cue('"자동" 칩 — Slack 대화를 보고 자동 완료');
    await d.snap('recent-done');
    await d.hold('panel');
    await pn.scrollTop('#content');
  },

  async today(d) {
    const pn = await d.ensurePanel('today');
    await pn.click('#nav button[data-section="today"]');
    await pn.scrollTop('#content');
    d.cue('오늘 할 일: 할 일 중 오늘로 고른 것, 같은 우선순위 묶음');
    await d.hold('panel');
    d.cue('오늘 할 일 추가(P1)');
    await pn.click('#today-add-input');
    await pn.type('리뷰 코멘트 반영');
    await pn.eval(`(() => { const s = document.querySelector('#sec-today select.prio'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
    await pn.click('#sec-today .todo-add button.primary');
    await d.wait(800);
    await d.snap('today-edit');
    d.cue('체크해서 끝냄');
    await pn.click({ sel: '#sec-today .todo.row input.check', index: 0 });
    await d.wait(600);
    await d.hold('panel');
    await pn.scrollTop('#content');
  },

  // 집중하기: 할 일 탭 [▶ 집중하기] → 캐릭터가 공부 영상, 머리 위에 집중 시간·일시정지·그만하기
  async focus(d) {
    await d.clearAll();
    if ((await d.get('/focus').catch(() => null))?.active) await d.post('/focus/stop'); // 이 장면만 다시 볼 때
    const pn = await d.ensurePanel('todos');
    await pn.click('#nav button[data-section="todos"]');
    await pn.scrollTop('#content');
    d.cue('할 일 탭 [▶ 집중하기]');
    await pn.click('#sec-todos .focus-bar button.focus-start');
    await pn.waitFor(`document.querySelector('#sec-todos .focus-live')`, { timeout: 6000, label: '집중 중 표시' });
    // 그림용: 25분쯤 집중한 셈 치기(말풍선 시계가 「25:0x」)
    await d.post('/demo/focus/backdate', { ms: 25 * 60e3 });
    await d.wait(2500);
    await d.snap('focus-bar');
    await d.hidePanel();
    const ov = await d.overlay();
    await d.focus(ov);
    await ov.waitFor(`!document.getElementById('focus').hidden`, { timeout: 6000, label: '집중 말풍선' });
    d.cue('공부 영상 + 머리 위 「집중 중 25:0x」 · 일시정지 · 그만하기');
    await d.wait(2500);
    await d.snap('focus-study');
    await d.hold('bubble');
    d.cue('일시정지 → 쉬는 시간은 빼고 셈 → 다시 시작');
    await ov.click('#focus-toggle');
    await ov.moveTo(REST.x, REST.y);
    await d.wait(2500);
    await d.snap('focus-paused');
    await d.wait(2000);
    await ov.click('#focus-toggle');
    await ov.moveTo(REST.x, REST.y);
    await d.wait(2000);
  },

  // 할 일 탭 맨 아래 「오늘 집중」 → 주 막대 · 월 잔디, 날짜를 누르면 총·최대 연속
  async 'focus-stats'(d) {
    if (!(await d.get('/focus').catch(() => null))?.active) await d.post('/focus/start');
    const pn = await d.ensurePanel('todos');
    await pn.click('#nav button[data-section="todos"]');
    d.cue('맨 아래 「오늘 집중」 → 기록 보기');
    await pn.eval(`document.querySelector('#sec-todos .focus-foot')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    await sleep(800);
    await pn.click('#sec-todos button.focus-today');
    await pn.waitFor(`document.querySelector('#sec-todos .focus-week, #sec-todos .focus-month')`, { timeout: 8000, label: '집중 기록' });
    const tab = async (label) => {
      const on = await pn.eval(`document.querySelector('#sec-todos .focus-tab.on')?.textContent`);
      if (on !== label) await pn.click({ sel: '#sec-todos .focus-tab', text: label });
    };
    // 주: 기록 카드 끝을 화면 아래에 맞춤(위로 할 일 목록이 조금 보이게). 월: 「오늘 집중」 줄을 맨 위로(카드가 길어서)
    // 월은 목록 끝이라 더 못 내려가면 위 줄이 반쯤 걸리니 아래 여백을 잠깐 늘린다(그림용)
    const reveal = (top) => pn.eval(`(() => { const f = document.querySelector('#sec-todos .focus-foot'), c = document.getElementById('content'); if (!f || !c) return; const cr = c.getBoundingClientRect(), fr = f.getBoundingClientRect(); if (${top}) c.style.paddingBottom = '60vh'; c.scrollBy({ top: ${top} ? fr.top - cr.top - 12 : fr.bottom - cr.bottom + 16, behavior: 'smooth' }); })()`).then(() => sleep(800));
    d.cue('주 — 요일별 막대, 오래 집중한 날 누르기');
    await tab('주');
    await pn.waitFor(`document.querySelector('#sec-todos .focus-week')`, { label: '주 막대' });
    await reveal(false);
    await d.wait(1500);
    await pn.click({ sel: '#sec-todos .fw-col:not(.future):not(.today):has(.fw-bar.lv-4), #sec-todos .fw-col:not(.future):not(.today):has(.fw-bar.lv-3), #sec-todos .fw-col.today' });
    await pn.waitFor(`document.querySelector('#sec-todos .focus-day-detail')`, { label: '그날 한 줄' });
    await reveal(false);
    await pn.moveTo(90, 460); // 스크롤로 마우스 밑에 온 칸이 hover 테두리를 갖지 않게(옆 메뉴 빈 곳)
    await d.wait(1200);
    await d.snap('focus-week');
    await d.hold('panel');
    d.cue('월 — 잔디(진할수록 오래), 날짜 누르면 총·최대 연속');
    await tab('월');
    await pn.waitFor(`document.querySelector('#sec-todos .focus-month')`, { label: '월 잔디' });
    await d.wait(1500);
    d.cue('지난달 — 한 달 내내 쌓인 잔디');
    await pn.click('#sec-todos .focus-nav button[aria-label="이전 달"]');
    await pn.waitFor(`document.querySelectorAll('#sec-todos .fm-cell.lv-4').length > 3`, { label: '지난달 잔디' });
    await reveal(true);
    await d.wait(1200);
    await pn.click({ sel: '#sec-todos .fm-cell.lv-4:not(.future):not(.today)', index: 3 });
    await pn.waitFor(`document.querySelector('#sec-todos .focus-day-detail')`, { label: '그날 한 줄' });
    await reveal(true);
    await pn.moveTo(90, 460);
    await d.wait(1200);
    await d.snap('focus-month');
    await d.hold('panel');
    d.cue('그만하기 → 「N분 집중했어요」');
    await pn.eval(`document.getElementById('content').style.paddingBottom = ''`);
    await pn.scrollTop('#content');
    await d.hidePanel();
    const ov = await d.overlay();
    await d.focus(ov);
    await ov.click('#focus-stop');
    await ov.moveTo(REST.x, REST.y);
    await d.wait(2500);
    await d.snap('focus-done');
    await d.wait(4000);
  },

  async chat(d) {
    const pn = await d.ensurePanel('chat');
    await pn.click('#nav button[data-section="chat"]');
    d.cue('채팅 — 지난 대화(표·콜아웃·색)');
    await d.wait(3500);
    d.cue('질문 입력 → 단계 → 답');
    await pn.click('#chat-input');
    await pn.type('이번 주 릴리스 위험한 거 정리해줘');
    await d.wait(600);
    const before = await pn.eval(`document.querySelectorAll('#chat-log .msg.assistant').length`);
    await pn.key('Enter');
    await pn.waitFor(`document.querySelector('#chat-log .typing')`, { timeout: 8000, label: '단계 표시' }).catch(() => {});
    await d.wait(1500);
    await d.snap('chat-steps');
    await pn.waitFor(`document.querySelectorAll('#chat-log .msg.assistant').length > ${before}`, { timeout: 30000, label: '채팅 답' });
    await d.wait(800);
    await pn.eval(`[...document.querySelectorAll('#chat-log .msg.assistant')].at(-1).scrollIntoView({ block: 'start', behavior: 'smooth' })`);
    await d.wait(1200);
    await d.snap('chat-answer');
    await d.hold('panel');
    await pn.eval(`(() => { const l = document.getElementById('chat-log'); l.scrollTo({ top: l.scrollHeight, behavior: 'smooth' }); })()`);
    await d.wait(3500);
    d.cue('"프로젝트 현황 보여줘" → show 로 프로젝트 탭');
    await pn.click('#chat-input');
    await pn.type('프로젝트 현황 보여줘');
    await d.wait(500);
    await pn.key('Enter');
    await pn.waitFor(`!document.getElementById('sec-projects').hidden`, { timeout: 30000, label: '프로젝트 탭으로' });
    await d.snap('chat-show-projects');
    await d.wait(5000);
  },

  async hover(d) {
    await d.hidePanel();
    await d.clearAll();
    const ov = await d.overlay();
    await d.focus(ov);
    await d.wait(1500);
    d.cue('캐릭터 더블클릭 → 입력창');
    await ov.moveTo(REST.x, REST.y);
    await ov.click(CHAR, { double: true });
    await ov.waitFor(`!document.getElementById('ask').hidden && document.activeElement?.id === 'ask-input'`, { timeout: 8000, label: '클릭 입력창' });
    await d.wait(1200);
    await ov.type('오늘 회의 몇 개야?');
    await d.wait(600);
    await ov.key('Enter');
    d.cue('생각 중 — 머리 위 캡션');
    await ov.moveTo(REST.x, REST.y);
    await ov.waitFor(`!document.getElementById('caption').hidden`, { timeout: 6000, label: '캡션' }).catch(() => {});
    await d.wait(1500);
    await d.snap('hover-thinking');
    await ov.waitFor(`document.querySelector('.item[data-id^="chat-"] .bubble')`, { timeout: 30000, label: '답 말풍선' });
    d.cue('답 말풍선 — "패널에서 보기"');
    await d.hold('bubble');
    await d.snap('hover-reply');
    await ov.click({ scope: '.item[data-id^="chat-"]', sel: '.meta button', text: '패널에서 보기' });
    await ov.hideCursor();
    const pn = await d.panel();
    d.shownWin.panel = true;
    await pn.waitFor(`!document.getElementById('sec-chat').hidden`, { timeout: 8000, label: '패널 채팅 탭' });
    await d.focus(pn);
    await d.wait(5000);
    await d.hidePanel();
  },

  async run(d) {
    await d.hidePanel();
    await d.clearAll();
    const ov = await d.overlay();
    await d.focus(ov);
    const id = 'progress:fix:demo';
    d.cue('스스로 수정 작업 시작 — 공부 영상');
    await d.mood('working');
    await d.bubble({ id, text: `'${RUN_TITLE}' 해 볼게요 — 워크트리 만드는 중이에요 🌿`, kind: 'info', ttlMs: 120000 });
    const { id: runId } = await d.post('/demo/run/start', { title: RUN_TITLE });
    await d.wait(4500);
    await d.bubble({ id, text: '고치는 중이에요… ✏️ SaveButton.tsx', kind: 'info', ttlMs: 120000 });
    await d.wait(3000);
    d.cue('공부 중에 캐릭터 클릭 → 작업 세션 창');
    await ov.click(CHAR, { settle: 60 });
    await ov.moveTo(REST.x, REST.y);
    await ov.hideCursor();
    const ss = await d.session();
    d.shownWin.session = true;
    await ss.waitFor(`document.visibilityState === 'visible' && document.querySelectorAll('#log > *').length > 2`, { timeout: 10000, label: '세션 기록' });
    await d.focus(ss);
    await d.wait(3000);
    d.cue('Edit 줄 펼치기 — diff');
    await ss.waitFor(`[...document.querySelectorAll('details.tool')].some((x) => /SaveButton/.test(x.textContent) && /Edit/.test(x.textContent))`, { timeout: 30000, label: 'Edit 줄' });
    await ss.eval(`document.querySelectorAll('details.group').forEach((g) => { if ([...g.querySelectorAll('details.tool')].some((x) => /SaveButton/.test(x.textContent))) g.open = true; })`);
    await ss.click({ scope: 'details.tool', has: 'SaveButton.tsx', sel: 'summary', fx: 0.3 });
    await d.wait(1500);
    await ss.eval(`[...document.querySelectorAll('details.tool[open] pre.diff')].at(-1)?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    await d.wait(4000);
    await d.snap('session-stream');
    d.cue('세션에 메시지 보내기');
    await ss.click('#input');
    await ss.type('저장됨 문구는 "저장 완료 ✓"로 해줘');
    await d.wait(500);
    await ss.key('Enter');
    await d.wait(5000);
    await d.snap('session-message');
    await d.bubble({ id, text: '테스트 돌리는 중이에~요 🧪', kind: 'info', ttlMs: 120000 });
    // 대본이 끝날 때까지(진행 중 → 완료)
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const r = await d.get(`/runs/${runId}?since=100000`).catch(() => null);
      if (r?.run?.status !== 'running') break;
      await sleep(500);
    }
    await d.wait(1500);
    d.cue('테스트 통과 → PR');
    await d.bubble({ id, text: '테스트 통과했어요! ✅ 푸시했어요 (뿌듯한 시사)', kind: 'info', ttlMs: 120000 });
    await d.wait(3500);
    await d.bubble({ id, text: 'PR 올렸어요 — #131 🚀 (스이시~사)', kind: 'done', ttlMs: d.ttl(8000) });
    await d.mood('idle');
    await d.wait(3000);
    await ss.eval('window.close()').catch(() => {});
    ss.close();
    d.shownWin.session = false;
  },

  async merge(d) {
    await d.hidePanel();
    await d.clearAll();
    const ov = await d.overlay();
    await d.focus(ov);
    d.cue('머지 스티커 — "머지할까?" ✓/✗/추가질문');
    await d.mood('alert');
    const { pid } = await d.post('/demo/merge', { title: RUN_TITLE });
    const item = `.item[data-id="merge:${pid}"]`;
    d.shown.add(`merge:${pid}`);
    await d.wait(2500);
    await d.snap('merge-ask');
    await d.wait(4000);
    d.cue('추가질문');
    await ov.click({ scope: item, sel: '.meta button', text: '추가질문' });
    await ov.moveTo(REST.x, REST.y, { ms: 400 });
    await ov.waitFor(`document.activeElement?.matches('${item} .merge-ask input')`, { timeout: 6000, label: '추가질문 입력' });
    await d.wait(700);
    await ov.type('테스트 다 통과했어? 위험한 건 없고?');
    await d.wait(600);
    await ov.key('Enter');
    await ov.moveTo(REST.x, REST.y);
    await ov.waitFor(`/파일 3개/.test(document.querySelector('${item} .text')?.textContent ?? '')`, { timeout: 20000, label: '추가질문 답' });
    await d.mood('idle');
    await d.wait(6000);
    d.cue('✓ 머지 → 머지했어 🎉');
    await ov.click({ scope: item, sel: '.meta button', text: '머지' });
    await ov.waitFor(`/머지했어요/.test(document.querySelector('${item} .text')?.textContent ?? '')`, { timeout: 20000, label: '머지 완료' });
    await ov.moveTo(REST.x, REST.y);
    await d.wait(2000);
    await d.snap('merge-complete');
    await d.wait(7000);
  },

  // ⚙ 설정 창 — 모델·브리핑 출처·자동 머지·문구·지침·연결 상태, 「사용법 다시 보기」
  async settings(d) {
    const pn = await d.ensurePanel('overview');
    d.cue('⚙ → 설정 창');
    await pn.eval('cy.openSettings()');
    const st = await d.settings();
    d.shownWin.settings = true;
    await st.waitFor(`document.querySelector('#models .row, #models > *')`, { timeout: 8000, label: '설정 창' }).catch(() => {});
    await d.wait(2000);
    await d.snap('settings');
    await d.hold('panel');
    await st.eval('window.close()').catch(() => {});
    d.shownWin.settings = false;
  },

  async meeting(d) {
    await d.clearAll();
    d.cue('일정 10분 전 · 춤 영상 + 회의실 + 온라인 참가');
    const m = (await d.get('/dashboard')).meetings?.[0];
    await d.activity('dancing');
    const hhmm = m ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(m.start)) : '15:00';
    await d.bubble({ id: 'demo:meeting', text: `일정 10분 전이에요! 〈${m?.subject ?? '디자인 싱크'}〉 ${hhmm} · 📍 ${m?.location ?? '회의실 A'} · 온라인 (들뜬 시사)`, kind: 'todo', ttlMs: d.ttl(14000), link: m?.link ?? 'https://teams.microsoft.com/l/meetup-join/demo' });
    await d.wait(3000);
    await d.snap('meeting-dance');
    await d.wait(9000);
    await d.activity('idle');
    await d.wait(1500);
  },

  async day(d) {
    await d.clearAll();
    const ov = await d.overlay();
    await d.focus(ov);
    d.cue('하루 절반 — daily_half_complete');
    await d.bubble({ id: 'demo:half', image: 'daily_half_complete', text: '벌써 절반 했어요! (4/8) 이 페이스 좋아요 💪 (기쁜 시사)', kind: 'done', ttlMs: d.ttl(9000) });
    await d.wait(2500);
    await d.snap('day-half');
    await d.wait(5500);
    d.cue('제안 말풍선 — 승인');
    await d.clear('demo:half');
    await d.mood('alert');
    await d.bubble({ id: 'demo:prop', kind: 'proposal', proposalId: 'p-demo-2', text: '#notes-dev 팀원 질문에 답장 초안 써 뒀어요. 보낼까요?', link: 'https://example.slack.com/archives/C0DEMO1/p1791500000000100' });
    await d.wait(4500);
    await ov.click({ scope: '.item[data-id="demo:prop"]', sel: '.meta button', text: '승인' });
    await ov.moveTo(REST.x, REST.y);
    await d.mood('idle');
    await d.wait(3500);
    d.cue('오류 말풍선');
    await d.bubble({ id: 'demo:err', kind: 'error', text: 'Jira 연결이 끊겼어요 — 토큰이 만료된 것 같아요. 다시 로그인해 주세요 (시무룩한 시사)', ttlMs: d.ttl(8000) });
    await d.wait(2000);
    await d.snap('day-error');
    await d.wait(4000);
    d.cue('여유 — daily');
    await d.clear('demo:prop');
    await d.clear('demo:err');
    await d.bubble({ id: 'demo:daily', image: 'daily', text: '오후엔 회의가 없어~요. 집중 시간 2시간 확보했어요! ☕', kind: 'info', ttlMs: d.ttl(9000) });
    await d.wait(2500);
    await d.snap('day-daily');
    await d.wait(5000);
    d.cue('오늘 할 일 다 끝 — daily_all_complete');
    await d.clear('demo:daily');
    await d.bubble({ id: 'demo:all', image: 'daily_all_complete', text: '오늘 할 일 8개 다 끝냈어요! 최고예요 🎉 (스이시~사)', kind: 'done', ttlMs: d.ttl(12000) });
    await d.wait(2500);
    await d.snap('day-all');
    await d.wait(7000);
  },

  async outro(d) {
    await d.clearAll();
    const ov = await d.overlay();
    await ov.moveTo(REST.x, REST.y);
    await ov.hideCursor();
    d.cue('작별 인사');
    await d.bubble({ id: 'demo:bye', text: '오늘도 수고 많으셨어요! 내일 아침에 브리핑할게요~ 👋 (뿌듯한 시사)', kind: 'info', ttlMs: d.ttl(8000) });
    await d.wait(8000);
    d.cue('연결 끊김 — 흐려지고 눈 감음');
    await d.post('/demo/disconnect', { ms: Math.max(3000, 7000 * d.pace) });
    await ov.waitFor(`document.getElementById('char-wrap').classList.contains('sleepy')`, { timeout: 5000, label: '끊김 표시' }).catch(() => {});
    await d.wait(2500);
    await d.snap('outro-disconnected');
    await ov.waitFor(`!document.getElementById('char-wrap').classList.contains('sleepy')`, { timeout: 30000, label: '다시 연결' });
    d.cue('다시 연결');
    await d.wait(1000);
    await d.bubble({ id: 'demo:back', text: '다시 연결됐어요 — 계속 지켜볼게요 👀 (안심한 시사)', kind: 'info', ttlMs: d.ttl(7000) });
    await d.wait(2000);
    await d.snap('outro-back');
    await d.wait(5000);
  },
};

// 타임라인 실행. 장면 하나가 실패해도 경고만 하고 다음으로
export async function runTimeline({ daemon, cdp, pace = 1, from = 0, indices = null, shots = null, log = console.log }) {
  const d = new Director({ daemon, cdp, pace, shots, log });
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const ov = await d.overlay();
  await ov.waitFor(`!document.getElementById('char-wrap').classList.contains('sleepy')`, { timeout: 20000, label: '데몬 연결' });
  await sleep(1200); // 눈 그림·영상 미리 불러오기
  d.t0 = Date.now();
  const failures = [];
  const order = indices ?? BEATS.map((_, k) => k).filter((k) => k >= from);
  const last = order.at(-1);
  for (const i of order) {
    const b = BEATS[i];
    d.beat = b.id;
    log(`\n━━ [${d.clock()}] ${i + 1}. ${b.title}  (≈${fmtClock(b.est * pace * TIMING.base * (TIMING.beats[b.id] ?? 1))})`);
    try {
      // 장면이 어디서 막혀도 데모 전체가 멈추지 않게(경고만 남기고 다음 장면)
      const limit = Math.max(90, b.est * pace * TIMING.base * 4) * 1000;
      let timer;
      await Promise.race([SCENES[b.id](d), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`장면이 ${Math.round(limit / 1000)}초 넘게 안 끝남`)), limit); })])
        .finally(() => clearTimeout(timer));
      if (i !== last) await sleep(TIMING.gaps.afterBeat * pace * TIMING.base); // 다음 장면 전에 숨 고르기
    } catch (e) {
      failures.push({ beat: b.id, error: e.message });
      log(`   ⚠ ${b.id}: ${e.message}`);
      for (const p of Object.values(d.pages)) p.down = false;
    }
  }
  const elapsed = (Date.now() - d.t0) / 1000;
  log(`\n━━ [${d.clock()}] 끝 — ${fmtClock(elapsed)}${failures.length ? ` · 경고 ${failures.length}개` : ''}`);
  for (const p of Object.values(d.pages)) p.close();
  return { elapsed, failures, snaps: d.snaps };
}
