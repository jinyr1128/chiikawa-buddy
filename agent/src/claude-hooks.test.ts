import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeHooks, STALE_MS, toolDetail, toolLabel, say } from "./claude-hooks.ts";

function rig() {
  const begun: { kind: string; title: string; ended: boolean }[] = [];
  const bubbles: { text: string; kind: string }[] = [];
  const plays: string[] = [];
  let t = 1000;
  const activity = {
    begin(kind: string, title: string) { const r = { kind, title, ended: false }; begun.push(r); return () => { r.ended = true; }; },
    play(_ms?: number, clip: "plan" | "dance" | "cheer" | "lunch" = "plan") { plays.push(clip); return {}; },
  };
  const hooks = new ClaudeHooks(activity, (b) => { bubbles.push(b); return "id"; }, () => "chiikawa", () => t);
  return { hooks, begun, bubbles, plays, tick: (ms: number) => { t += ms; } };
}
const live = (b: { ended: boolean; title: string }[]) => b.filter((x) => !x.ended).map((x) => x.title);

test("질문 → 도구 → 끝: 작업 중 제목이 바뀌고 끝나면 다 했어 말풍선", () => {
  const { hooks, begun, bubbles } = rig();
  hooks.handle({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/a/myproj" });
  assert.deepEqual(live(begun), ["Claude · 생각 중 (myproj)"]);
  hooks.handle({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/a/myproj/main.js" } });
  assert.deepEqual(live(begun), ["Claude · 고치는 중 · main.js"]);
  hooks.handle({ hook_event_name: "Stop", session_id: "s1", cwd: "/a/myproj" });
  assert.deepEqual(live(begun), []);
  assert.equal(bubbles.at(-1)?.text, "와…!! (Claude 작업 끝났어 · myproj!)");
  hooks.stop();
});

test("알림(권한 대기) → 알림 영상 + 말풍선, idle_prompt 는 조용히", () => {
  const { hooks, bubbles, plays } = rig();
  hooks.handle({ hook_event_name: "Notification", session_id: "s1", notification_type: "idle_prompt", message: "x" });
  assert.equal(bubbles.length, 0);
  hooks.handle({ hook_event_name: "Notification", session_id: "s1", message: "Claude needs your permission to use Bash" });
  assert.deepEqual(plays, ["plan"]);
  assert.match(bubbles[0].text, /Claude가 기다려요/);
  hooks.stop();
});

test("세션 여러 개는 따로, 신호가 끊기면 저절로 끝", () => {
  const { hooks, begun, tick } = rig();
  hooks.handle({ hook_event_name: "UserPromptSubmit", session_id: "a" });
  hooks.handle({ hook_event_name: "UserPromptSubmit", session_id: "b" });
  assert.equal(hooks.active(), 2);
  tick(STALE_MS + 1);
  hooks.dropStale();
  assert.equal(hooks.active(), 0);
  assert.deepEqual(live(begun), []);
  hooks.stop();
});

test("도구 이름·설명 풀어 쓰기", () => {
  assert.equal(toolLabel("Bash"), "명령 실행 중");
  assert.equal(toolLabel("mcp__gmail__search_threads"), "메일 보는 중");
  assert.equal(toolLabel("mcp__x__do_thing"), "do_thing 쓰는 중");
  assert.equal(toolDetail("Bash", { command: "npm test --watch" }), "npm"); // 명령 전문은 싣지 않는다
  assert.equal(toolDetail("WebFetch", { url: "https://example.com/a?b" }), "example.com");
  assert.equal(say("shisa", "done", "끝"), "끝");
});
