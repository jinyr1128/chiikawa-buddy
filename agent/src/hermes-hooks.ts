// Hermes Agent 연동: Hermes 셸 hook(~/.hermes/config.yaml hooks:)이 POST /hermes/hook 으로 보내는 신호를
// Claude Code hook 모양으로 바꿔 같은 캐릭터 반응(작업 중 · 끝 · 사용량 한도)을 낸다.
// Hermes 쪽 이름: pre_llm_call(차례 시작) · pre_tool_call(도구) · post_llm_call(차례 끝) · api_request_error(오류, 429 = 한도) · on_session_end
// 받은 본문에서 쓰는 건 이벤트 이름·도구 이름·도구 인자·세션 id·폴더·오류 코드뿐(대화 내용은 읽지 않는다)
import type { ClaudeHookEvent } from "./claude-hooks.ts";

const TOOL: Record<string, string> = {
  terminal: "Bash", shell: "Bash", execute_code: "Bash", process: "Bash",
  read_file: "Read", write_file: "Write", patch: "Edit", edit_file: "Edit",
  search_files: "Grep", grep: "Grep", list_files: "LS",
  web_search: "WebSearch", web_extract: "WebFetch", browser_navigate: "WebFetch",
  delegate_task: "Task", todo: "TodoWrite", skill_view: "Skill",
};

export function hermesToClaude(raw: unknown): (ClaudeHookEvent & { limit_when?: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const extra = b.extra && typeof b.extra === "object" ? b.extra : {};
  const ev = String(b.hook_event_name ?? "");
  const sid = String(b.session_id ?? extra.session_id ?? "") || "hermes";
  const base = { session_id: `hermes:${sid.slice(0, 80)}`, ...(typeof b.cwd === "string" ? { cwd: b.cwd } : {}) };
  switch (ev) {
    case "pre_llm_call": return { ...base, hook_event_name: "UserPromptSubmit" };
    case "pre_tool_call": {
      const name = String(b.tool_name ?? "");
      const args = (b.tool_input ?? b.args) && typeof (b.tool_input ?? b.args) === "object" ? (b.tool_input ?? b.args) : {};
      const tool = name.startsWith("browser_") ? "WebFetch" : name.startsWith("computer_") ? "화면 조작" : TOOL[name] ?? name;
      const input: Record<string, unknown> = {};
      if (typeof args.path === "string") input.file_path = args.path;
      if (typeof args.file_path === "string") input.file_path = args.file_path;
      if (typeof args.query === "string") input.query = args.query;
      if (typeof args.url === "string") input.url = args.url;
      return { ...base, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input };
    }
    case "post_tool_call": return { ...base, hook_event_name: "PostToolUse" };
    case "post_llm_call": return { ...base, hook_event_name: "Stop" };
    case "api_request_error": {
      const status = Number(extra.status_code ?? b.status_code);
      const reason = String(extra.reason ?? b.reason ?? extra.error ?? "");
      const retryable = extra.retryable ?? b.retryable;
      if (status === 429 || /rate.?limit|quota|usage.?limit/i.test(reason)) {
        if (retryable === true && Number(extra.retry_count ?? 0) < Number(extra.max_retries ?? 0)) return null; // 아직 다시 해 보는 중
        return { ...base, hook_event_name: "Stop", limit_when: "" };
      }
      return null;
    }
    case "on_session_end": return { ...base, hook_event_name: "SessionEnd" };
    default: return null;
  }
}
