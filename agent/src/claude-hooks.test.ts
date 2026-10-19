import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ClaudeHooks, STALE_MS, taskText, toolDetail, limitFromLines, resetText, dayPart, readTranscriptTail } from "./claude-hooks.ts";
import { setCharacter } from "./characters.ts";
import { phrase } from "./phrases.ts";

afterEach(() => setCharacter("shisa"));

function rig() {
  const begun: { kind: string; title: string; ended: boolean }[] = [];
  const bubbles: { text: string; kind: string }[] = [];
  const plays: string[] = [];
  let t = 1000;
  const activity = {
    begin(kind: string, title: string) { const r = { kind, title, ended: false }; begun.push(r); return () => { r.ended = true; }; },
    play(_ms?: number, clip: "plan" | "dance" | "cheer" | "lunch" = "plan") { plays.push(clip); return {}; },
  };
  const hooks = new ClaudeHooks(activity, (b) => { bubbles.push(b); return "id"; }, () => t);
  return { hooks, begun, bubbles, plays, tick: (ms: number) => { t += ms; } };
}
const live = (b: { ended: boolean; title: string }[]) => b.filter((x) => !x.ended).map((x) => x.title);

test("질문 → 도구 → 끝: 머리 위는 캐릭터 말투로 지금 하는 일, 끝나면 캐릭터 대사(「Claude」 글자 없이)", () => {
  setCharacter("momonga");
  const { hooks, begun, bubbles } = rig();
  hooks.handle({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/a/myproj" });
  assert.equal(live(begun).length, 1);
  assert.match(live(begun)[0], /생각/);
  hooks.handle({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Edit", tool_input: { file_path: "/a/myproj/main.js" } });
  assert.equal(live(begun).length, 1);
  assert.match(live(begun)[0], /main\.js 고치기/);
  assert.doesNotMatch(live(begun)[0], /Claude|\{/); // 캐릭터 말투(자리표시 다 채움)
  hooks.handle({ hook_event_name: "Stop", session_id: "s1", cwd: "/a/myproj" });
  assert.deepEqual(live(begun), []);
  assert.match(bubbles.at(-1)!.text, /\(myproj\)/);
  assert.doesNotMatch(bubbles.at(-1)!.text, /Claude/);
  hooks.stop();
});

test("알림(권한 대기) → 알림 영상 + 캐릭터 말투 말풍선, idle_prompt 는 조용히", () => {
  setCharacter("chiikawa");
  const { hooks, bubbles, plays } = rig();
  hooks.handle({ hook_event_name: "Notification", session_id: "s1", notification_type: "idle_prompt", message: "x" });
  assert.equal(bubbles.length, 0);
  hooks.handle({ hook_event_name: "Notification", session_id: "s1", message: "Claude needs your permission to use Bash" });
  assert.deepEqual(plays, ["plan"]);
  assert.match(bubbles[0].text, /^(에에에…|싫어…!|에\?) \(/);
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

test("일 이름({task})과 캐릭터마다 Claude 연동 대사", () => {
  assert.equal(taskText("Bash", { command: "npm test" }), "명령 실행");
  assert.equal(taskText("Read", { file_path: "/x/README.md" }), "README.md 읽기");
  assert.equal(taskText("mcp__gmail__search_threads"), "메일 보기");
  assert.equal(taskText(), "생각");
  assert.equal(toolDetail("Bash", { command: "npm test --watch" }), "npm"); // 명령 전문은 싣지 않는다
  assert.equal(toolDetail("WebFetch", { url: "https://example.com/a?b" }), "example.com");
  for (const id of ["shisa", "hachi", "rakko", "momonga", "usagi", "kani", "chiikawa", "kuri"]) {
    setCharacter(id);
    for (const key of ["claude_work", "claude_done", "claude_wait"] as const) assert.doesNotMatch(phrase(key, { task: "x", project: "" }), /\{|Claude/, `${id}.${key}`);
  }
});

test("토큰(사용량 한도)을 다 써서 멈추면 「다 했어」 대신 캐릭터의 한도 대사 + 풀리는 시각", () => {
  setCharacter("momonga");
  const err = JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets 7pm (Asia/Seoul)" }] } });
  const ok = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "다 했어요. rate limit 얘기는 그냥 대화" }] } });
  assert.deepEqual(limitFromLines([ok, err]), { hit: true, when: " (오후 7시에 다시 할 수 있어)" });
  assert.equal(limitFromLines([err, ok]).hit, false); // 마지막 답이 보통 답이면 아님(대화에 limit 이 나와도)
  assert.equal(resetText("resets 10:30am"), " (오전 10시 30분에 다시 할 수 있어)");
  const bubbles: { text: string }[] = [];
  const hooks = new ClaudeHooks({ begin: () => () => {}, play: () => ({}) }, (b) => { bubbles.push(b); return "id"; }, () => 1000, { readTail: () => [err] });
  hooks.handle({ hook_event_name: "UserPromptSubmit", session_id: "s" });
  hooks.handle({ hook_event_name: "Stop", session_id: "s", transcript_path: "/x.jsonl" });
  assert.match(bubbles.at(-1)!.text, /한도|토큰/);
  assert.match(bubbles.at(-1)!.text, /오후 7시/);
  hooks.stop();
  assert.deepEqual(readTranscriptTail("/etc/passwd"), []); // ~/.claude/projects 밖은 읽지 않는다
});

test("시간대: 아침·늦은 밤엔 그 시간대 말, 같은 말은 연달아 안 나온다", () => {
  setCharacter("hachi");
  const at = (h: number) => new Date(2026, 9, 19, h, 0).getTime();
  assert.equal(dayPart(at(8)), "morning");
  assert.equal(dayPart(at(23)), "night");
  assert.equal(dayPart(at(3)), "night");
  assert.equal(dayPart(at(14)), "day");
  const titles: string[] = [];
  const hooks = new ClaudeHooks({ begin: (_k, t) => { titles.push(t); return () => {}; }, play: () => ({}) }, () => "id", () => at(23), { rand: () => 0.1 });
  hooks.handle({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {} });
  assert.match(titles[0], /밤|늦/);
  hooks.stop();
  const seen: string[] = [];
  let r = 0;
  const h2 = new ClaudeHooks({ begin: (_k, t) => { seen.push(t); return () => {}; }, play: () => ({}) }, () => "id", () => at(14), { rand: () => (r = (r + 0.37) % 1) });
  for (const t of ["Read", "Edit", "Bash", "Grep"]) h2.handle({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: t } });
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  h2.stop();
});
