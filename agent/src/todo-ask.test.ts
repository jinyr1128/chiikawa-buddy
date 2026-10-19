import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { askPrompt, ASK_SCHEMA } from "./todo-ask.ts";

test("askPrompt: 집어 든 할 일·다른 열린 할 일·사용자 말, 대화 기록은 안 넣는다", () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  store.upsertTodo({ id: "mail:2", title: "보고서", source: "mail", priority: 1 });
  store.editTodo("mail:1", { note: "금요일까지" });
  store.addChat("user", "예전 대화 비밀");
  const p = askPrompt(store, store.getTodo("mail:1")!, "이거 내일로 미뤄", { now: new Date("2026-10-08T01:00:00Z") });
  assert.match(p, /id: mail:1/);
  assert.match(p, /메모: 금요일까지/);
  assert.match(p, /\[P1\] 보고서/);
  assert.match(p, /"""이거 내일로 미뤄"""/);
  assert.doesNotMatch(p, /예전 대화 비밀/);
  assert.deepEqual(ASK_SCHEMA.required, ["reply", "todo_ops", "rule"]); // 예전 actions(회의 응답 제안)는 빠짐 — 도구 승인 카드로
});
