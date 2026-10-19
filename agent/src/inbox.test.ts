import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, MAX_ITEMS, notify, setInbox } from "./inbox.ts";

test("알림함: 출처·계정과 함께 쌓고, 같은 key 는 한 번, 최신 순", () => {
  const box = new Inbox();
  let last = -1;
  box.onChange = (n) => { last = n; };
  assert.ok(box.add({ source: "mail", key: "m1", account: "a@gmail.com", title: "철수 · 회의 자료", at: "2026-10-19T01:00:00Z" }));
  assert.ok(box.add({ source: "slack", key: "s1", account: "#general", title: "영희 · 나를 불렀어요", at: "2026-10-19T02:00:00Z" }));
  assert.equal(box.add({ source: "mail", key: "m1", title: "다시" }), false);
  assert.equal(box.add({ source: "nope" as any, key: "x", title: "x" }), false);
  assert.deepEqual(box.list().map((x) => x.key), ["s1", "m1"]);
  assert.equal(last, 2);
  assert.deepEqual(box.unreadBySource(), { mail: 1, slack: 1 });
  assert.equal(box.list({ source: "mail" })[0].account, "a@gmail.com");
});

test("읽음 표시: 하나·출처별·전부, 읽은 것 지우기", () => {
  const box = new Inbox();
  box.add({ source: "mail", key: "m1", title: "a" });
  box.add({ source: "mail", key: "m2", title: "b" });
  box.add({ source: "claude", key: "c1", title: "c" });
  const id = box.list({ source: "claude" })[0].id;
  assert.equal(box.mark([id]), 1);
  assert.equal(box.unread(), 2);
  assert.equal(box.mark("all", true, "mail"), 2);
  assert.equal(box.unread(), 0);
  assert.equal(box.mark("all", false), 3);
  box.mark("all");
  assert.equal(box.clearRead(), 3);
  assert.equal(box.list().length, 0);
});

test("파일에 남고 다시 읽는다, 개수 상한, 링크는 http(s)만", () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-")), "inbox.json");
  const a = new Inbox(path);
  a.add({ source: "calendar", key: "k", title: "회의 30분 전", link: "javascript:alert(1)" });
  const b = new Inbox(path);
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].link, undefined);
  assert.equal(b.add({ source: "calendar", key: "k", title: "또" }), false);
  for (let i = 0; i < MAX_ITEMS + 5; i++) b.add({ source: "system", key: `x${i}`, title: "t" });
  assert.equal(b.list().length, MAX_ITEMS);
});

test("notify: 꽂힌 알림함이 없으면 조용히 false", () => {
  setInbox(null);
  assert.equal(notify({ source: "mail", key: "z", title: "z" }), false);
  const box = new Inbox();
  setInbox(box);
  assert.equal(notify({ source: "mail", key: "z", title: "z" }), true);
  setInbox(null);
});
