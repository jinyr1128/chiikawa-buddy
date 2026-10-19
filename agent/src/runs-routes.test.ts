// /runs* 라우트 + SSE run/runs 이벤트
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Bus } from "./bus.ts";
import { RunRegistry } from "./runs.ts";

async function serve() {
  const reg = new RunRegistry(new DatabaseSync(":memory:"));
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [], runs: reg,
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body?: unknown, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { reg, bus, base, post };
}

test("GET /runs · /runs/:id?since · 잘못된 입력 400 · 없는 run 404", async () => {
  const { reg, bus, base } = await serve();
  try {
    const a = reg.startRun({ kind: "chat", title: "채팅" }); a.log({ type: "user", text: "안녕" }); a.end("done");
    const b = reg.startRun({ kind: "fix", title: "수정" }); b.log({ type: "assistant", text: "1" }); b.log({ type: "assistant", text: "2" });
    const list = await (await fetch(`${base}/runs`)).json();
    assert.deepEqual(list.runs.map((r: any) => r.title), ["수정", "채팅"]);
    const running = await (await fetch(`${base}/runs?status=running&limit=5`)).json();
    assert.deepEqual(running.runs.map((r: any) => r.id), [b.id]);
    const one = await (await fetch(`${base}/runs/${b.id}?since=1`)).json();
    assert.equal(one.run.id, b.id);
    assert.deepEqual(one.events.map((e: any) => e.text), ["2"]);
    assert.equal((await fetch(`${base}/runs?limit=0`)).status, 400);
    assert.equal((await fetch(`${base}/runs?status=weird`)).status, 400);
    assert.equal((await fetch(`${base}/runs/${b.id}?since=-1`)).status, 400);
    assert.equal((await fetch(`${base}/runs/nope`)).status, 404);
  } finally { bus.close(); }
});

test("POST /runs/:id/message|interrupt|stop: CSRF 403, 입력 검증, 읽기 전용 409", async () => {
  const { reg, bus, post } = await serve();
  try {
    const got: string[] = [];
    const run = reg.startRun({ kind: "fix", title: "수정", control: { send: (t) => { got.push(t); }, interrupt: () => { got.push("!int"); }, stop: () => { got.push("!stop"); } } });
    const ro = reg.startRun({ kind: "briefing", title: "브리핑" });
    assert.equal((await post(`/runs/${run.id}/message`, { text: "x" }, {})).status, 403);
    assert.equal((await post(`/runs/${run.id}/message`, { text: "x" }, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post(`/runs/${run.id}/message`, { text: "  " })).status, 400);
    assert.equal((await post(`/runs/${run.id}/message`, { text: "README 도" })).status, 200);
    assert.equal((await post(`/runs/${run.id}/interrupt`)).status, 200);
    assert.equal((await post(`/runs/${run.id}/stop`)).status, 200);
    assert.deepEqual(got, ["README 도", "!int", "!stop"]);
    assert.equal((await post(`/runs/${ro.id}/message`, { text: "x" })).status, 409);
    assert.equal((await post(`/runs/${ro.id}/stop`)).status, 409);
    assert.equal((await post(`/runs/nope/message`, { text: "x" })).status, 404);
  } finally { bus.close(); }
});

test("SSE: 접속 시 runs 스냅샷, run 이벤트·runs 요약 실시간", async () => {
  const { reg, bus, base } = await serve();
  const ac = new AbortController();
  try {
    const pre = reg.startRun({ kind: "fix", title: "이미 도는 중" });
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    const until = async (s: string) => { while (!buf.includes(s)) buf += new TextDecoder().decode((await reader.read()).value); };
    await until("event: runs");
    assert.match(buf, new RegExp(pre.id));
    const run = reg.startRun({ kind: "chat", title: "새 run" });
    run.log({ type: "assistant", text: "스트리밍" });
    run.end("done");
    await until('"status":"done"');
    assert.match(buf, /event: run\ndata: \{"id":"[\w-]+","seq":1,"event":\{[^\n]*"스트리밍"/);
    assert.match(buf, /event: runs\ndata: \{"run":\{[^\n]*"새 run"/);
  } finally { ac.abort(); bus.close(); }
});
