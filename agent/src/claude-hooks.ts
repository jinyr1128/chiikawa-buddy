// Claude Code 실시간 연동: Claude Code hook(~/.claude/settings.json)이 POST /claude/hook 으로 보내는 신호를 받아
// 캐릭터를 "공부 중(작업 중)"으로 바꾸고, 머리 위 진행 중 말풍선에 지금 하는 일을 띄운다.
// - 세션(Claude 대화창)마다 activity.begin() 하나를 잡고, 도구가 바뀌면 제목만 바꿔 다시 잡는다
// - Notification(권한 승인 대기 등) → 일정 알림 영상 + 말풍선 · Stop → 「다 했어」 말풍선
// - 신호가 끊기면(앱 종료·강제 종료) STALE_MS 뒤 저절로 쉬는 상태로
import { basename } from "node:path";

export type ClaudeHookEvent = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
};

type ActivityLike = { begin(kind: string, title: string): () => void; play(ms?: number, clip?: "plan" | "dance" | "cheer" | "lunch"): { say?: string } };
type BubbleLike = (b: { id?: string; text: string; kind: "info" | "done"; ttlMs?: number; detail?: string }) => string;

export const CLAUDE_KIND = "claude";
export const STALE_MS = 10 * 60e3;

const TOOL_LABEL: Record<string, string> = {
  Read: "읽는 중", Edit: "고치는 중", MultiEdit: "고치는 중", Write: "쓰는 중", NotebookEdit: "노트 고치는 중",
  Bash: "명령 실행 중", Grep: "찾는 중", Glob: "찾는 중", LS: "둘러보는 중",
  WebSearch: "검색하는 중", WebFetch: "인터넷 보는 중", Task: "친구 부르는 중", Agent: "친구 부르는 중",
  TodoWrite: "할 일 정리 중", Skill: "기술 꺼내는 중",
};

export function toolLabel(tool?: string): string {
  if (!tool) return "생각 중";
  if (tool.startsWith("mcp__")) {
    const name = tool.split("__").pop() ?? "";
    if (/mail|gmail/i.test(tool)) return "메일 보는 중";
    if (/calendar/i.test(tool)) return "일정 보는 중";
    if (/slack/i.test(tool)) return "슬랙 보는 중";
    if (/notion/i.test(tool)) return "노션 보는 중";
    if (/browser|chrome/i.test(tool)) return "브라우저 쓰는 중";
    return name ? `${name} 쓰는 중` : "도구 쓰는 중";
  }
  return TOOL_LABEL[tool] ?? `${tool} 하는 중`;
}

// 도구 입력에서 짧은 설명 하나(파일 이름·검색어 등). 명령 전문·비밀은 싣지 않는다
export function toolDetail(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  let d = "";
  if (s(input.file_path) || s(input.notebook_path)) d = basename(s(input.file_path) || s(input.notebook_path));
  else if (s(input.pattern)) d = s(input.pattern);
  else if (s(input.query)) d = s(input.query);
  else if (s(input.url)) { try { d = new URL(s(input.url)).hostname; } catch { d = ""; } }
  else if (s(input.description)) d = s(input.description);
  else if (tool === "Bash" && s(input.command)) d = s(input.command).trim().split(/\s+/)[0];
  d = d.replace(/\s+/g, " ").trim();
  return d.length > 30 ? d.slice(0, 29) + "…" : d;
}

// 캐릭터마다 말투: 소리 + (뜻) 형식인 캐릭터는 괄호로
const SOUND: Record<string, { done: string; wait: string }> = {
  chiikawa: { done: "헤헤", wait: "앗…!" },
  usagi: { done: "우라!", wait: "하?" },
  kani: { done: "헤헤헤…", wait: "으아…" },
  kuri: { done: "캬아", wait: "…?" },
};
export function say(character: string, kind: "done" | "wait", text: string): string {
  const s = SOUND[character];
  return s ? `${s[kind]} (${text})` : text;
}

type Session = { end: () => void; title: string; cwd?: string; at: number };

export class ClaudeHooks {
  private sessions = new Map<string, Session>();
  private sweep?: ReturnType<typeof setInterval>;

  private activity: ActivityLike;
  private bubble: BubbleLike;
  private character: () => string;
  private now: () => number;

  constructor(activity: ActivityLike, bubble: BubbleLike, character: () => string, now: () => number = Date.now) {
    this.activity = activity;
    this.bubble = bubble;
    this.character = character;
    this.now = now;
    this.sweep = setInterval(() => this.dropStale(), 60e3);
    this.sweep.unref?.();
  }

  handle(ev: ClaudeHookEvent) {
    const name = ev.hook_event_name;
    const id = typeof ev.session_id === "string" && ev.session_id ? ev.session_id.slice(0, 80) : "unknown";
    const project = typeof ev.cwd === "string" && ev.cwd ? basename(ev.cwd) : "";
    switch (name) {
      case "UserPromptSubmit":
        this.set(id, "생각 중", ev.cwd);
        return;
      case "PreToolUse": {
        const detail = toolDetail(ev.tool_name, ev.tool_input);
        this.set(id, detail ? `${toolLabel(ev.tool_name)} · ${detail}` : toolLabel(ev.tool_name), ev.cwd);
        return;
      }
      case "PostToolUse":
        this.touch(id);
        return;
      case "Notification": {
        // idle_prompt(오래 입력 없음)는 조용히, 나머지(권한 승인 등)는 알린다
        if (ev.notification_type === "idle_prompt") return;
        const msg = typeof ev.message === "string" ? ev.message.slice(0, 200) : "확인이 필요해요";
        this.activity.play(6000, "plan");
        this.bubble({ id: `claude-wait-${id}`, kind: "info", ttlMs: 30e3, text: say(this.character(), "wait", `Claude가 기다려요${project ? ` · ${project}` : ""}`), detail: msg });
        return;
      }
      case "Stop": {
        const had = this.sessions.has(id);
        this.end(id);
        if (had) this.bubble({ id: `claude-done-${id}`, kind: "done", ttlMs: 10e3, text: say(this.character(), "done", `Claude 작업 끝났어${project ? ` · ${project}` : ""}!`) });
        return;
      }
      case "SessionEnd":
        this.end(id);
        return;
      default:
        return;
    }
  }

  private set(id: string, title: string, cwd?: string) {
    const prev = this.sessions.get(id);
    const project = cwd ? basename(cwd) : prev?.cwd ? basename(prev.cwd) : "";
    const full = `Claude · ${title}${project && title === "생각 중" ? ` (${project})` : ""}`;
    if (prev && prev.title === full) { prev.at = this.now(); return; }
    const end = this.activity.begin(CLAUDE_KIND, full);
    prev?.end(); // 새 것을 먼저 잡고 옛 것을 놓는다(잠깐 idle 로 깜빡이지 않게)
    this.sessions.set(id, { end, title: full, cwd: cwd ?? prev?.cwd, at: this.now() });
  }
  private touch(id: string) {
    const s = this.sessions.get(id);
    if (s) s.at = this.now();
  }
  private end(id: string) {
    this.sessions.get(id)?.end();
    this.sessions.delete(id);
  }
  dropStale() {
    const now = this.now();
    for (const [id, s] of this.sessions) if (now - s.at > STALE_MS) this.end(id);
  }
  active(): number { return this.sessions.size; }
  stop() {
    if (this.sweep) clearInterval(this.sweep);
    for (const id of [...this.sessions.keys()]) this.end(id);
  }
}
