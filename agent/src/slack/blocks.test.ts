import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefingBlocks, compactResolvedBlocks, parseTodoEditView, proposalBlocks, replaceTodoLine, resolvedBlocks, splitText, todoEditModal,
  todoLine, todoRef, todoRefFromBlock, traceBlocks,
} from "./blocks.ts";
import type { Todo } from "../store.ts";

test("splitText: 문단 경계 우선, 한도 이하 조각", () => {
  const para = "a".repeat(60);
  const text = Array.from({ length: 10 }, () => para).join("\n\n");
  const chunks = splitText(text, 200);
  assert.ok(chunks.every((c) => c.length <= 200));
  assert.equal(chunks.join("").replace(/\n/g, ""), text.replace(/\n/g, ""));
  assert.ok(chunks.every((c) => !c.startsWith("\n")));
});

test("resolvedBlocks: 버튼만 걷고 원문·결과 유지, block_id 제거", () => {
  const p = { id: "p1", repo: "/r/a", title: "버튼", plan: "색 변경", status: "pending" as const, created: "" };
  const out = resolvedBlocks({ blocks: proposalBlocks(p) }, "▶️ 승인 — 실행 중");
  assert.equal(out.some((b) => b.type === "actions"), false);
  assert.match(JSON.stringify(out), /색 변경/);
  assert.match(out.at(-1)!.text.text, /승인/);
  assert.equal(out.some((b) => "block_id" in b), false);
});

test("compactResolvedBlocks: 긴 원문 자르고 코드펜스 닫기", () => {
  const out = compactResolvedBlocks({ blocks: [{ type: "section", text: { type: "mrkdwn", text: "```\n" + "x".repeat(3000) } }] }, "done");
  const head = out[0].text.text as string;
  assert.ok(head.length < 1400);
  assert.equal((head.match(/```/g) ?? []).length % 2, 0);
});

test("briefingBlocks: 할 일마다 메뉴, 링크·이스케이프", () => {
  const out = briefingBlocks("# 오늘", [{ id: "mail:1", title: "A <b>", source: "mail", link: "https://x", priority: 1, status: "open", created: "" }]);
  assert.equal(out[0].type, "markdown");
  const sec = out.find((b) => b.type === "section")!;
  assert.match(sec.text.text, /<https:\/\/x\|A &lt;b&gt;>/);
  assert.equal(sec.block_id, "cy_todo:mail:1");
  assert.equal(sec.accessory.type, "overflow");
  assert.equal(sec.accessory.action_id, "cy_todo:menu");
  // P1이면 '올리기'가 없다. 값은 동작만(대상은 block_id)
  assert.deepEqual(sec.accessory.options.map((o: any) => o.value), ["done", "edit", "down", "backlog", "delete"]);
  assert.equal(sec.accessory.options[0].text.text, "완료");
});

const todo = (o: Partial<Todo> = {}): Todo => ({ id: "jira:1", title: "견적 회신", source: "jira", priority: 2, status: "open", created: "", ...o });

test("todoLine: 우선순위별 메뉴, 직접 수정 표시·메모, 긴 id는 해시 참조", () => {
  assert.deepEqual(todoLine(todo({ priority: 3 })).accessory.options.map((o: any) => o.value), ["done", "edit", "up", "backlog", "delete"]);
  assert.deepEqual(todoLine(todo()).accessory.options.map((o: any) => o.value), ["done", "edit", "up", "down", "backlog", "delete"]);
  // 백로그(P4): 올리기만, '백로그로'는 없다. 모달은 P4까지 고를 수 있다
  const p4 = todoLine(todo({ priority: 4 }));
  assert.deepEqual(p4.accessory.options.map((o: any) => o.value), ["done", "edit", "up", "delete"]);
  assert.match(p4.text.text, /^🗂/);
  const edited = todoLine(todo({ userEdited: ["title"], note: "금요일\n까지 <꼭>" }));
  assert.match(edited.text.text, /✏️/);
  assert.match(edited.text.text, /> 금요일 까지 &lt;꼭&gt;/);
  assert.doesNotMatch(todoLine(todo({ userEdited: ["status"] })).text.text, /✏️/);
  const long = "mail:" + "A".repeat(400);
  const ref = todoRefFromBlock(todoLine(todo({ id: long })).block_id)!;
  assert.match(ref, /^h:[0-9a-f]{32}$/);
  assert.equal(ref, todoRef(long));
  assert.ok(todoLine(todo({ id: long })).block_id.length <= 255);
  assert.equal(todoRefFromBlock("cy_proposal_actions:x"), undefined);
});

test("replaceTodoLine: 그 줄만 바꾸고 나머지는 그대로", () => {
  const blocks = briefingBlocks("본문", [todo({ id: "a", title: "A" }), todo({ id: "b", title: "B" })]);
  const done = replaceTodoLine(blocks, "cy_todo:a", { done: "A" });
  assert.equal(done[0].text, "본문");
  assert.equal(done.find((b) => b.block_id === "cy_todo:a").text.text, "~A~ ✅");
  assert.equal(done.find((b) => b.block_id === "cy_todo:a").accessory, undefined);
  assert.deepEqual(done.find((b) => b.block_id === "cy_todo:b"), blocks.find((b) => b.block_id === "cy_todo:b"));
  const del = replaceTodoLine(blocks, "cy_todo:b", { deleted: "B" });
  assert.match(del.find((b) => b.block_id === "cy_todo:b").text.text, /~B~ 🗑️/);
  const up = replaceTodoLine(blocks, "cy_todo:a", { todo: todo({ id: "a", title: "A2", priority: 1, userEdited: ["priority"] }) });
  assert.match(up.find((b) => b.block_id === "cy_todo:a").text.text, /^🔴 A2/);
  assert.equal(replaceTodoLine(blocks, "nope", { done: "x" }).length, blocks.length);
});

// Slack view_submission 의 view.state.values 모양
function submitted(meta: object, v: { title?: string; priority?: string; link?: string | null; note?: string | null }) {
  return {
    private_metadata: JSON.stringify(meta),
    state: { values: {
      title: { v: { type: "plain_text_input", value: v.title ?? null } },
      priority: { v: { type: "static_select", selected_option: v.priority ? { value: v.priority } : null } },
      link: { v: { type: "plain_text_input", value: v.link ?? null } },
      note: { v: { type: "plain_text_input", value: v.note ?? null } },
    } },
  };
}

test("todoEditModal / parseTodoEditView: 초기값, 바뀐 필드만 패치, 오류는 필드별", () => {
  const t = todo({ link: "https://x", note: "메모" });
  const m = todoEditModal(t, { channel: "D1", ts: "1.2", blockId: "cy_todo:jira:1" });
  assert.equal(m.callback_id, "cy_todo_edit");
  assert.deepEqual(JSON.parse(m.private_metadata), { id: "jira:1", channel: "D1", ts: "1.2", blockId: "cy_todo:jira:1" });
  assert.equal(m.blocks[0].element.initial_value, "견적 회신");
  assert.equal(m.blocks[1].element.initial_option.value, "2");
  assert.equal(m.blocks[2].element.initial_value, "https://x");

  const lookup = (id: string) => (id === "jira:1" ? t : undefined);
  const meta = JSON.parse(m.private_metadata);
  const r = parseTodoEditView(submitted(meta, { title: " 견적  회신 ", priority: "1", link: "https://x", note: null }), lookup);
  assert.deepEqual(r, { ok: true, id: "jira:1", channel: "D1", ts: "1.2", blockId: "cy_todo:jira:1", patch: { priority: 1, note: null } });

  assert.deepEqual(parseTodoEditView(submitted(meta, { title: "  ", priority: "2" }), lookup), { ok: false, errors: { title: "제목을 입력해 주세요(300자 이내)" } });
  assert.deepEqual(parseTodoEditView(submitted(meta, { title: "x", priority: "2", link: "javascript:alert(1)" }), lookup), { ok: false, errors: { link: "http(s) 또는 slack 링크만 돼요" } });
  assert.deepEqual(parseTodoEditView(submitted({ id: "gone" }, { title: "x", priority: "2" }), lookup), { ok: false, errors: { title: "이미 지워진 할 일이에요" } });
  assert.equal(parseTodoEditView({ private_metadata: "{bad" }).ok, false);
});

test("traceBlocks: 길면 오래된 줄 생략", () => {
  const out = traceBlocks(Array.from({ length: 400 }, (_, i) => `step ${i}`), false);
  const t = out[0].text.text as string;
  assert.ok(t.length <= 2900);
  assert.match(t, /^🧰 \*작업 내역\*\n…/);
  assert.match(t, /진행 중/);
});

test("toSlackMarkdown: 색·형광펜은 굵게, 콜아웃은 이모지 제목", async () => {
  const { toSlackMarkdown } = await import("./blocks.ts");
  assert.equal(toSlackMarkdown("상태 :green[완료], :red[**지연**], ==중요=="), "상태 **완료**, **지연**, **중요**");
  assert.equal(toSlackMarkdown("> [!WARNING]\n> 마감 오늘"), "> **⚠️ 주의** \n> 마감 오늘");
  assert.equal(toSlackMarkdown("> [!tip] 한 줄"), "> **💡 팁** 한 줄");
  assert.equal(toSlackMarkdown("2 == 3 비교"), "2 == 3 비교");
});
