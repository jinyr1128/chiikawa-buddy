// Claude Code 실시간 연동: Claude Code hook(~/.claude/settings.json)이 POST /claude/hook 으로 보내는 신호를 받아
// 캐릭터를 "공부 중(작업 중)"으로 바꾸고, 머리 위 진행 중 말풍선에 지금 하는 일을 띄운다.
// - 세션(Claude 대화창)마다 activity.begin() 하나를 잡고, 도구가 바뀌면 제목만 바꿔 다시 잡는다
// - Notification(권한 승인 대기 등) → 일정 알림 영상 + 말풍선 · Stop → 「다 했어」 말풍선
// - 신호가 끊기면(앱 종료·강제 종료) STALE_MS 뒤 저절로 쉬는 상태로
import { basename } from "node:path";
import { notify } from "./inbox.ts";
import { phrase } from "./phrases.ts";

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

const TOOL_TASK: Record<string, string> = {
  Read: "읽기", Edit: "고치기", MultiEdit: "고치기", Write: "쓰기", NotebookEdit: "노트 고치기",
  Bash: "명령 실행", Grep: "찾기", Glob: "파일 찾기", LS: "둘러보기",
  WebSearch: "검색", WebFetch: "인터넷 보기", Task: "친구 부르기", Agent: "친구 부르기",
  TodoWrite: "할 일 정리", Skill: "기술 꺼내기",
};

// 도구 하나 → 캐릭터 대사의 {task}: 「main.js 고치기」, 「메일 보기」, 「생각」
export function taskText(tool?: string, input?: Record<string, unknown>): string {
  if (!tool) return "생각";
  let verb: string;
  if (tool.startsWith("mcp__")) {
    const name = tool.split("__").pop() ?? "";
    verb = /mail|gmail/i.test(tool) ? "메일 보기" : /calendar/i.test(tool) ? "일정 보기" : /slack/i.test(tool) ? "슬랙 보기"
      : /notion/i.test(tool) ? "노션 보기" : /browser|chrome/i.test(tool) ? "브라우저 쓰기" : name ? `${name} 쓰기` : "도구 쓰기";
  } else verb = TOOL_TASK[tool] ?? `${tool} 하기`;
  const d = toolDetail(tool, input);
  return d && /읽기|고치기|쓰기|찾기|검색|인터넷 보기/.test(verb) ? `${d} ${verb}` : verb;
}
// 예전 이름(테스트·다른 곳): 「고치기」 같은 일 이름
export const toolLabel = (tool?: string): string => taskText(tool);

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

type Session = { end: () => void; title: string; cwd?: string; at: number };

export class ClaudeHooks {
  private sessions = new Map<string, Session>();
  private sweep?: ReturnType<typeof setInterval>;

  private activity: ActivityLike;
  private bubble: BubbleLike;
  private now: () => number;

  constructor(activity: ActivityLike, bubble: BubbleLike, now: () => number = Date.now) {
    this.activity = activity;
    this.bubble = bubble;
    this.now = now;
    this.sweep = setInterval(() => this.dropStale(), 60e3);
    this.sweep.unref?.();
  }

  handle(ev: ClaudeHookEvent) {
    const name = ev.hook_event_name;
    const id = typeof ev.session_id === "string" && ev.session_id ? ev.session_id.slice(0, 80) : "unknown";
    const project = typeof ev.cwd === "string" && ev.cwd ? basename(ev.cwd) : "";
    const where = project ? `(${project})` : "";
    switch (name) {
      case "UserPromptSubmit":
        this.set(id, "생각", ev.cwd);
        return;
      case "PreToolUse":
        this.set(id, taskText(ev.tool_name, ev.tool_input), ev.cwd);
        return;
      case "PostToolUse":
        this.touch(id);
        return;
      case "Notification": {
        // idle_prompt(오래 입력 없음)는 조용히, 나머지(권한 승인 등)는 알린다
        if (ev.notification_type === "idle_prompt") return;
        const msg = typeof ev.message === "string" ? ev.message.slice(0, 200) : "확인이 필요해요";
        const text = phrase("claude_wait", { project: where }).trim();
        this.activity.play(6000, "plan");
        notify({ source: "claude", key: `claude-wait:${id}:${this.now()}`, account: project || undefined, title: text, body: msg });
        this.bubble({ id: `claude-wait-${id}`, kind: "info", ttlMs: 30e3, text, detail: msg });
        return;
      }
      case "Stop": {
        const had = this.sessions.has(id);
        this.end(id);
        if (!had) return;
        const text = phrase("claude_done", { project: where }).trim();
        notify({ source: "claude", key: `claude-done:${id}:${this.now()}`, account: project || undefined, title: text });
        this.bubble({ id: `claude-done-${id}`, kind: "done", ttlMs: 10e3, text });
        return;
      }
      case "SessionEnd":
        this.end(id);
        return;
      default:
        return;
    }
  }

  private set(id: string, title: string, cwd?: string) { // title = 일 이름({task})
    const prev = this.sessions.get(id);
    const full = phrase("claude_work", { task: title }).trim(); // 캐릭터 말투로(「main.js 고치기 하는 중이라고오!!!」)
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
