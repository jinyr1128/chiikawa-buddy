// Codex(ChatGPT 코딩 도구) 작업 표시: Codex Desktop·CLI 가 쓰는 기록 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 지켜보고
// Claude Code 와 같은 캐릭터 반응(작업 중 · 끝 · 사용량 한도)을 낸다(claude-hooks.ts 의 ClaudeHooks 를 그대로 쓴다).
// 읽기만 한다. 앱을 켜기 전 기록은 다시 읽지 않는다(지켜보기 시작한 뒤 새로 붙은 줄만).
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ClaudeHookEvent } from "./claude-hooks.ts";

type HooksLike = { handle(ev: ClaudeHookEvent & { limit_when?: string }, source?: "claude" | "codex" | "hermes"): void };
type FileState = { offset: number; rest: string; thread: string; cwd?: string; limitWhen?: string };

export const CODEX_DIR = join(homedir(), ".codex", "sessions");
const pad = (n: number) => String(n).padStart(2, "0");

// 「resets_at」(초) → " (10/24 오후 7시에 다시 할 수 있어)" — 오늘이면 날짜 없이
export function codexResetText(epochSec: unknown, now = Date.now()): string {
  const s = Number(epochSec);
  if (!Number.isFinite(s) || s <= 0) return "";
  const d = new Date(s * 1000);
  const today = new Date(now);
  const same = d.toDateString() === today.toDateString();
  const h = d.getHours();
  const hm = `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}시${d.getMinutes() ? ` ${d.getMinutes()}분` : ""}`;
  return ` (${same ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${hm}에 다시 할 수 있어)`;
}

// Codex 도구 호출 → Claude 도구 이름(일 이름 고르기용)
export function codexTool(name: string, input: string): { tool: string; tool_input: Record<string, unknown> } {
  const s = String(input ?? "");
  if (name === "apply_patch" || /\*\*\* (Update|Add) File: /.test(s)) {
    const m = /\*\*\* (?:Update|Add) File: (\S+)/.exec(s);
    return { tool: "Edit", tool_input: m ? { file_path: m[1] } : {} };
  }
  if (/web__run|web_search|search_query/.test(s) || name === "web_search") return { tool: "WebSearch", tool_input: {} };
  if (name === "exec" || name === "shell" || name === "exec_command" || name === "local_shell") return { tool: "Bash", tool_input: {} };
  return { tool: name || "도구", tool_input: {} };
}

export class CodexWatch {
  private files = new Map<string, FileState>();
  private timer?: ReturnType<typeof setInterval>;
  private started: number;
  private hooks: HooksLike;
  private dir: string;
  private now: () => number;

  constructor(hooks: HooksLike, opts: { dir?: string; now?: () => number } = {}) {
    this.hooks = hooks;
    this.dir = opts.dir ?? CODEX_DIR;
    this.now = opts.now ?? Date.now;
    this.started = this.now();
  }

  start(intervalMs = 3000) {
    // Codex 를 앱보다 나중에 깔아도 보이게: 폴더가 없어도 지켜보기는 켜 두고, 생기면 그때부터 읽는다
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* 다음에 다시 */ } }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  // 오늘·어제 폴더에서 최근 15분 안에 바뀐 기록만
  private recentFiles(): string[] {
    const out: string[] = [];
    for (const back of [0, 1]) {
      const d = new Date(this.now() - back * 86400e3);
      const day = join(this.dir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      let names: string[] = [];
      try { names = readdirSync(day); } catch { continue; }
      for (const n of names) {
        if (!/^rollout-.*\.jsonl$/.test(n)) continue;
        const p = join(day, n);
        try { if (this.now() - statSync(p).mtimeMs < 15 * 60e3) out.push(p); } catch { /* 지워짐 */ }
      }
    }
    return out;
  }

  tick() {
    if (!existsSync(this.dir)) return;
    for (const p of this.recentFiles()) {
      let st: FileState | undefined = this.files.get(p);
      const size = statSync(p).size;
      if (!st) {
        // 지켜보기 전부터 있던 기록은 끝에서 시작(예전 일을 다시 알리지 않게). 새로 생긴 기록은 처음부터
        const born = statSync(p).birthtimeMs;
        st = { offset: born >= this.started ? 0 : size, rest: "", thread: basename(p).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1] ?? basename(p, ".jsonl") };
        this.files.set(p, st);
      }
      if (size <= st.offset) { if (size < st.offset) st.offset = size; continue; }
      const fd = openSync(p, "r");
      try {
        const n = Math.min(size - st.offset, 4 * 1024 * 1024);
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, st.offset);
        st.offset += n;
        const text = st.rest + buf.toString("utf8");
        const lines = text.split("\n");
        st.rest = lines.pop() ?? "";
        for (const l of lines) this.line(st, l);
      } finally { closeSync(fd); }
    }
  }

  line(st: FileState, raw: string) {
    let d: any;
    try { d = JSON.parse(raw); } catch { return; }
    const p = d?.payload && typeof d.payload === "object" ? d.payload : {};
    if (d.type === "session_meta") { st.thread = String(p.id ?? p.session_id ?? st.thread); st.cwd = p.cwd ?? st.cwd; return; }
    if (d.type === "turn_context") { st.cwd = p.cwd ?? st.cwd; return; }
    const session_id = `codex:${st.thread || "?"}`;
    const base = { session_id, cwd: st.cwd };
    if (d.type === "event_msg" && p.type === "task_started") { st.limitWhen = undefined; this.hooks.handle({ ...base, hook_event_name: "UserPromptSubmit" }, "codex"); return; }
    if (d.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      const t = codexTool(String(p.name ?? ""), String(p.input ?? p.arguments ?? ""));
      this.hooks.handle({ ...base, hook_event_name: "PreToolUse", tool_name: t.tool, tool_input: t.tool_input }, "codex");
      return;
    }
    if (d.type === "event_msg" && p.type === "token_count") {
      const rl = p.rate_limits;
      const pr = rl?.primary;
      if (rl?.rate_limit_reached_type || Number(pr?.used_percent) >= 100) st.limitWhen = codexResetText(pr?.resets_at, this.now());
      return;
    }
    if (d.type === "event_msg" && (p.type === "error" || p.type === "stream_error") && /limit|quota|usage/i.test(String(p.message ?? ""))) {
      st.limitWhen = st.limitWhen ?? "";
      return;
    }
    if (d.type === "event_msg" && (p.type === "task_complete" || p.type === "turn_aborted")) {
      this.hooks.handle({ ...base, hook_event_name: "Stop", ...(st.limitWhen !== undefined ? { limit_when: st.limitWhen } : {}) }, "codex");
      st.limitWhen = undefined;
    }
  }
}
