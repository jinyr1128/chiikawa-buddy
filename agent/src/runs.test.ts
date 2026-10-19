import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, RunRegistry, compactInput, finalOutput, logSdkMessage, redact, summarizeRun, toolDiff, trackQuery, withRun, type RunUpdate } from "./runs.ts";

const reg = () => new RunRegistry(new DatabaseSync(":memory:"));

test("startRun → logEvent → endRun · getRun(since) · 실시간 구독", () => {
  const r = reg();
  const seen: RunUpdate[] = [];
  const unsub = r.subscribe((u) => seen.push(u));
  const run = r.startRun({ kind: "fix", title: "버튼 색", model: "m", cwd: "/tmp/x" });
  assert.equal(r.active().length, 1);
  run.log({ type: "user", text: "해줘" });
  run.log({ type: "assistant", text: "할게" });
  run.log({ type: "tool_use", name: "Bash", input: "npm test", toolUseId: "t1" });
  const all = r.getRun(run.id)!;
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(r.getRun(run.id, 2)!.events.map((e) => e.type), ["tool_use"]);
  run.end("done", { costUsd: 0.12 });
  const s = r.getRun(run.id)!.run;
  assert.equal(s.status, "done");
  assert.equal(s.costUsd, 0.12);
  assert.ok(s.endedAt);
  assert.equal(r.active().length, 0);
  assert.ok(seen.some((u) => u.type === "run" && u.seq === 2));
  assert.ok(seen.filter((u) => u.type === "runs").length >= 2);
  unsub();
  run.log({ type: "assistant", text: "끝난 뒤" }); // 끝난 run 에도 기록은 되지만(드묾) 구독은 끊김
  assert.equal(seen.filter((u) => u.type === "run" && (u as any).event.text === "끝난 뒤").length, 0);
  assert.equal(r.getRun("nope"), undefined);
});

test("listRuns: 돌고 있는 것 먼저, status 필터, limit", async () => {
  const r = reg();
  const a = r.startRun({ kind: "chat", title: "a" }); a.end("done");
  await new Promise((ok) => setTimeout(ok, 5));
  const b = r.startRun({ kind: "fix", title: "b" });
  await new Promise((ok) => setTimeout(ok, 5));
  const c = r.startRun({ kind: "briefing", title: "c" }); c.end("failed", { error: "x" });
  assert.deepEqual(r.listRuns().map((x) => x.title), ["b", "c", "a"]);
  assert.deepEqual(r.listRuns({ status: "failed" }).map((x) => x.title), ["c"]);
  assert.equal(r.listRuns({ limit: 1 }).length, 1);
  assert.equal(r.listRuns({ status: "failed" })[0].error, "x");
  b.end("stopped");
});

test("listRuns: 정기 작업이 아무리 많아도 내 작업은 따로 limit 개까지 보인다", async () => {
  const r = reg();
  r.startRun({ kind: "chat", title: "내 대화" }).end("done");
  r.startRun({ kind: "fix", title: "내 수정" }).end("done");
  await new Promise((ok) => setTimeout(ok, 5));
  for (let i = 0; i < 5; i++) r.startRun({ kind: "slack-ingest", title: `수집${i}`, routine: true }).end("done");
  r.startRun({ kind: "briefing", title: "정기 브리핑", routine: true }).end("done");
  const got = r.listRuns({ limit: 3 }).map((x) => x.title);
  assert.ok(got.includes("내 대화") && got.includes("내 수정"), got.join(","));
  assert.equal(got.filter((t) => t.startsWith("수집") || t === "정기 브리핑").length, 3);
});

test("잘라내기: tool_result 4KB, 텍스트 16KB, 원래 크기 기록", () => {
  const r = reg();
  const run = r.startRun({ kind: "fix", title: "t" });
  const big = "x".repeat(10_000);
  const e = run.log({ type: "tool_result", toolUseId: "t", output: big })!;
  assert.equal(e.output!.length, LIMITS.toolOutput);
  assert.equal(e.truncated, true);
  assert.equal(e.size, 10_000);
  const t = run.log({ type: "assistant", text: "y".repeat(20_000) })!;
  assert.equal(t.text!.length, LIMITS.text);
  const stored = r.getRun(run.id)!.events[0];
  assert.equal(stored.output!.length, LIMITS.toolOutput);
});

test("비밀 가리기", () => {
  const s = redact("token xoxb-1234567890-abcdefghij and sk-ant-api03-AAAAAAAAAAAA and ghp_abcdefghijklmnopqrstuvwxyz12 password=hunter2pass Bearer abcdefghijkl");
  for (const bad of ["xoxb-1234567890", "sk-ant-api03", "ghp_abc", "hunter2pass", "abcdefghijkl"]) assert.ok(!s.includes(bad), bad);
  const r = reg();
  const run = r.startRun({ kind: "fix", title: "t" });
  const e = run.log({ type: "tool_use", name: "Bash", input: "curl -H 'Authorization: Bearer sk-ant-api03-SECRETSECRET'" })!;
  assert.ok(!e.input!.includes("SECRETSECRET"));
});

test("중계 run(slack-ingest·calendar): 본문 없이 이름·크기만", () => {
  const r = reg();
  for (const kind of ["slack-ingest", "calendar"] as const) {
    const run = r.startRun({ kind, title: kind });
    const u = run.log({ type: "user", text: "CALL slack.read channel=C1 비밀 메시지" })!;
    const a = run.log({ type: "assistant", text: "김철수: 내일 회의 취소" })!;
    const t = run.log({ type: "tool_use", name: "mcp__slack__conversations_history", input: '{"channel":"C1"}', diff: [{ file: "f", old: "a", new: "b" }] })!;
    const o = run.log({ type: "tool_result", toolUseId: "x", output: "secret body text" })!;
    assert.ok(!u.text!.includes("비밀"), kind);
    assert.ok(!a.text!.includes("철수"), kind);
    assert.equal(a.size, "김철수: 내일 회의 취소".length);
    assert.equal(t.name, "mcp__slack__conversations_history");
    assert.equal(t.input, undefined);
    assert.equal(t.diff, undefined);
    assert.equal(o.output, undefined);
    assert.equal(o.size, 16);
    const stored = JSON.stringify(r.getRun(run.id));
    assert.ok(!stored.includes("secret body") && !stored.includes("철수"), kind);
  }
  // 세션 창에서 이어 물은 말과 그 답은 중계 run 이어도 남긴다(답이 「기록 안 함」 으로 지워지던 것)
  const s = r.startRun({ kind: "slack-ingest", title: "s" });
  assert.equal(s.log({ type: "user", text: "먼데?최근슬랙", injected: true, followUp: true })!.text, "먼데?최근슬랙");
  assert.equal(s.log({ type: "assistant", text: "최근 Slack 은 이거예요", followUp: true })!.text, "최근 Slack 은 이거예요");
  assert.equal(s.log({ type: "assistant", text: "김철수: 내일 회의 취소" })!.text, `(본문 ${"김철수: 내일 회의 취소".length}자 — 기록 안 함)`);
  // 일반 run 은 본문을 남긴다
  const f = r.startRun({ kind: "fix", title: "f" });
  assert.equal(f.log({ type: "assistant", text: "고쳤어" })!.text, "고쳤어");
});

test("run 당 이벤트 상한: 넘으면 저장 안 하고 dropped 로 센다(status/result 는 남김)", () => {
  const r = reg();
  const run = r.startRun({ kind: "fix", title: "t" });
  for (let i = 0; i < LIMITS.eventsPerRun + 5; i++) run.log({ type: "assistant", text: `m${i}` });
  run.log({ type: "result", text: "ok" });
  run.end("done");
  const g = r.getRun(run.id)!;
  assert.equal(g.run.dropped, 5);
  assert.equal(g.run.events, LIMITS.eventsPerRun + 7);
  assert.equal(g.events.length, LIMITS.eventsPerRun + 2);
  assert.deepEqual(g.events.slice(-2).map((e) => e.type), ["result", "status"]);
});

test("정리: 14일 지난 끝난 run 만 지운다 · 재시작 시 돌던 run 은 failed", () => {
  const db = new DatabaseSync(":memory:");
  const r = new RunRegistry(db);
  const old = r.startRun({ kind: "chat", title: "old" }); old.log({ type: "user", text: "x" }); old.end("done");
  const oldRunning = r.startRun({ kind: "fix", title: "old-running" });
  db.prepare("UPDATE runs SET started_at = ?").run(new Date(Date.now() - 20 * 864e5).toISOString());
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date().toISOString(), oldRunning.id);
  const ancientRunning = r.startRun({ kind: "fix", title: "ancient" });
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 864e5).toISOString(), ancientRunning.id);
  const fresh = r.startRun({ kind: "chat", title: "fresh" }); fresh.end("done");
  assert.equal(r.prune(), 1);
  assert.equal(r.getRun(old.id), undefined);
  assert.equal((db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id = ?").get(old.id) as any).n, 0);
  assert.ok(r.getRun(ancientRunning.id)); // 돌고 있는 건 안 지움
  const r2 = new RunRegistry(db); // 데몬 재시작
  assert.equal(r2.getRun(oldRunning.id)!.run.status, "failed");
  assert.match(r2.getRun(oldRunning.id)!.run.error!, /재시작/);
  // 재시작 뒤엔 이어서 seq 가 증가
  assert.ok(r2.getRun(fresh.id));
});

test("마이그레이션: 예전 runs 표(열 일부만)에도 붙는다", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, status TEXT NOT NULL)");
  const r = new RunRegistry(db);
  const run = r.startRun({ kind: "fix", title: "t", cwd: "/x", ref: "p1" });
  run.setSession("sess-1");
  run.end("done");
  const s = r.getRun(run.id)!.run;
  assert.equal(s.cwd, "/x");
  assert.equal(s.sdkSessionId, "sess-1");
  assert.equal(s.ref, "p1");
});

test("제어: 없는 run 404, 끝난 run·입력 없는 run 409, 보낸 메시지는 user(injected) 로 기록", async () => {
  const r = reg();
  assert.equal((await r.sendMessage("nope", "x") as any).status, 404);
  const ro = r.startRun({ kind: "chat", title: "ro" });
  assert.equal((await r.sendMessage(ro.id, "x") as any).status, 409);
  assert.equal(r.summary(ro.id)!.interactive, false);
  const got: string[] = [];
  let interrupted = 0, stopped = 0;
  const run = r.startRun({ kind: "fix", title: "t", control: { send: (t) => { got.push(t); }, interrupt: () => { interrupted++; }, stop: () => { stopped++; } } });
  assert.equal(r.summary(run.id)!.interactive, true);
  assert.deepEqual(await r.sendMessage(run.id, "README 도"), { ok: true });
  assert.deepEqual(got, ["README 도"]);
  const ev = r.getRun(run.id)!.events.at(-1)!;
  assert.equal(ev.type, "user");
  assert.equal(ev.injected, true);
  await r.interrupt(run.id); await r.stop(run.id);
  assert.equal(interrupted, 1); assert.equal(stopped, 1);
  run.end("stopped");
  assert.equal((await r.sendMessage(run.id, "x") as any).status, 409);
  // send 가 던지면 409
  const closed = r.startRun({ kind: "fix", title: "c", control: { send: () => { throw new Error("input closed"); } } });
  assert.equal((await r.sendMessage(closed.id, "x") as any).status, 409);
});

test("모델 바꾸기: 제어가 받으면 run 모델·기록 갱신, 못 받으면 409", async () => {
  const r = reg();
  const set: string[] = [];
  const run = r.startRun({ kind: "fix", title: "t", model: "claude-opus-5-5", control: { send: () => {}, setModel: (m) => { set.push(m); } } });
  assert.deepEqual(await r.setModel(run.id, "claude-sonnet-5-5"), { ok: true });
  assert.deepEqual(set, ["claude-sonnet-5-5"]);
  assert.equal(r.summary(run.id)!.model, "claude-sonnet-5-5");
  assert.match(r.getRun(run.id)!.events.at(-1)!.text ?? "", /claude-sonnet-5-5/);
  assert.equal((await r.setModel("nope", "x") as any).status, 404);
  const noCtl = r.startRun({ kind: "fix", title: "n", control: { send: () => {} } });
  assert.equal((await r.setModel(noCtl.id, "x") as any).status, 409);
  const bad = r.startRun({ kind: "fix", title: "b", control: { setModel: () => { throw new Error("input closed"); } } });
  assert.equal((await r.setModel(bad.id, "x") as any).status, 409);
  assert.equal(r.summary(bad.id)!.model, "");
});

test("SDK 메시지 → 이벤트: assistant 텍스트·tool_use(+diff)·tool_result·init·result, thinking 숨김, 서브에이전트는 parent 로", async () => {
  const r = reg();
  const run = r.startRun({ kind: "fix", title: "t" });
  const msgs = [
    { type: "system", subtype: "init", session_id: "s-1", model: "opus", cwd: "/w" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "thinking", thinking: "속마음" }, { type: "text", text: "고칠게" }, { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "/w/a.ts", old_string: "red", new_string: "blue" } }] } },
    { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }] } },
    { type: "assistant", parent_tool_use_id: "tu9", message: { content: [{ type: "text", text: "서브에이전트" }] } },
    { type: "user", parent_tool_use_id: null, uuid: "u-inj", message: { role: "user", content: "주입됨(이미 기록)" } },
    { type: "result", subtype: "success", result: "끝", total_cost_usd: 0.5 },
  ];
  async function* gen() { for (const m of msgs) yield m; }
  const out: any[] = [];
  for await (const m of trackQuery(run, gen(), { skipUserUuids: new Set(["u-inj"]) })) out.push(m);
  assert.equal(out.length, msgs.length);
  const ev = r.getRun(run.id)!;
  assert.equal(ev.run.sdkSessionId, "s-1");
  assert.equal(ev.run.costUsd, 0.5);
  const types = ev.events.map((e) => e.type);
  assert.deepEqual(types, ["system", "assistant", "tool_use", "tool_result", "assistant", "result"]);
  assert.ok(!JSON.stringify(ev).includes("속마음"));
  assert.equal(ev.events[4].text, "서브에이전트");
  assert.equal(ev.events[4].parent, "tu9");
  assert.equal(ev.events[1].parent, undefined);
  const tu = ev.events[2];
  assert.equal(tu.input, "/w/a.ts");
  assert.deepEqual(tu.diff, [{ file: "/w/a.ts", old: "red", new: "blue" }]);
  assert.equal(ev.events[3].output, "ok");
  assert.equal(ev.events[3].toolUseId, "tu1");
});

test("compactInput·toolDiff", () => {
  assert.equal(compactInput("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(compactInput("Grep", { pattern: "foo", path: "src" }), "foo in src");
  assert.equal(compactInput("mcp__x__invoke", { service: "slack", tool: "read" }), "slack.read()");
  assert.equal(compactInput("mcp__x__invoke", { service: "mail", tool: "list_events", args: { top: 5 } }), 'mail.list_events({"top":5})');
  assert.equal(compactInput("WebFetch", { url: "https://a.b/c", prompt: "요약" }), "https://a.b/c");
  assert.equal(compactInput("WebSearch", { query: "node 26" }), "node 26");
  assert.equal(compactInput("Agent", { description: "파일 찾기", prompt: "x".repeat(5000), subagent_type: "Explore" }), "파일 찾기");
  assert.equal(compactInput("TodoWrite", { todos: [{}, {}] }), "할 일 2개");
  assert.equal(compactInput("mcp__x__y", { a: 1 }), '{"a":1}');
  assert.equal(toolDiff("Write", { file_path: "a", content: "x" })![0].new, "x");
  assert.equal(toolDiff("MultiEdit", { file_path: "a", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] })!.length, 2);
  assert.equal(toolDiff("Read", { file_path: "a" }), undefined);
});

test("tool_use 입력: 비밀 가리기 + 길이 상한(넘치면 …)", () => {
  const r = reg();
  const run = r.startRun({ kind: "chat", title: "t" });
  const long = `echo ${"a".repeat(LIMITS.toolInput + 50)}`;
  logSdkMessage(run, { type: "assistant", message: { content: [
    { type: "tool_use", id: "b1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijkl' x" } },
    { type: "tool_use", id: "b2", name: "Bash", input: { command: long } },
    { type: "tool_use", id: "b3", name: "mcp__relay__invoke", input: { service: "slack", tool: "post", args: { token: "xoxb-1234567890-abcdef" } } },
  ] } });
  const ev = r.getRun(run.id)!.events.filter((e) => e.type === "tool_use");
  assert.ok(!ev[0].input!.includes("abcdefghijkl"));
  assert.ok(ev[0].input!.includes("«redacted»"));
  assert.equal(ev[1].input!.length, LIMITS.toolInput + 1);
  assert.ok(ev[1].input!.endsWith("…"));
  assert.ok(!ev[2].input!.includes("xoxb-1234567890"));
  assert.ok(ev[2].input!.startsWith("slack.post("));
});

test("withRun: 성공 done, 예외 failed", async () => {
  const r = reg();
  assert.equal(await withRun({ kind: "chat", title: "ok" }, async () => 7, r), 7);
  await assert.rejects(withRun({ kind: "chat", title: "bad" }, async () => { throw new Error("boom"); }, r), /boom/);
  const ok = r.listRuns().find((x) => x.title === "ok")!, bad = r.listRuns().find((x) => x.title === "bad")!;
  assert.equal(ok.status, "done");
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "boom");
  const l = logSdkMessage; assert.ok(l); // export 확인
});

test("서브에이전트 기록: Agent 줄 아래 parent 로 지시·글·도구·결과(가림·자르기 같음), thinking 숨김, 하나당 상한을 넘으면 첫 줄만 두고 최근 것만", async () => {
  const r = reg();
  const run = r.startRun({ kind: "chat", title: "t" });
  const sub = (m: any) => ({ ...m, parent_tool_use_id: "ag1" });
  const big = "x".repeat(LIMITS.toolOutput + 50);
  const msgs: any[] = [
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "레포 조사", prompt: "README 읽어", subagent_type: "Explore" } }] } },
    sub({ type: "user", message: { role: "user", content: [{ type: "text", text: "README 읽어" }] } }),
    sub({ type: "assistant", message: { content: [{ type: "thinking", thinking: "서브 속마음" }, { type: "text", text: "읽어 볼게요 token=abcdef123456" }, { type: "tool_use", id: "s1", name: "Read", input: { file_path: "/w/README.md" } }] } }),
    sub({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: big }] } }),
    sub({ type: "system", subtype: "task_progress" }), // 그 밖 서브 메시지는 무시
    { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "README 요약: 데몬+데스크톱" }] }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "정리했어요" }] } },
    { type: "result", subtype: "success", result: "정리했어요" },
  ];
  async function* gen() { for (const m of msgs) yield m; }
  for await (const _ of trackQuery(run, gen())) { /* 흘려보내기 */ }
  const ev = r.getRun(run.id)!.events;
  assert.ok(!JSON.stringify(ev).includes("서브 속마음"));
  const nested = ev.filter((e) => e.parent === "ag1");
  assert.deepEqual(nested.map((e) => e.type), ["user", "assistant", "tool_use", "tool_result"]);
  assert.equal(nested[0].text, "README 읽어");
  assert.match(nested[1].text!, /token=«redacted»/);
  assert.equal(nested[2].name, "Read");
  assert.equal(nested[2].input, "/w/README.md");
  assert.equal(nested[3].toolUseId, "s1");
  assert.equal(nested[3].truncated, true);
  assert.equal(nested[3].output!.length, LIMITS.toolOutput);
  // Agent 줄과 그 최종 결과는 맨 위(parent 없음)
  const top = ev.filter((e) => !e.parent);
  assert.deepEqual(top.map((e) => e.type), ["tool_use", "tool_result", "assistant", "result"]);
  assert.equal(top[0].input, "레포 조사");
  assert.equal(top[1].output, "README 요약: 데몬+데스크톱");
  // 이어서 하기 요약·마지막 결과에는 서브에이전트 안 글이 끼지 않는다
  assert.equal(finalOutput(ev), "정리했어요");
  assert.ok(!summarizeRun(r.getRun(run.id)!.run, ev).includes("읽어 볼게요"));

  // 상한: 서브에이전트 하나당 eventsPerSubagent 개 — 넘으면 첫 줄(지시)만 두고 오래된 것부터 지워 최근 진행이 남는다. 다른 서브에이전트는 따로 센다
  const run2 = r.startRun({ kind: "fix", title: "t2" });
  const flood = Array.from({ length: LIMITS.eventsPerSubagent + 30 }, (_, i) => ({ type: "assistant", parent_tool_use_id: "agA", message: { content: [{ type: "text", text: `줄 ${i}` }] } }));
  async function* gen2() { yield* flood; yield { type: "assistant", parent_tool_use_id: "agB", message: { content: [{ type: "text", text: "다른 서브" }] } }; }
  for await (const _ of trackQuery(run2, gen2())) { /* */ }
  const e2 = r.getRun(run2.id)!.events;
  const a = e2.filter((e) => e.parent === "agA");
  assert.equal(a.length, LIMITS.eventsPerSubagent);
  assert.equal(a[0].text, "줄 0"); // 첫 줄은 남는다
  assert.equal(a[a.length - 1].text, `줄 ${LIMITS.eventsPerSubagent + 29}`); // 마지막(최근)도 남는다
  assert.ok(!a.some((e) => e.text === "줄 1")); // 오래된 중간은 지워짐
  assert.equal(e2.filter((e) => e.parent === "agB").length, 1);
  // parent 모양이 이상하면 버린다
  const bad = r.logEvent(run2.id, { type: "assistant", text: "x", parent: "../../etc" as any });
  assert.equal(bad!.parent, undefined);
});

// 새 OpenAI 키 모양(sk-proj-·sk-svcacct-, 밑줄·하이픈 섞임)도 가린다. 진짜 키 아님
const SK_SHAPES = ["sk-proj-unitTEST_not-real_0000aaaa", "sk-svcacct-unit_TEST-not-real-0000bbbb", "sk-ant-api03-unit_TEST-not-real-cccc", "sk-unitTESTnotreal0000dddd"];
test("redact: sk-proj-·sk-svcacct-·sk-ant- 키도 가린다", () => {
  for (const k of SK_SHAPES) assert.equal(redact(`key=${k} 끝`).includes(k.slice(3, 15)), false, k);
  assert.match(redact("task-notification 은 그대로"), /task-notification/);
});