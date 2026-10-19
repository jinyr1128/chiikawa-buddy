import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

test("제안 상태 전이는 기대 상태일 때만 일어난다(중복 승인 방지)", () => {
  const s = new Store(":memory:");
  s.addProposal({ id: "p1", repo: "/r/app", title: "버튼", plan: "색 변경" });
  assert.equal(s.transition("p1", ["pending"], "approved"), true);
  assert.equal(s.transition("p1", ["pending"], "approved"), false);
  assert.equal(s.proposal("p1")?.status, "approved");
});

test("할 일은 id 기준으로 중복 없이 쌓인다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "t1", title: "메일 답장", source: "mail", priority: 2 });
  s.upsertTodo({ id: "t1", title: "메일 답장", source: "mail", priority: 1 });
  assert.equal(s.openTodos().length, 1);
  assert.equal(s.openTodos()[0].priority, 1);
  s.setTodoStatus("t1", "done");
  assert.equal(s.openTodos().length, 0);
});

test("할 일 편집: 사용자가 고친 필드는 브리핑이 덮어쓰지 않는다", () => {
  const s = new Store(":memory:");
  assert.equal(s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2, link: "https://a" }), "added");
  const t = s.editTodo("mail:1", { priority: 1, note: "금요일까지", title: "견적 회신(급함)" })!;
  assert.deepEqual([t.priority, t.note, t.title], [1, "금요일까지", "견적 회신(급함)"]);
  assert.deepEqual(new Set(t.userEdited), new Set(["priority", "note", "title"]));
  assert.ok(t.updated);
  s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 3, link: "https://b" });
  const after = s.getTodo("mail:1")!;
  assert.equal(after.priority, 1); // 사용자 값 유지
  assert.equal(after.title, "견적 회신(급함)");
  assert.equal(after.link, "https://b"); // 안 고친 필드는 브리핑이 갱신
  s.editTodo("mail:1", { link: null });
  s.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 3, link: "https://c" });
  assert.equal(s.getTodo("mail:1")!.link, undefined); // 지운 링크도 사용자 결정
  assert.equal(s.editTodo("nope", { title: "x" }), undefined);
});

test("할 일 삭제는 묘비를 남겨 다시 생기지 않고, 끝난 일은 브리핑이 다시 열지 않는다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "slack:1", title: "답장", source: "slack", priority: 2 });
  assert.equal(s.deleteTodo("slack:1")?.title, "답장");
  assert.equal(s.deleteTodo("slack:1"), undefined);
  assert.equal(s.upsertTodo({ id: "slack:1", title: "답장", source: "slack", priority: 1 }), "skipped");
  assert.equal(s.getTodo("slack:1"), undefined);
  assert.equal(s.isTombstoned("slack:1"), true);

  s.upsertTodo({ id: "jira:2", title: "이슈", source: "jira", priority: 2 });
  s.editTodo("jira:2", { status: "done" });
  assert.equal(s.upsertTodo({ id: "jira:2", title: "이슈", source: "jira", priority: 1, status: "open" }), "skipped");
  assert.equal(s.getTodo("jira:2")!.status, "done");
  assert.deepEqual(s.doneTodos().map((t) => t.id), ["jira:2"]);

  // 브리핑이 끝냈다고 본 것도 다시 열지 않는다
  s.upsertTodo({ id: "cal:3", title: "회의", source: "calendar", priority: 2 });
  s.setTodoStatus("cal:3", "done");
  s.upsertTodo({ id: "cal:3", title: "회의", source: "calendar", priority: 2 });
  assert.equal(s.getTodo("cal:3")!.status, "done");

  // 사용자가 되살린 건 브리핑의 done 판정이 다시 닫지 않는다
  s.editTodo("jira:2", { status: "open" });
  assert.equal(s.setTodoStatus("jira:2", "done"), false);
  assert.equal(s.getTodo("jira:2")!.status, "open");
  assert.equal(s.setTodoStatus("jira:2", "done", { force: true }), true);
});

test("addTodo: user: id, 기본 P2, 열린 목록에 나온다", () => {
  const s = new Store(":memory:");
  const t = s.addTodo({ title: "테스트 항목", note: "메모" });
  assert.match(t.id, /^user:[0-9a-f-]{36}$/);
  assert.deepEqual([t.priority, t.source, t.status, t.note], [2, "user", "open", "메모"]);
  assert.deepEqual(s.openTodos().map((x) => x.id), [t.id]);
});

test("예전 DB에 열을 덧붙이는 마이그레이션은 여러 번 돌아도 안전", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cy-store-")), "cy.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, link TEXT, priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL)");
  old.prepare("INSERT INTO todos (id, title, source, priority, status, created) VALUES ('a', '옛 할 일', 'mail', 1, 'open', 't')").run();
  old.close();
  const s1 = new Store(path);
  assert.deepEqual(s1.getTodo("a")!.userEdited, []);
  s1.editTodo("a", { note: "n" });
  s1.db.close();
  const s2 = new Store(path);
  assert.equal(s2.getTodo("a")!.note, "n");
  s2.db.close();
});

test("채팅 기록: 예전 DB에 todo_id·todo_title 열을 덧붙이고, 할 일 집어 든 말은 todoId·todoTitle로 돌려준다", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cy-chat-")), "cy.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
  old.prepare("INSERT INTO chat (role, text, at) VALUES (?, ?, ?)").run("user", "예전 말", "t0");
  old.close();
  const s = new Store(path);
  s.addChat("user", "이거 없애", "t1", { id: "mail:1", title: "견적 회신" });
  s.addChat("assistant", "지웠어", "t2");
  assert.deepEqual(s.chatHistory(), [
    { role: "user", text: "예전 말", at: "t0" },
    { role: "user", text: "이거 없애", at: "t1", todoId: "mail:1", todoTitle: "견적 회신" },
    { role: "assistant", text: "지웠어", at: "t2" },
  ]);
  new Store(path); // 두 번 열어도 안전
});
