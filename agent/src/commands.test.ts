import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommands, slashName, SlashCommands, usableCommands } from "./commands.ts";

const RAW = [
  { name: "code-review", description: "Review the diff", argumentHint: "[low|high]", builtin: true },
  { name: "model", description: "Set the model", argumentHint: "<model>", builtin: true },
  { name: "clear", description: "Clear", argumentHint: "", builtin: true, aliases: ["reset"] },
  { name: "usage", description: "Show usage", argumentHint: "", builtin: true, aliases: ["cost"] },
  { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
  { name: "docs", description: "Docs skill", argumentHint: "", aliases: ["anthropic-skills:docs"] },
  { name: "my-plugin:skill (MCP)", description: "팀 스킬", argumentHint: "" },
  { name: "code-review", description: "내 리뷰(겹침)", argumentHint: "" },
  { name: "statusline", description: "terminal", argumentHint: "" },
];

test("usableCommands: 터미널 전용·내부 명령은 빼고, 겹치는 이름은 Claude Code 것, MCP 접미사는 걷는다", () => {
  const { commands, names } = usableCommands(RAW);
  assert.deepEqual(commands, [
    { name: "code-review", description: "Review the diff", argumentHint: "[low|high]" },
    { name: "docs", description: "Docs skill", argumentHint: "" },
    { name: "my-plugin:skill", description: "팀 스킬", argumentHint: "" },
  ]);
  assert.ok(names.has("anthropic-skills:docs"), "별칭도 아는 이름");
  assert.ok(!names.has("reset") && !names.has("cost"), "뺀 명령의 별칭은 모른다");
  assert.deepEqual(usableCommands(RAW, ["docs"]).commands.map((c) => c.name), ["code-review", "my-plugin:skill"]);
});

test("slashName: 맨 앞 /이름 만(뒤는 공백·끝)", () => {
  assert.equal(slashName("/code-review high"), "code-review");
  assert.equal(slashName("  /docs"), "docs");
  assert.equal(slashName("/my-plugin:skill hello-world\n더"), "my-plugin:skill");
  assert.equal(slashName("/usr/bin 경로 알려줘"), null);
  assert.equal(slashName("코드 /code-review"), null);
  assert.equal(slashName("/"), null);
});

test("SlashCommands: 한 번만 불러오고(동시 요청도) 10분 뒤 다시, 실패면 예전 것", async () => {
  let t = 0, calls = 0, fail = false;
  const reg = new SlashCommands(async () => { calls++; if (fail) throw new Error("x"); return calls === 1 ? RAW : [{ name: "new-one", description: "", argumentHint: "" }]; }, { now: () => t });
  const [a, b] = await Promise.all([reg.list(), reg.list()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(await reg.match("/code-review high"), "code-review");
  assert.equal(await reg.match("/Docs"), "Docs");
  assert.equal(await reg.match("/anthropic-skills:docs 써줘"), "anthropic-skills:docs");
  assert.equal(await reg.match("/model opus"), null, "뺀 명령은 보통 채팅");
  assert.equal(await reg.match("/foo"), null);
  assert.equal(await reg.match("안녕"), null);
  t = 9 * 60_000; await reg.list(); assert.equal(calls, 1);
  t = 10 * 60_000; fail = true;
  assert.equal((await reg.list()).length, 3, "실패하면 예전 목록");
  assert.equal(calls, 2);
  await reg.list(); assert.equal(calls, 2, "실패 뒤에도 10분은 다시 안 부른다");
  t = 21 * 60_000; fail = false;
  assert.deepEqual((await reg.list()).map((c) => c.name), ["new-one"]);
  const empty = new SlashCommands(async () => { throw new Error("no sdk"); });
  assert.deepEqual(await empty.list(), []);
  assert.equal(await empty.match("/code-review"), null);
});

test("loadCommands: 프롬프트를 보내지 않고 목록만 읽은 뒤 닫는다", async () => {
  const seen: any = {};
  const fakeQuery: any = ({ prompt, options }: any) => {
    seen.options = options;
    let closed = false;
    const it = (async function* () {
      yield { type: "system", subtype: "hook_started" };
      for await (const m of prompt) seen.sent = m; // 입력이 끝나야(닫혀야) 끝난다
      while (!closed) await new Promise((r) => setTimeout(r, 5));
    })();
    return Object.assign(it, {
      supportedCommands: async () => RAW,
      close: () => { closed = true; seen.closed = true; },
    });
  };
  const cwd = mkdtempSync(join(tmpdir(), "cy-cmds-"));
  const got = await loadCommands({ cwd, query: fakeQuery });
  assert.equal(got, RAW);
  assert.equal(seen.sent, undefined, "사용자 메시지를 안 보냄 — 모델 턴 없음");
  assert.equal(seen.closed, true);
  assert.equal(seen.options.cwd, cwd);
  assert.deepEqual(seen.options.settingSources, ["user", "project"]);
  assert.ok(seen.options.abortController.signal.aborted);
  const hang: any = () => Object.assign((async function* () {})(), { supportedCommands: () => new Promise(() => {}), close() {} });
  await assert.rejects(loadCommands({ cwd, query: hang, timeoutMs: 20 }), /시간 초과/);
});
