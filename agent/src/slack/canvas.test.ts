import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { TodoCanvas, escapeCanvas, kstStamp, openDm, recentDoneTodos, todoCanvasMarkdown, type CanvasClient } from "./canvas.ts";

const NOW = new Date("2026-10-08T01:05:00Z"); // KST 10:05
const todo = (id: string, title: string, priority: number, extra: Record<string, unknown> = {}) =>
  ({ id, title, source: "mail", priority, status: "open", created: "2026-10-08T00:00:00Z", ...extra });

const slackErr = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { code: "slack_webapi_platform_error", data: { ok: false, error: code } });

function fakeClient(opts: { createErr?: string; editErr?: () => string | undefined; existing?: string } = {}) {
  const calls: { m: string; a: any }[] = [];
  let n = 0;
  const client: CanvasClient = {
    conversations: {
      open: async (a) => { calls.push({ m: "conversations.open", a }); return { ok: true, channel: { id: "D123" } }; },
      info: async (a) => { calls.push({ m: "conversations.info", a }); return { ok: true, channel: { id: a.channel, properties: { canvas: { file_id: opts.existing } } } }; },
      canvases: {
        create: async (a) => {
          calls.push({ m: "conversations.canvases.create", a });
          if (opts.createErr) throw slackErr(opts.createErr);
          return { ok: true, canvas_id: `F${++n}` };
        },
      },
    },
    canvases: {
      create: async (a) => { calls.push({ m: "canvases.create", a }); return { ok: true, canvas_id: `FS${++n}` }; },
      edit: async (a) => {
        calls.push({ m: "canvases.edit", a });
        const e = opts.editErr?.();
        if (e) throw slackErr(e);
        return { ok: true };
      },
      access: { set: async (a) => { calls.push({ m: "canvases.access.set", a }); return { ok: true }; } },
    },
  };
  return { client, calls, methods: () => calls.map((c) => c.m) };
}

test("kstStamp: UTC → KST", () => {
  assert.equal(kstStamp(NOW), "2026-10-08 10:05 KST");
  assert.equal(kstStamp(new Date("2026-10-08T15:30:00Z")), "2026-10-09 00:30 KST");
});

test("todoCanvasMarkdown: 우선순위별 묶음, 체크리스트·링크·출처", () => {
  const md = todoCanvasMarkdown([
    todo("a", "리뷰 답장", 1, { link: "https://mail/x" }),
    todo("b", "회의 준비", 2, { source: "calendar" }),
    todo("c", "읽을 거리", 3),
    todo("d", "이상한 우선순위", 9),
  ], NOW);
  assert.match(md, /^# cy 할 일\n마지막 업데이트: 2026-10-08 10:05 KST · 열린 일 4개/);
  const i1 = md.indexOf("## 🔴 오늘 꼭 (1)"), i2 = md.indexOf("## 🟡 이번 주 (1)"), i3 = md.indexOf("## ⚪️ 참고 (2)");
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2, md);
  assert.match(md, /- \[ \] \[리뷰 답장\]\(https:\/\/mail\/x\)  `mail`/);
  assert.match(md, /- \[ \] 회의 준비  `calendar`/);
  assert.ok(md.indexOf("이상한 우선순위") > i3);
  assert.doesNotMatch(md, /최근 완료/);
});

test("todoCanvasMarkdown: 비어 있으면 빈 섹션 없이 안내만", () => {
  const md = todoCanvasMarkdown([], NOW);
  assert.match(md, /열린 할 일이 없어/);
  assert.doesNotMatch(md, /## 🔴/);
});

test("todoCanvasMarkdown: 이스케이프 — 마크다운 문법·줄바꿈·위험한 링크", () => {
  const md = todoCanvasMarkdown([
    todo("a", "fix *bold* [x](y)\n_둘째 줄_", 1, { link: "javascript:alert(1)" }),
    todo("b", "괄호 링크", 2, { link: "https://x/a (b)" }),
  ], NOW);
  assert.match(md, /- \[ \] fix \\\*bold\\\* \\\[x\\\]\(y\) \\_둘째 줄\\_  `mail`/);
  assert.doesNotMatch(md, /javascript:/);
  assert.match(md, /\[괄호 링크\]\(https:\/\/x\/a%20%28b%29\)/);
  assert.equal(escapeCanvas("a\\b`c<d>"), "a\\\\b\\`c\\<d\\>");
});

test("todoCanvasMarkdown: 최근 완료 최대 10개, 추가 블록", () => {
  const done = Array.from({ length: 12 }, (_, i) => ({ ...todo(`d${i}`, `끝난 일 ${i}`, 2), status: "done" }));
  const md = todoCanvasMarkdown([todo("a", "열린 일", 1)], NOW, { done, blocks: [{ title: "메모", markdown: "오늘 할 일 3개" }, { markdown: "  " }] });
  assert.match(md, /## ✅ 최근 완료/);
  assert.equal((md.match(/- \[x\]/g) ?? []).length, 10);
  assert.match(md, /- \[x\] 끝난 일 0/);
  assert.doesNotMatch(md, /끝난 일 10/);
  assert.ok(md.indexOf("## 메모\n오늘 할 일 3개") < md.indexOf("## 🔴"));
});

test("recentDoneTodos: 처음 완료로 본 순서(최신 먼저)", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "t1", title: "첫째", source: "mail", priority: 1 });
  s.upsertTodo({ id: "t2", title: "둘째", source: "mail", priority: 1 });
  s.upsertTodo({ id: "t3", title: "열림", source: "mail", priority: 1 });
  s.setTodoStatus("t1", "done");
  assert.deepEqual(recentDoneTodos(s, 10, new Date("2026-10-08T01:00:00Z")).map((t) => t.id), ["t1"]);
  s.setTodoStatus("t2", "done");
  assert.deepEqual(recentDoneTodos(s, 10, new Date("2026-10-08T02:00:00Z")).map((t) => t.id), ["t2", "t1"]);
  s.setTodoStatus("t1", "open"); // 다시 열린 건 빠진다
  assert.deepEqual(recentDoneTodos(s, 10, new Date("2026-10-08T03:00:00Z")).map((t) => t.id), ["t2"]);
});

test("openDm: conversations.open users=userId → channel.id", async () => {
  const f = fakeClient();
  assert.equal(await openDm(f.client, "U1"), "D123");
  assert.deepEqual(f.calls[0], { m: "conversations.open", a: { users: "U1" } });
});

test("TodoCanvas: 처음엔 DM 채널 캔버스 생성, 그다음엔 전체 replace", async () => {
  const s = new Store(":memory:");
  const f = fakeClient();
  const c = new TodoCanvas(s, { delayMs: 5, now: () => NOW, log: () => {} });
  s.upsertTodo({ id: "t1", title: "하나", source: "mail", priority: 1 });
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create"]);
  const a = f.calls[0].a;
  assert.equal(a.channel_id, "D123");
  assert.equal(a.document_content.type, "markdown");
  assert.match(a.document_content.markdown, /하나/);
  assert.equal(c.canvasId("D123"), "F1");

  s.upsertTodo({ id: "t2", title: "둘", source: "slack", priority: 2 });
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "canvases.edit"]);
  const e = f.calls[1].a;
  assert.equal(e.canvas_id, "F1");
  assert.equal(e.changes.length, 1);
  assert.equal(e.changes[0].operation, "replace");
  assert.equal(e.changes[0].section_id, undefined); // 캔버스 전체 교체
  assert.match(e.changes[0].document_content.markdown, /둘/);
});

test("TodoCanvas: 연속 호출은 한 번으로 묶고, 내용이 같으면(시각만 달라도) 건너뜀", async () => {
  const s = new Store(":memory:");
  const f = fakeClient();
  let t = NOW.getTime();
  const c = new TodoCanvas(s, { delayMs: 20, now: () => new Date((t += 60_000)), log: () => {} });
  s.upsertTodo({ id: "t1", title: "하나", source: "mail", priority: 1 });
  await Promise.all([c.sync(f.client, "D123"), c.sync(f.client, "D123"), c.sync(f.client, "D123")]);
  assert.deepEqual(f.methods(), ["conversations.canvases.create"]);
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create"]); // 해시 같음 → 호출 없음
  s.setTodoStatus("t1", "done");
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "canvases.edit"]);
  assert.match(f.calls[1].a.changes[0].document_content.markdown, /최근 완료[\s\S]*- \[x\] 하나/);
});

test("TodoCanvas: canvas_not_found면 다시 만든다", async () => {
  const s = new Store(":memory:");
  let gone = false;
  const f = fakeClient({ editErr: () => (gone ? "canvas_not_found" : undefined) });
  const c = new TodoCanvas(s, { delayMs: 1, now: () => NOW, log: () => {} });
  s.upsertTodo({ id: "t1", title: "하나", source: "mail", priority: 1 });
  await c.sync(f.client, "D123");
  gone = true;
  s.upsertTodo({ id: "t2", title: "둘", source: "mail", priority: 1 });
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "canvases.edit", "conversations.canvases.create"]);
  assert.equal(c.canvasId("D123"), "F2");
});

test("TodoCanvas: 이미 채널 캔버스가 있으면 찾아서 덮어씀", async () => {
  const s = new Store(":memory:");
  const f = fakeClient({ createErr: "channel_canvas_already_exists", existing: "FOLD" });
  const c = new TodoCanvas(s, { delayMs: 1, now: () => NOW, log: () => {} });
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "conversations.info", "canvases.edit"]);
  assert.equal(f.calls[2].a.canvas_id, "FOLD");
  assert.equal(c.canvasId("D123"), "FOLD");
});

test("TodoCanvas: DM 채널 캔버스가 막히면 독립 캔버스 + 사용자 공유", async () => {
  const s = new Store(":memory:");
  const f = fakeClient({ createErr: "invalid_channel_type" });
  const c = new TodoCanvas(s, { delayMs: 1, userId: "U1", now: () => NOW, log: () => {} });
  await c.sync(f.client, "D123");
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "canvases.create", "canvases.access.set"]);
  assert.deepEqual(f.calls[2].a, { canvas_id: "FS1", access_level: "write", user_ids: ["U1"] });
  assert.equal(c.canvasId("D123"), "FS1");
});

test("TodoCanvas: 오류는 던지지 않고 로그만, 다음 sync에 재시도", async () => {
  const s = new Store(":memory:");
  const logs: string[] = [];
  let fail = true;
  const f = fakeClient({ editErr: () => (fail ? "canvas_editing_failed" : undefined) });
  const c = new TodoCanvas(s, { delayMs: 1, now: () => NOW, log: (m) => logs.push(m) });
  await c.sync(f.client, "D123"); // 생성
  s.upsertTodo({ id: "t1", title: "하나", source: "mail", priority: 1 });
  await c.sync(f.client, "D123"); // 편집 실패 → 로그
  assert.match(logs.join("\n"), /canvas_editing_failed/);
  fail = false;
  await c.sync(f.client, "D123"); // 해시가 저장 안 됐으니 다시 시도
  assert.deepEqual(f.methods(), ["conversations.canvases.create", "canvases.edit", "canvases.edit"]);
  const rl = fakeClient({ createErr: "ratelimited" });
  await new TodoCanvas(new Store(":memory:"), { delayMs: 1, log: (m) => logs.push(m) }).sync(rl.client, "D9");
  assert.deepEqual(rl.methods(), ["conversations.canvases.create"]); // 레이트리밋은 대비책으로 넘어가지 않는다
});
