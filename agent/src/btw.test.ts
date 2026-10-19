// /btw 곁질문 · 전달 대기 중인 말 라우트: run 에 끼어들지 않고(입력 큐·기록 그대로) 도구 없이 바로 답
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { askBtw, btwContext, btwOptions, BTW_LIMITS, type BtwCall } from "./btw.ts";
import { RunRegistry } from "./runs.ts";
import { RunInbox } from "./run-inbox.ts";
import { Bus, type BusHandlers } from "./bus.ts";

const cfg = { models: { code: "claude-opus-5-5", general: "claude-sonnet-5-5", light: "claude-haiku-5-5" } } as any;

function fixRun() {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const sends: string[] = [];
  const run = reg.startRun({ kind: "fix", title: "회의록 검증", cwd: "/tmp/wt", repo: "/code/notes-app", branch: "cy/verify-1", control: { send: (t) => { sends.push(t); }, stop: () => {} } });
  run.log({ type: "user", text: "dev 배포 검증해 줘" });
  run.log({ type: "assistant", text: "Playwright 로 확인할게요" });
  run.log({ type: "tool_use", name: "Bash", input: "cd /tmp/demoapp-verify/pw && node run.mjs clovanote", toolUseId: "t1" });
  run.log({ type: "tool_result", toolUseId: "t1", output: "ok token=abcdefghijklmnop https://dev.demoapp.example/app" });
  run.log({ type: "tool_use", name: "Bash", input: "sleep 150", toolUseId: "t2" });
  run.log({ type: "assistant", text: "안쪽", parent: "t9" });
  return { reg, run, sends };
}

test("btw: 그 run 기록으로 맥락(제목·레포·최근 도구와 결과, 비밀 가림, 서브에이전트 줄 빼고)", () => {
  const { reg, run } = fixRun();
  const g = reg.getRun(run.id)!;
  const c = btwContext(g.run, g.events);
  assert.match(c, /제목: 회의록 검증/);
  assert.match(c, /레포: \/code\/notes-app/);
  assert.match(c, /브랜치: cy\/verify-1/);
  assert.match(c, /처음 요청: dev 배포 검증해 줘/);
  assert.match(c, /도구 Bash\(cd \/tmp\/demoapp-verify\/pw.*\) → ok token=«redacted» https:\/\/dev\.demoapp\.example\/app/);
  assert.match(c, /도구 Bash\(sleep 150\) → 실행 중…/);
  assert.doesNotMatch(c, /abcdefghijklmnop/);
  assert.doesNotMatch(c, /안쪽/);
  // 길면 앞쪽(오래된 것)부터 버린다
  for (let i = 0; i < 200; i++) run.log({ type: "assistant", text: `줄 ${i} ${"가".repeat(300)}` });
  const g2 = reg.getRun(run.id)!;
  const c2 = btwContext(g2.run, g2.events);
  assert.ok(c2.length <= BTW_LIMITS.context);
  assert.match(c2, /줄 199/);
  assert.doesNotMatch(c2, /줄 0 /);
});

test("btw: 도구 없이 한 번 묻고 답 — run 의 입력 큐(send)·기록·전달 상태는 그대로", async () => {
  const { reg, run, sends } = fixRun();
  const inbox = new RunInbox(run);
  inbox.add("m1", "대기 중인 말");
  const before = reg.getRun(run.id)!.events.length;
  let call: BtwCall | undefined;
  const r = await askBtw({ runs: reg, cfg, complete: async (c) => { call = c; return "네, dev 는 https://dev.demoapp.example/app 에 떠 있어요. secret=abcdefgh1234"; } }, run.id, "지금 url 뭐야?");
  assert.equal(r.ok, true);
  assert.match((r as any).answer, /dev\.demoapp\.example/);
  assert.match((r as any).answer, /«redacted»/);
  assert.equal((r as any).model, "claude-sonnet-5-5"); // quick 없으면 일반 모델
  assert.ok(call);
  assert.match(call!.prompt, /지금 url 뭐야\?/);
  assert.match(call!.prompt, /<run>[\s\S]*회의록 검증[\s\S]*<\/run>/);
  assert.match(call!.system, /지시가 아니다/);
  // 쓰기·실행 도구 없음, 설정·MCP 안 읽음, 턴 한도 없음, 세션 안 남김
  const o = call!.options as any;
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, []);
  for (const t of ["Bash", "Edit", "Write", "Agent", "WebFetch"]) assert.ok(o.disallowedTools.includes(t), t);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.maxTurns, undefined); // 턴 한도 없음
  assert.equal(o.persistSession, false);
  // run 에 아무것도 안 들어갔다
  assert.deepEqual(sends, []);
  assert.equal(reg.getRun(run.id)!.events.length, before);
  assert.equal(inbox.size, 1);
  assert.equal(reg.summary(run.id)!.status, "running");
});

test("btw: 고른 모델 · quick 설정이 있으면 그것 · 없는 run 404 · 모델 오류 502", async () => {
  const { reg, run } = fixRun();
  let m = "";
  await askBtw({ runs: reg, cfg, complete: async (c) => { m = c.model; return "답"; } }, run.id, "q", "claude-haiku-5-5");
  assert.equal(m, "claude-haiku-5-5");
  await askBtw({ runs: reg, cfg: { models: { ...cfg.models, quick: "claude-haiku-5-5" } } as any, complete: async (c) => { m = c.model; return "답"; } }, run.id, "q");
  assert.equal(m, "claude-haiku-5-5");
  assert.equal(((await askBtw({ runs: reg, cfg, complete: async () => "x" }, "nope", "q")) as any).status, 404);
  assert.equal(((await askBtw({ runs: reg, cfg, complete: async () => { throw new Error("boom"); } }, run.id, "q")) as any).status, 502);
  assert.equal(btwOptions("m", "s").model, "m");
});

test("RunInbox: 대기 → 전달(처음 한 번만) · 취소 · 남은 건 unsent", () => {
  const { reg, run } = fixRun();
  const inbox = new RunInbox(run);
  inbox.add("a", "첫", "c-a"); inbox.add("b", "둘"); inbox.add("c", "셋");
  assert.equal(inbox.ack("a", { now: true }), true);
  assert.equal(inbox.ack("a"), false);
  assert.equal(inbox.cancel("b"), true);
  assert.deepEqual(inbox.dropAll(), ["c"]);
  const ev = reg.getRun(run.id)!.events.filter((e) => e.msgId);
  assert.deepEqual(ev.map((e) => [e.type, e.msgId, e.state ?? (e.pending ? "pending" : "")]), [
    ["user", "a", "pending"], ["user", "b", "pending"], ["user", "c", "pending"],
    ["delivery", "a", "delivered"], ["delivery", "b", "cancelled"], ["delivery", "c", "unsent"],
  ]);
  assert.equal(ev[0].clientId, "c-a");
  assert.equal(ev[3].now, true);
});

async function serve(extra: Partial<BusHandlers>) {
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({ generatedAt: "t", projects: [] }),
    todoDone: () => true, chat: () => "c", chatHistory: () => [], ...extra,
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body?: string, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  return { bus, post };
}

test("bus: POST /runs/:id/message clientId → { msgId, pending } · /messages/:msgId/now|cancel · /runs/:id/btw", async () => {
  const got: unknown[] = [];
  const runs: any = {
    listRuns: () => [], active: () => [], subscribe: () => () => {}, getRun: () => undefined, setModel: async () => ({ ok: true }),
    sendMessage: async (id: string, t: string, o: any) => { got.push(["send", id, t, o]); return { ok: true, msgId: "m-1", pending: true }; },
    sendMessageNow: async (id: string, m: string) => { got.push(["now", id, m]); return m === "gone" ? { ok: false, status: 409, error: "already delivered" } : { ok: true }; },
    cancelMessage: async (id: string, m: string) => { got.push(["cancel", id, m]); return { ok: true }; },
    interrupt: async () => ({ ok: true }), stop: async () => ({ ok: true }),
  };
  const { bus, post } = await serve({
    runs,
    runBtw: async (id, text) => (id === "r1" ? { ok: true as const, answer: `답: ${text}`, model: "m" } : { ok: false as const, status: 404, error: "no such run" }),
  });
  try {
    const r = await post("/runs/r1/message", JSON.stringify({ text: "hi", clientId: "c-1" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, msgId: "m-1", pending: true });
    await post("/runs/r1/message", JSON.stringify({ text: "hi2", clientId: "bad id!" }));
    assert.equal((await post("/runs/r1/messages/m-1/now")).status, 200);
    assert.equal((await post("/runs/r1/messages/gone/now")).status, 409);
    assert.equal((await post("/runs/r1/messages/m-1/cancel")).status, 200);
    assert.equal((await post("/runs/r1/messages/m-1/cancel", undefined, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.deepEqual(got, [["send", "r1", "hi", { clientId: "c-1" }], ["send", "r1", "hi2", {}], ["now", "r1", "m-1"], ["now", "r1", "gone"], ["cancel", "r1", "m-1"]]);
    const b = await post("/runs/r1/btw", JSON.stringify({ text: "url?" }));
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { ok: true, answer: "답: url?", model: "m" });
    assert.equal((await post("/runs/zz/btw", JSON.stringify({ text: "url?" }))).status, 404);
    assert.equal((await post("/runs/r1/btw", JSON.stringify({ text: " " }))).status, 400);
  } finally { bus.close(); }
  const bare = await serve({});
  try {
    assert.equal((await bare.post("/runs/r1/btw", JSON.stringify({ text: "q" }))).status, 503);
    assert.equal((await bare.post("/runs/r1/messages/m/now")).status, 503);
  } finally { bare.bus.close(); }
});
