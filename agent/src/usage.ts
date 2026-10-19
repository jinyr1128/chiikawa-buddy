// AI 사용량(홈 화면 「AI 사용량」): 한도를 몇 % 썼는지 · 언제 다시 차는지 · 오늘 쓴 토큰.
//  - Claude: 한도 %는 Claude Code(터미널) 상태 줄이 넘겨주는 rate_limits(5시간·주간)를 받아 둔다(POST /claude/status).
//    오늘 토큰은 ~/.claude/projects 의 대화 기록에서 센다(읽기만, 같은 응답은 한 번만).
//  - Codex: ~/.codex/sessions 기록의 token_count(한도 %·초기화 시각·누적 토큰)를 읽는다.
// 로그인 정보·열쇠는 읽지 않는다. 값이 없으면 없다고 보여 준다.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Limit = { pct: number; resetsAt?: string; windowMin?: number };
export type ToolUsage = { fiveHour?: Limit; week?: Limit; at?: string; todayTokens: number; plan?: string };
export type UsageSnapshot = { claude: ToolUsage; codex: ToolUsage };

const pct = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined; };
// resets_at: 초(숫자) · 밀리초 · ISO 글 → ISO
export function resetIso(v: unknown): string | undefined {
  if (typeof v === "string" && v && Number.isNaN(Number(v))) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}
const limit = (o: any, windowMin?: number): Limit | undefined => {
  const p = pct(o?.used_percentage ?? o?.used_percent ?? o?.utilization);
  if (p === undefined) return undefined;
  return { pct: p, resetsAt: resetIso(o?.resets_at), ...(windowMin ? { windowMin } : {}) };
};

// 「오후 7시」 · 오늘이 아니면 「10/24 오후 7시」
export function whenText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const h = d.getHours();
  const hm = `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}시${d.getMinutes() ? ` ${d.getMinutes()}분` : ""}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// Claude 상태 줄에 그대로 찍히는 한 줄
export function statusText(u: ToolUsage, now = Date.now()): string {
  const parts: string[] = [];
  if (u.fiveHour) parts.push(`5시간 ${u.fiveHour.pct}%${u.fiveHour.pct >= 80 && u.fiveHour.resetsAt ? `(${whenText(u.fiveHour.resetsAt, now)} 초기화)` : ""}`);
  if (u.week) parts.push(`주간 ${u.week.pct}%`);
  return parts.length ? `🐹 ${parts.join(" · ")}` : "";
}

type FileCur = { offset: number; rest: string };

export class AiUsage {
  private claude: Omit<ToolUsage, "todayTokens"> = {};
  private file: string;
  private claudeDir: string;
  private codexDir: string;
  private now: () => number;
  private cur = new Map<string, FileCur>();
  private seen = new Set<string>();               // Claude 응답 id(같은 응답이 여러 줄로 남는다)
  private claudeByDay = new Map<string, number>(); // 날짜 → 토큰
  private codexTotals = new Map<string, { day: string; total: number; base: number }>(); // 파일 → 오늘 누적
  private codexLimits: { fiveHour?: Limit; week?: Limit; plan?: string; at?: string } = {};
  private scannedAt = 0;

  constructor(opts: { file?: string; claudeDir?: string; codexDir?: string; now?: () => number } = {}) {
    const home = process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent");
    this.file = opts.file ?? join(home, "usage.json");
    this.claudeDir = opts.claudeDir ?? join(homedir(), ".claude", "projects");
    this.codexDir = opts.codexDir ?? join(homedir(), ".codex", "sessions");
    this.now = opts.now ?? Date.now;
    try { this.claude = JSON.parse(readFileSync(this.file, "utf8")).claude ?? {}; } catch { /* 처음 */ }
  }

  // Claude Code 상태 줄 입력(JSON) → 한도 기억 → 상태 줄 글
  fromClaudeStatus(input: any): string {
    const rl = input?.rate_limits;
    if (rl && typeof rl === "object") {
      const five = limit(rl.five_hour, 300);
      const week = limit(rl.seven_day, 10080);
      if (five || week) {
        this.claude = { fiveHour: five, week, at: new Date(this.now()).toISOString() };
        try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ claude: this.claude }) + "\n", { mode: 0o600 }); } catch { /* 다음에 */ }
      }
    }
    return statusText(this.claude.fiveHour || this.claude.week ? { ...this.claude, todayTokens: 0 } : { todayTokens: 0 }, this.now());
  }

  snapshot(): UsageSnapshot {
    if (this.now() - this.scannedAt > 20e3) { this.scannedAt = this.now(); try { this.scan(); } catch { /* 다음에 */ } }
    const today = dayKey(this.now());
    let codexToday = 0;
    for (const v of this.codexTotals.values()) if (v.day === today) codexToday += Math.max(0, v.total - v.base);
    return {
      claude: { ...this.claude, ...this.expire(this.claude), todayTokens: this.claudeByDay.get(today) ?? 0 },
      codex: { ...this.codexLimits, ...this.expire(this.codexLimits), todayTokens: codexToday },
    };
  }

  // 초기화 시각이 지난 한도는 0%로
  private expire(u: { fiveHour?: Limit; week?: Limit }) {
    const fix = (l?: Limit) => (l && l.resetsAt && Date.parse(l.resetsAt) <= this.now() ? { ...l, pct: 0, resetsAt: undefined } : l);
    return { fiveHour: fix(u.fiveHour), week: fix(u.week) };
  }

  // 오늘 바뀐 기록 파일만, 지난번에 읽은 곳부터
  private scan() {
    const since = startOfDay(this.now());
    for (const p of listJsonl(this.claudeDir, 2, since)) this.readNew(p, (l) => this.claudeLine(l));
    for (const p of recentCodex(this.codexDir, this.now(), since)) {
      const first = !this.cur.has(p);
      this.readNew(p, (l) => this.codexLine(p, l, first));
    }
  }

  private readNew(p: string, onLine: (l: string) => void) {
    let st = this.cur.get(p);
    const size = statSync(p).size;
    if (!st) { st = { offset: 0, rest: "" }; this.cur.set(p, st); }
    if (size < st.offset) { st.offset = 0; st.rest = ""; }
    if (size === st.offset) return;
    const fd = openSync(p, "r");
    try {
      while (st.offset < size) {
        const n = Math.min(size - st.offset, 8 * 1024 * 1024);
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, st.offset);
        st.offset += n;
        const lines = (st.rest + buf.toString("utf8")).split("\n");
        st.rest = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      }
    } finally { closeSync(fd); }
  }

  private claudeLine(l: string) {
    if (!l.includes('"usage"')) return;
    let d: any;
    try { d = JSON.parse(l); } catch { return; }
    const u = d?.message?.usage;
    if (!u || d.type !== "assistant") return;
    const id = String(d.message?.id ?? "") + ":" + String(d.requestId ?? "");
    if (id !== ":" && this.seen.has(id)) return;
    this.seen.add(id);
    const t = Date.parse(d.timestamp);
    if (!Number.isFinite(t)) return;
    const n = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.output_tokens) || 0);
    const k = dayKey(t);
    this.claudeByDay.set(k, (this.claudeByDay.get(k) ?? 0) + n);
  }

  private codexLine(file: string, l: string, firstRead: boolean) {
    if (!l.includes('"token_count"')) return;
    let d: any;
    try { d = JSON.parse(l); } catch { return; }
    const p = d?.payload;
    if (d?.type !== "event_msg" || p?.type !== "token_count") return;
    const t = Date.parse(d.timestamp) || this.now();
    const rl = p.rate_limits;
    if (rl && (!this.codexLimits.at || t >= Date.parse(this.codexLimits.at))) {
      // primary·secondary 중 창 길이로 5시간/주간을 가른다(요금제마다 primary 가 주간일 때가 있다)
      const ls = [rl.primary, rl.secondary].filter(Boolean).map((x: any) => ({ x, w: Number(x.window_minutes) || 0 }));
      const short = ls.find((v) => v.w > 0 && v.w <= 600);
      const long = ls.find((v) => v.w > 600);
      this.codexLimits = { fiveHour: short ? limit(short.x, short.w) : undefined, week: long ? limit(long.x, long.w) : undefined, plan: typeof rl.plan_type === "string" ? rl.plan_type : undefined, at: new Date(t).toISOString() };
    }
    const total = Number(p.info?.total_token_usage?.total_tokens);
    if (!Number.isFinite(total)) return;
    const day = dayKey(t);
    const prev = this.codexTotals.get(file);
    // 오늘 이전부터 이어진 대화는 오늘 처음 본 값부터 센다
    if (!prev || prev.day !== day) this.codexTotals.set(file, { day, total, base: prev ? prev.total : (firstRead && t < startOfDay(this.now()) ? total : 0) });
    else prev.total = total;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function listJsonl(dir: string, depth: number, since: number): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string, left: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { if (left > 1) walk(p, left - 1); }
      else if (n.endsWith(".jsonl") && s.mtimeMs >= since) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

function recentCodex(dir: string, now: number, since: number): string[] {
  const out: string[] = [];
  for (const back of [0, 1, 2, 3, 4, 5, 6]) {
    const d = new Date(now - back * 86400e3);
    const day = join(dir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let names: string[] = [];
    try { names = readdirSync(day); } catch { continue; }
    for (const n of names) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      const p = join(day, n);
      // 오늘 바뀐 것 + 한도 %를 알기 위해 가장 최근 기록 몇 개
      try { if (statSync(p).mtimeMs >= since || out.length < 3) out.push(p); } catch { /* 지워짐 */ }
    }
  }
  return out;
}
