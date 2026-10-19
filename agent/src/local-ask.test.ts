import { test } from "node:test";
import assert from "node:assert/strict";
import { QUICK_ASKS, QUICK_LINES, isQuickAsk, localAsk, quickAnswer, type QuickFacts } from "./local-mode.ts";
import { Bus } from "./bus.ts";

const now = new Date("2026-10-14T05:00:00Z"); // 14:00 KST
const SEED = "t";
// 말투 양념(~요·감정 표시)을 뺀 본문
const plain = (s: string) => s.replace(/\s*\([^)]*시사\)$|\s*\(스이시~사\)$/u, "").replace("~요", "요");

test("고르는 질문 id 목록·확인", () => {
  assert.deepEqual([...QUICK_ASKS], ["today", "next_todo", "next_event", "cheer", "dance"]);
  assert.ok(isQuickAsk("cheer"));
  assert.ok(!isQuickAsk("connect"));
  assert.ok(!isQuickAsk(3));
});

test("오늘 할 일: 일부 끝냄 → 개수와 남은 것", () => {
  const f: QuickFacts = { now, today: [
    { title: "보고서", done: true }, { title: "메일 답장", done: true }, { title: "회의 준비", done: true },
    { title: "코드 리뷰", done: false }, { title: "  장 보기 ", done: false },
  ] };
  const a = quickAnswer("today", f, SEED);
  assert.equal(a.kind, "info");
  assert.equal(plain(a.text), "오늘 할 일 5개 중 3개 끝냈어요. 남은 건 '코드 리뷰', '장 보기'예요.");
  assert.deepEqual(a.open, { section: "today" });
  const many = quickAnswer("today", { now, today: [{ title: "a", done: true }, ...["b", "c", "d"].map((t) => ({ title: t, done: false }))] }, SEED);
  assert.match(plain(many.text), /남은 건 'b', 'c' 외 1개예요/);
});

test("오늘 할 일: 다 끝내면 칭찬, 하나도 안 했으면 목록, 비었으면 안내", () => {
  const all = quickAnswer("today", { now, today: [{ title: "a", done: true }, { title: "b", done: true }] }, SEED);
  assert.equal(all.kind, "done");
  assert.match(plain(all.text), /오늘 할 일 2개 다 끝냈어요! 정말 잘하셨어/);
  const none = quickAnswer("today", { now, today: [{ title: "a", done: false }] }, SEED);
  assert.match(plain(none.text), /1개 중 아직 끝낸 건 없어요/);
  assert.equal(none.detail, "- a");
  assert.equal(plain(quickAnswer("today", { now, today: [], open: [] }, SEED).text), QUICK_LINES.todayEmpty);
  assert.match(plain(quickAnswer("today", { now, today: [], open: [{ title: "x" }, { title: "y" }] }, SEED).text), /할 일 2개가 기다리고/);
});

test("지금 할 일: 우선순위 순 위 세 개, 백로그는 빼고, 없으면 쉬어 가요", () => {
  const a = quickAnswer("next_todo", { now, open: [
    { title: "참고 문서", priority: 3 }, { title: "급한 버그", priority: 1 }, { title: "주간 정리", priority: 2 },
    { title: "언젠가", priority: 4 }, { title: "두 번째 급한 것", priority: 1 },
  ] }, SEED);
  assert.match(plain(a.text), /'급한 버그'부터 해 보면 좋겠/);
  assert.equal(a.detail, "- 오늘 꼭 급한 버그\n- 오늘 꼭 두 번째 급한 것\n- 이번 주 주간 정리\n- 그 밖에 1개");
  assert.deepEqual(a.open, { section: "todos" });
  const empty = quickAnswer("next_todo", { now, open: [{ title: "언젠가", priority: 4 }] }, SEED);
  assert.equal(plain(empty.text), "지금 보이는 할 일이 없어요. 쉬어 가는 날도 필요해요.");
});

test("다음 일정: 캘린더 없으면 안내, 있으면 다음 일정·진행 중·없음", () => {
  const off = quickAnswer("next_event", { now, calendar: { enabled: false, meetings: [] } }, SEED);
  assert.equal(plain(off.text), QUICK_LINES.calOff);
  assert.deepEqual(off.open, { section: "setup", id: "extras" });
  assert.equal(plain(quickAnswer("next_event", { now }, SEED).text), QUICK_LINES.calOff);

  const meetings = [
    { subject: "지난 회의", start: "2026-10-14T01:00:00Z", end: "2026-10-14T02:00:00Z" },
    { subject: "디자인 리뷰", start: "2026-10-14T06:30:00Z", end: "2026-10-14T07:00:00Z", location: "3층 회의실" },
    { subject: "주간 회의", start: "2026-10-15T00:00:00Z", end: "2026-10-15T01:00:00Z" },
  ];
  const next = quickAnswer("next_event", { now, calendar: { enabled: true, meetings } }, SEED);
  assert.equal(next.text, "다음 일정은 〈디자인 리뷰〉, 오늘 15:30이에요 · 📍 3층 회의실.");
  const soon = quickAnswer("next_event", { now: new Date("2026-10-14T06:20:00Z"), calendar: { enabled: true, meetings } }, SEED);
  assert.match(plain(soon.text), /10분 뒤\(15:30\)/);
  const tomorrow = quickAnswer("next_event", { now: new Date("2026-10-14T08:00:00Z"), calendar: { enabled: true, meetings } }, SEED);
  assert.match(plain(tomorrow.text), /〈주간 회의〉, 내일 09:00이에요\./);
  const during = quickAnswer("next_event", { now: new Date("2026-10-14T06:40:00Z"), calendar: { enabled: true, meetings } }, SEED);
  assert.equal(during.text, "지금 〈디자인 리뷰〉 일정 중이에요. 16:00에 끝나요 · 📍 3층 회의실.");
  assert.match(during.detail ?? "", /그다음은 〈주간 회의〉, 내일 09:00이에요/);
  const none = quickAnswer("next_event", { now: new Date("2026-10-15T02:00:00Z"), calendar: { enabled: true, meetings } }, SEED);
  assert.equal(plain(none.text), QUICK_LINES.calNone);
});

test("응원: 정해진 문구 중 하나, 같은 seed 면 같은 말", () => {
  const a = quickAnswer("cheer", { now }, "s1");
  assert.equal(a.kind, "done");
  assert.ok(QUICK_LINES.cheer.some((l) => a.text.startsWith(l) || plain(a.text) === l || a.text.startsWith(l.replace(/요([.!])$/, "~요$1"))));
  assert.equal(quickAnswer("cheer", { now }, "s1").text, a.text);
});

test("문구에 em dash 없음", () => {
  const all = [...Object.values(QUICK_LINES).flat()];
  for (const l of all) assert.ok(!l.includes("\u2014"), l);
});

test("localAsk: 모르는 id 면 undefined, 필요한 것만 읽는다", () => {
  const read: string[] = [];
  const src = {
    now: () => now,
    today: () => { read.push("today"); return [{ title: "a", done: true, priority: 2 }]; },
    open: () => { read.push("open"); return [{ title: "b", priority: 1 }]; },
    calendar: () => { read.push("calendar"); return { enabled: false, meetings: [] }; },
  };
  assert.equal(localAsk("connect", src), undefined);
  assert.equal(localAsk(undefined, src), undefined);
  assert.deepEqual(read, []);
  assert.equal(localAsk("today", src)?.kind, "done");
  assert.equal(localAsk("next_todo", src)?.id, "next_todo");
  assert.equal(localAsk("next_event", src)?.id, "next_event");
  assert.equal(localAsk("cheer", src)?.id, "cheer");
  assert.deepEqual(read, ["today", "open", "open", "calendar"]);
});

test("bus: POST /local/ask", async () => {
  const bus = new Bus();
  const asked: string[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    localAsk: (id) => { asked.push(id); return id === "cheer" ? { id, text: "힘내요", kind: "done" } : undefined; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (body: string, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(`${base}/local/ask`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  try {
    assert.equal((await post(JSON.stringify({ id: "cheer" }), {})).status, 403);
    const r = await post(JSON.stringify({ id: "cheer" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, answer: { id: "cheer", text: "힘내요", kind: "done" } });
    assert.equal((await post(JSON.stringify({ id: "nope" }))).status, 400);
    assert.equal((await post(JSON.stringify({ id: 3 }))).status, 400);
    assert.equal((await post(JSON.stringify({ id: "cheer", x: 1 }))).status, 400);
    assert.deepEqual(asked, ["cheer", "nope"]);
  } finally {
    bus.close();
  }
  const bare = new Bus();
  await bare.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  try {
    const r = await fetch(`http://127.0.0.1:${(bare.server!.address() as any).port}/local/ask`, { method: "POST", headers: { "x-cy-agent": "1" }, body: JSON.stringify({ id: "cheer" }) });
    assert.equal(r.status, 503);
  } finally {
    bare.close();
  }
});
