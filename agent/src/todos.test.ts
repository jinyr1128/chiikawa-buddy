import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreview, focusOps, opsSummary, parseOps, parsePatch, todoRev, todoSnap } from "./todos.ts";
import { Store } from "./store.ts";

const focus = { id: "mail:1", title: "견적 회신", priority: 2, note: "금요일", status: "open" };

test("focusOps: id 없는 건 그 할 일로, 다른 할 일 id·잘못된 값·안 바뀌는 수정은 버리고 수정은 하나로 합친다", () => {
  const ops = focusOps(focus, [
    { op: "edit", note: "내일까지" },
    { op: "edit", id: "mail:1", priority: 3 },
    { op: "edit", id: "mail:2", priority: 1 }, // 다른 할 일
    { op: "delete", id: "slack:9" }, // 다른 할 일
    { op: "edit", priority: 9 }, // 잘못된 값
    { op: "edit", title: "견적 회신" }, // 그대로
    { op: "add", title: "" }, // 제목 없음
    { op: "add", title: "  견적서  보내기 ", priority: 1 },
    { op: "reopen" }, // 이미 열림
  ]);
  assert.deepEqual(ops, [
    { op: "edit", id: "mail:1", note: "내일까지", priority: 3 },
    { op: "add", title: "견적서 보내기", priority: 1 },
  ]);
});

test("focusOps: 지우기가 있으면 그 할 일의 다른 변경은 빼고 추가는 남긴다, 추가는 5개까지", () => {
  const adds = Array.from({ length: 7 }, (_, i) => ({ op: "add" as const, title: `조각 ${i}` }));
  const ops = focusOps(focus, [{ op: "edit", priority: 1 }, { op: "done" }, { op: "delete", note: "안 함" }, ...adds]);
  assert.deepEqual(ops[0], { op: "delete", id: "mail:1", note: "안 함" });
  assert.equal(ops.length, 6);
  assert.ok(ops.slice(1).every((o) => o.op === "add" && o.priority === 2));
  assert.deepEqual(focusOps(focus, "nope" as any), []);
});

test("buildPreview: 수정·완료는 한 항목(전/후), 삭제는 전만, 추가는 후만", () => {
  const p = buildPreview(focus, focusOps(focus, [{ op: "edit", note: null, priority: 1 }, { op: "done" }, { op: "add", title: "새 일", note: "메모" }]));
  assert.deepEqual(p, [
    { id: "mail:1", kind: "done", before: todoSnap(focus), after: { title: "견적 회신", priority: 1, note: null, link: null, status: "done" } },
    { kind: "add", after: { title: "새 일", priority: 2, note: "메모", link: null, status: "open" } },
  ]);
  const d = buildPreview(focus, focusOps(focus, [{ op: "delete" }]));
  assert.deepEqual(d, [{ id: "mail:1", kind: "delete", before: todoSnap(focus) }]);
  assert.deepEqual(buildPreview(focus, []), []);
});

test("todoRev: 보이는 필드가 바뀌면 달라진다", () => {
  assert.equal(todoRev(focus), todoRev({ ...focus }));
  assert.notEqual(todoRev(focus), todoRev({ ...focus, priority: 1 }));
  assert.notEqual(todoRev(focus), todoRev({ ...focus, note: undefined }));
  assert.match(todoRev(focus), /^[0-9a-f]{8}$/);
});

test("parseOps: 모양 검사 — 배열·아는 키·op 종류, 빈 배열은 allowEmpty일 때만", () => {
  assert.equal(parseOps([{ op: "edit", priority: 1, note: null }]).ok, true);
  for (const bad of [null, {}, "x", [], [1], [{ op: "nuke" }], [{ op: "edit", evil: 1 }], [{ op: "edit", priority: "1" }], [{ op: "edit", note: 3 }], [{ op: "edit", id: 3 }], Array(21).fill({ op: "done" })]) {
    assert.equal(parseOps(bad).ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(parseOps([], { allowEmpty: true }).ok, true);
});

test("opsSummary: 학습 신호용 한 줄", () => {
  assert.equal(opsSummary([{ op: "edit", priority: 3, note: "내일" }, { op: "add", title: "X" }]), '수정(P3, 메모 "내일"), 추가 "X"');
  assert.equal(opsSummary([{ op: "delete" }]), "삭제");
  assert.equal(opsSummary([]), "(변경 없음)");
});

test("parsePatch description: 문자열·null, 다듬고 빈 값은 지우기, 4000자 초과·다른 타입은 오류", async () => {
  const { parsePatch } = await import("./todos.ts");
  assert.deepEqual(parsePatch({ description: "  줄1\r\n줄2  " }), { ok: true, value: { description: "줄1\n줄2" } });
  assert.deepEqual(parsePatch({ description: "   " }), { ok: true, value: { description: null } });
  assert.deepEqual(parsePatch({ description: null }), { ok: true, value: { description: null } });
  assert.equal(parsePatch({ description: "x".repeat(50000) }).ok, true);
  assert.equal(parsePatch({ description: 3 }).ok, false);
});

test("(진행중) 토글: doing 은 boolean|null, 저장·지우기, 사용자 수정 표시 안 함", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "t1", title: "일", source: "user", priority: 2 });
  assert.deepEqual(parsePatch({ doing: true }), { ok: true, value: { doing: true } });
  assert.equal(parsePatch({ doing: "y" }).ok, false);
  assert.equal(s.editTodo("t1", { doing: true })!.doing, true);
  assert.deepEqual(s.getTodo("t1")!.userEdited, []);
  assert.equal(s.editTodo("t1", { doing: false })!.doing, false);
  assert.equal(s.editTodo("t1", { doing: null })!.doing, undefined);
});
