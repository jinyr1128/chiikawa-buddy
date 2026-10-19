import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { buildContext } from "./brain.ts";
import { ensureMergeTables } from "./kg/merge.ts";

test("buildContext: 최근 세션을 프로젝트별로, 열린 할 일을 id와 함께 넣는다", () => {
  const s = new Store(":memory:");
  const now = new Date("2026-10-08T09:00:00Z");
  s.upsertNode("session:a", "session", "버튼 색 변경", { cwd: "/r/app", tool: "claude", turns: 3, lastPrompt: "파란색으로" }, "2026-10-08T08:00:00Z");
  s.upsertNode("session:old", "session", "옛날 일", { cwd: "/r/app", tool: "claude", turns: 1 }, "2026-10-01T08:00:00Z");
  s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 1 });
  const ctx = buildContext(s, now);
  assert.match(ctx, /### \/r\/app/);
  assert.match(ctx, /버튼 색 변경/);
  assert.match(ctx, /마지막 요청: 파란색으로/);
  assert.doesNotMatch(ctx, /옛날 일/);
  assert.match(ctx, /id=mail:1 \[P1\] 견적 회신/);
});

test("buildContext: 숨긴 프로젝트의 세션·KG 프로젝트 줄은 프롬프트에서 뺀다", () => {
  const s = new Store(":memory:");
  const now = new Date("2026-10-08T09:00:00Z");
  s.upsertNode("session:a", "session", "보이는 일", { cwd: "/r/app", tool: "claude", turns: 3 }, "2026-10-08T08:00:00Z");
  s.upsertNode("session:b", "session", "숨긴 일", { cwd: "/r/secret/sub", tool: "claude", turns: 3 }, "2026-10-08T08:00:00Z");
  ensureMergeTables(s);
  const ins = s.db.prepare("INSERT INTO kg_entities (id, kind, name, props, first_seen, last_seen, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("project:secret", "project", "secret", JSON.stringify({ aliases: [], description: "비밀 프로젝트" }), "2026-10-01", "2026-10-08", 3);
  ins.run("project:app", "project", "app", JSON.stringify({ aliases: [], description: "앱" }), "2026-10-01", "2026-10-08", 3);
  const before = buildContext(s, now);
  assert.match(before, /숨긴 일/);
  assert.match(before, /secret: 비밀 프로젝트/);
  s.hideProject("/r/secret", "secret");
  const ctx = buildContext(s, now);
  assert.match(ctx, /보이는 일/);
  assert.doesNotMatch(ctx, /숨긴 일/);
  assert.doesNotMatch(ctx, /비밀 프로젝트/);
  assert.match(ctx, /app: 앱/);
  assert.ok(s.db.prepare("SELECT 1 FROM kg_entities WHERE id = 'project:secret'").get(), "KG는 그대로");
});

test("stoppable: 채팅 run 에 정지 손잡이(stoppable, interactive 아님) — 정지하면 abort, abort 되면 run 은 stopped", async () => {
  const { RunRegistry, withRun } = await import("./runs.ts");
  const { stoppable } = await import("./brain.ts");
  const reg = new RunRegistry();
  const abort = new AbortController();
  let id = "";
  const p = withRun({ kind: "chat", title: "채팅: 길게" }, async (run) => {
    id = run.id;
    stoppable(run, abort);
    const s = reg.summary(run.id)!;
    assert.equal(s.stoppable, true);
    assert.equal(s.interactive, false); // 메시지는 안 받는다(입력창 모드 그대로)
    await new Promise((_r, rej) => abort.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  }, reg);
  while (!id) await new Promise((x) => setTimeout(x, 1));
  assert.deepEqual(await reg.stop(id), { ok: true });
  await assert.rejects(p);
  const s = reg.summary(id)!;
  assert.equal(s.status, "stopped"); // withRun 의 failed 로 덮이지 않는다
  assert.equal(s.stoppable, undefined);
  assert.equal(abort.signal.aborted, true);
});

test("withAbort: 승인 카드 기다림 signal 에 멈춤 signal 을 합친다", async () => {
  const { withAbort } = await import("./brain.ts");
  const stop = new AbortController(), sdk = new AbortController();
  let seen: AbortSignal | undefined;
  const fn = withAbort(async (_n, input, o) => { seen = o.signal; return { behavior: "allow", updatedInput: input }; }, stop.signal);
  await fn("Bash", {}, { signal: sdk.signal } as any);
  assert.equal(seen!.aborted, false);
  stop.abort();
  assert.equal(seen!.aborted, true);
});
