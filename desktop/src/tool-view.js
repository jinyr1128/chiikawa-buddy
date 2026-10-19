// 작업 세션 창의 도구 줄 — Claude Code 터미널처럼 "⏺ Bash(명령)" 머리줄과 "⎿ 결과 몇 줄 … +N줄".
// 순수 함수만(렌더러·테스트 둘 다 쓴다). 입력은 데몬이 남긴 tool_use `input`(짧은 한 줄, docs/contract.md "작업 세션").
import { diffLines } from './session.js';

export const ARG_MAX = 120;      // 머리줄 인자 길이
export const PREVIEW_LINES = 4;  // 접힌 결과에 보일 줄 수
const LINE_MAX = 200;            // 결과 한 줄 길이

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead']);

export function ellipsize(s, max = ARG_MAX) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const WIN_ABS = /^[A-Za-z]:[\\/]/;

// 윈도우 경로: 대소문자 무시, \ · / 둘 다. C:\Users\<나> → ~
function shortWinPath(s, cwd) {
  const base = typeof cwd === 'string' && WIN_ABS.test(cwd) ? cwd.replace(/[\\/]+$/, '') : '';
  if (base) {
    const lo = s.toLowerCase(), b = base.toLowerCase();
    if (lo === b) return '.';
    if (lo.startsWith(b) && /[\\/]/.test(s[base.length] ?? '')) return s.slice(base.length + 1);
  }
  return s.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i, '~');
}

// 경로 줄이기: run 폴더 아래면 상대 경로, 홈 아래면 ~/…
export function shortPath(p, cwd) {
  const s = String(p ?? '');
  if (WIN_ABS.test(s)) return shortWinPath(s, cwd);
  if (!s.startsWith('/')) return s;
  const base = typeof cwd === 'string' && cwd.startsWith('/') ? cwd.replace(/\/+$/, '') : '';
  if (base) {
    if (s === base) return '.';
    if (s.startsWith(`${base}/`)) return s.slice(base.length + 1);
  }
  return s.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

function parseJson(s) {
  if (typeof s !== 'string' || !/^\s*[[{]/.test(s)) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// {"a":1,"b":"x"} → a: 1, b: "x" (앞 3개). JSON 이 아니면(잘린 것 등) 그대로 한 줄로
export function formatArgs(s, keys = 3) {
  const v = typeof s === 'string' ? parseJson(s) : s;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const ents = Object.entries(v);
    const shown = ents.slice(0, keys).map(([k, x]) => `${k}: ${JSON.stringify(x) ?? String(x)}`);
    return shown.join(', ') + (ents.length > keys ? ', …' : '');
  }
  if (v !== undefined) return JSON.stringify(v);
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// 예전 기록은 입력이 JSON 통째일 수 있다 — 거기서 한 키를 꺼낸다
const pick = (input, key) => {
  const v = parseJson(input);
  return v && typeof v === 'object' && typeof v[key] === 'string' ? v[key] : null;
};

// 도구 이름 + 입력 → { name, arg(머리줄에 보일 한 줄), full(마우스를 올리면·펼치면 보일 전체) }
export function toolHeader(rawName, rawInput, { cwd } = {}) {
  const name = String(rawName ?? '?');
  const input = typeof rawInput === 'string' ? rawInput : rawInput == null ? '' : JSON.stringify(rawInput);
  const out = (n, arg, full = input) => ({ name: n, arg: ellipsize(String(arg ?? '').replace(/\s+/g, ' ').trim()), full });

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return out(`${mcp[1]} · ${mcp[2]}`, formatArgs(input));
  }
  if (name === 'Bash') {
    const lines = input.split('\n');
    const first = lines[0] + (lines.slice(1).some((l) => l.trim()) ? ' …' : '');
    return { name, arg: ellipsize(first), full: input };
  }
  if (FILE_TOOLS.has(name)) {
    const p = pick(input, 'file_path') ?? pick(input, 'notebook_path') ?? input;
    return out(name, shortPath(p, cwd));
  }
  if (name === 'Grep' || name === 'Glob') {
    const i = input.lastIndexOf(' in ');
    const path = i >= 0 ? input.slice(i + 4) : '';
    if (i >= 0 && (path.startsWith('/') || WIN_ABS.test(path))) return out(name, `${input.slice(0, i)} in ${shortPath(path, cwd)}`);
    return out(name, input);
  }
  if (name === 'WebFetch') return out(name, pick(input, 'url') ?? input);
  if (name === 'WebSearch') return out(name, pick(input, 'query') ?? input);
  if (name === 'Agent' || name === 'Task') return out(name, pick(input, 'description') ?? pick(input, 'subagent_type') ?? formatArgs(input));
  return out(name, formatArgs(input));
}

// diff → "3줄 추가, 1줄 삭제" (새 파일이면 "12줄 작성")
export function diffSummary(diff) {
  let add = 0, del = 0, created = true;
  for (const d of Array.isArray(diff) ? diff : []) {
    if (d.old) created = false;
    for (const l of diffLines(d.old, d.new)) { if (l.op === '+') add++; else if (l.op === '-') del++; }
  }
  const parts = [];
  if (created && del === 0) return { add, del, text: `${add}줄 작성` };
  if (add) parts.push(`${add}줄 추가`);
  if (del) parts.push(`${del}줄 삭제`);
  return { add, del, text: parts.join(', ') || '바뀐 줄 없음' };
}

// 결과 미리보기(접힌 상태). kind:
//  running — 아직 결과 없음 · quiet — 본문 안 남김(크기만) · empty — 출력 없음
//  summary — 한 줄 요약(diff·Read) · lines — 앞 몇 줄 + "… +N줄"
export function resultPreview(t, { maxLines = PREVIEW_LINES } = {}) {
  if (!t.done) return { kind: 'running', lines: ['실행 중…'], more: '', error: false };
  const error = !!t.isError;
  if (t.output == null) {
    if (t.size != null) return { kind: 'quiet', lines: [`결과 ${Number(t.size).toLocaleString()}자 — 기록 안 함`], more: '', error };
    return { kind: 'empty', lines: ['(출력 없음)'], more: '', error };
  }
  const all = String(t.output).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (!error && t.diff) return { kind: 'summary', lines: [diffSummary(t.diff).text], more: '', error, expandable: true };
  if (!error && t.name === 'Read') {
    const text = t.truncated && t.size ? `${Number(t.size).toLocaleString()}자 읽음` : `${all.length}줄 읽음`;
    return { kind: 'summary', lines: [text], more: '', error, expandable: all.length > 0 };
  }
  if (!all.length) return { kind: 'empty', lines: ['(출력 없음)'], more: '', error };
  const shown = all.slice(0, maxLines).map((l) => ellipsize(l, LINE_MAX));
  const rest = all.length - shown.length;
  const more = rest > 0 ? `… +${rest}줄${t.truncated ? ' 이상' : ''}` : t.truncated ? '… 더 있음' : '';
  return { kind: 'lines', lines: shown, more, error };
}

// 서브에이전트(Agent 줄) 접힌 요약 — Claude Code 처럼 "⎿ 도구 N번 · 진행 중…" + 마지막 도구 한 줄.
// running: run 이 아직 돌고 있나(결과 없이 끝난 run 이면 "멈춤"). latest: 마지막 도구의 머리줄({name, arg, state})
export function subagentSummary(t, { running = true, cwd } = {}) {
  const tools = t?.sub?.tools ?? [];
  const state = t?.handedOff ? '백그라운드로 넘김 — 따로 도는 세션에서 진행' : t?.done ? (t.isError ? '실패' : '완료') : running ? '진행 중…' : '멈춤';
  const count = tools.length;
  const text = count ? `도구 ${count}번 · ${state}` : state;
  const last = tools[tools.length - 1];
  const latest = last ? { ...toolHeader(last.name, last.input, { cwd }), state: !last.done ? 'run' : last.isError ? 'bad' : 'ok' } : null;
  return { text, count, state, latest, more: t?.sub?.more || '' };
}
