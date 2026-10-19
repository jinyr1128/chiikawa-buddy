import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { ask, REQUEST_SCHEMA, SCHEMA, TEXT_SCHEMA } from "./brain.ts";
import { CHAT_SCHEMA, TITLE_SCHEMA } from "./chat.ts";
import { ASK_SCHEMA } from "./todo-ask.ts";
import { MERGE_ASK_SCHEMA } from "./reactions.ts";
import { DESC_SCHEMA } from "./todo-source.ts";
import { opPatch, TODO_OPS_SCHEMA, type TodoOp } from "./todos.ts";
import { OPENAI_URL, openaiStrict, openaiUnstrict, type FetchLike } from "./providers.ts";

// 뇌 ask 로 OpenAI 에 실제 넘어가는 스키마 전부(정기 브리핑·DM·채팅·제목·팝오버·머지 질문·할 일 설명·슬래시 명령 글).
// kg·profile·todo-auto·todo-progress·fixer 의 스키마는 Codex·Claude 경로만 탄다
const BRAIN_SCHEMAS: Record<string, unknown> = { SCHEMA, REQUEST_SCHEMA, TEXT_SCHEMA, CHAT_SCHEMA, TITLE_SCHEMA, ASK_SCHEMA, MERGE_ASK_SCHEMA, DESC_SCHEMA };

// strict 에서 쓸 수 있는 키워드(https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas, 2026-10 확인).
// 구조 키워드 + 지원 제약(string: pattern·format, number: multipleOf·minimum·maximum·exclusive*, array: minItems·maxItems).
// minLength·maxLength·allOf·not·if/then/else·dependent*·patternProperties·oneOf 등은 여기 없으니 걸린다
const STRICT_KEYWORDS = new Set([
  "type", "description", "title", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$defs", "$ref",
  "pattern", "format", "multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems",
]);

// strict 규칙 위반을 경로와 함께 모은다
function strictErrors(s: unknown, path = "$", out: string[] = []): string[] {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return out;
  const o = s as Record<string, any>;
  for (const k of Object.keys(o)) if (!STRICT_KEYWORDS.has(k)) out.push(`${path}: 지원 안 하는 키워드 ${k}`);
  const isObject = o.type === "object" || (Array.isArray(o.type) && o.type.includes("object")) || o.properties;
  if (isObject) {
    if (o.additionalProperties !== false) out.push(`${path}: additionalProperties 가 false 가 아님`);
    const keys = Object.keys(o.properties ?? {}).sort();
    const req = [...(o.required ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(req)) out.push(`${path}: required ${req} ≠ properties ${keys}`);
  }
  for (const [k, v] of Object.entries(o.properties ?? {})) strictErrors(v, `${path}.${k}`, out);
  if (o.items) strictErrors(o.items, `${path}[]`, out);
  for (const k of ["anyOf", "oneOf", "allOf"]) for (const [i, v] of (o[k] ?? []).entries()) strictErrors(v, `${path}|${k}${i}`, out);
  for (const [k, v] of Object.entries(o.$defs ?? {})) strictErrors(v, `${path}$${k}`, out);
  return out;
}

const OMIT = { _omit: true };

test("openaiStrict: 뇌에 넘어가는 스키마 전부 strict 규칙에 맞는다(원본은 그대로)", () => {
  for (const [name, s] of Object.entries(BRAIN_SCHEMAS)) {
    const before = JSON.stringify(s);
    const conv = openaiStrict(s) as any;
    assert.equal(conv.type, "object", name);
    assert.deepEqual(strictErrors(conv), [], name);
    assert.equal(JSON.stringify(s), before, `${name} 원본이 바뀌면 안 된다`);
  }
  // 원본은 strict 규칙에 안 맞았다(400 원인) — 회귀 확인
  assert.ok(strictErrors(REQUEST_SCHEMA).length > 0);
  assert.ok(strictErrors(CHAT_SCHEMA).length > 0);
  assert.ok(strictErrors(ASK_SCHEMA).length > 0);
});

test("openaiStrict: 선택 속성엔 없음 자리, 원래 null(지우기)인 link·note 엔 {_omit}, 지원 제약은 남긴다", () => {
  const todo = (openaiStrict(SCHEMA) as any).properties.todos.items;
  assert.deepEqual(todo.properties.link.anyOf.at(-1), { type: "null" });
  assert.equal(todo.properties.key.type, "string", "원래 required 는 그대로");
  assert.equal(todo.properties.priority.minimum, 1, "minimum·maximum 은 strict 에서 지원 — 빼지 않는다");
  assert.equal(todo.properties.priority.maximum, 4);
  const ops = (openaiStrict(TODO_OPS_SCHEMA) as any).items.properties;
  assert.deepEqual(ops.link.anyOf[0], TODO_OPS_SCHEMA.items.properties.link, "원래 string|null 은 그대로 한 갈래");
  assert.equal(ops.link.anyOf[1].properties._omit.enum[0], true);
  assert.match(ops.link.description, /_omit/);
  assert.equal(TODO_OPS_SCHEMA.items.properties.link.anyOf.length, 2, "원본(Gemini·Claude)은 그대로");
  // 규칙 effect 는 원래 required 가 없다 → 키 전부 required
  const rule = (openaiStrict(CHAT_SCHEMA) as any).properties.rule.anyOf[1];
  assert.deepEqual([...rule.required].sort(), ["effect", "match", "text"]);
  assert.deepEqual([...rule.properties.effect.required].sort(), ["backlog", "note", "priority", "skip"]);
});

test("openaiUnstrict: 덧붙인 없음 자리만 빼고, 원래 null 을 받는 값은 남긴다", () => {
  const out = openaiUnstrict({
    reply_md: "r", bubble: "b", show: null, rule: null, guideline: null,
    todo_ops: [{ op: "edit", id: "t1", title: null, priority: null, link: null, note: OMIT, description: null, source_ref: null }],
    memory_ops: [{ op: "remember", text: "x", category: null, id: null }],
    proposals: [{ repo: "/r", title: "t", plan: "p", base: null }],
  }, CHAT_SCHEMA);
  assert.deepEqual(out, {
    reply_md: "r", bubble: "b", show: null, rule: null, guideline: null,
    todo_ops: [{ op: "edit", id: "t1", link: null }],
    memory_ops: [{ op: "remember", text: "x" }],
    proposals: [{ repo: "/r", title: "t", plan: "p" }],
  });
  const rule = openaiUnstrict({ rule: { text: "t", match: { description: "d", keywords: ["a"], sources: null, titleRegex: null }, effect: { priority: 4, backlog: null, skip: null, note: null } } }, ASK_SCHEMA);
  assert.deepEqual(rule, { rule: { text: "t", match: { description: "d", keywords: ["a"] }, effect: { priority: 4 } } });
  // 원래 required 인 키는 null 이어도 건드리지 않는다(검증은 받는 쪽에서)
  assert.deepEqual(openaiUnstrict({ bubble: null }, SCHEMA), { bubble: null });
});

test("openai todo_ops: {_omit} 는 링크·메모를 안 바꾸고, null 만 지운다", () => {
  const patch = (o: Record<string, unknown>) => {
    const [op] = openaiUnstrict([{ op: "edit", id: "t1", title: null, priority: null, link: OMIT, note: OMIT, description: null, source_ref: null, ...o }], TODO_OPS_SCHEMA) as TodoOp[];
    const p = opPatch(op);
    assert.ok(p.ok);
    return p.value;
  };
  assert.deepEqual(patch({}), {}, "{_omit} 는 그대로 두기");
  assert.deepEqual(patch({ link: "", note: "" }), {}, "빈 문자열도 그대로 두기");
  assert.deepEqual(patch({ link: null }), { link: null });
  assert.deepEqual(patch({ note: null, link: "https://x.test/a" }), { note: null, link: "https://x.test/a" });
  assert.deepEqual(patch({ note: "새 메모" }), { note: "새 메모" });
  // Gemini·Claude 경로(openaiUnstrict 안 거침)도 null = 지우기로 같다
  const g = opPatch({ op: "edit", id: "t1", link: null, note: "" } as TodoOp);
  assert.ok(g.ok);
  assert.deepEqual(g.value, { link: null });
});

test("openaiUnstrict: __proto__·constructor·prototype 키는 버린다(프로토타입 오염 없음)", () => {
  const raw = JSON.parse('{"reply_md":"r","__proto__":{"polluted":1},"constructor":{"x":1},"prototype":2,"todo_ops":[{"op":"done","id":"t","__proto__":{"polluted":1}}]}');
  const out = openaiUnstrict(raw, CHAT_SCHEMA) as any;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.hasOwn(out, "constructor"), false);
  assert.equal(Object.hasOwn(out, "prototype"), false);
  assert.equal(Object.getPrototypeOf(out.todo_ops[0]), Object.prototype);
  assert.equal(out.todo_ops[0].polluted, undefined);
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(out, { reply_md: "r", todo_ops: [{ op: "done", id: "t" }] });
});

const OAI = "unit-test-openai-key";
const GKEY = "unit-test-gemini-key";
function cfgOf(provider: "gemini" | "openai") {
  const base = loadConfig({});
  return { ...base, brain: { provider }, models: { ...base.models, general: "claude-sonnet-5-5" } };
}

test("openai: 보내는 스키마가 strict 에 맞고, 없음 자리를 채운 답이 Gemini 와 같은 모양으로 돌아온다", async () => {
  const shape = {
    bubble: "안녕", reply_md: "본문", done_todo_ids: [], proposals: [],
    todos: [{ key: "slack:C1:1", title: "답장", source: "slack", priority: 2 }],
    todo_ops: [{ op: "edit", id: "t1", link: null }], plan_ops: [], memory_ops: [], rule: null,
  };
  const filled = {
    ...shape,
    todos: [{ ...shape.todos[0], link: null, description: null, source_ref: null }],
    todo_ops: [{ op: "edit", id: "t1", title: null, priority: null, link: null, note: OMIT, description: null, source_ref: null }],
  };
  let sent: any;
  const oai: FetchLike = async (url, init) => {
    assert.equal(url, OPENAI_URL);
    sent = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(filled) } }] }), { status: 200 });
  };
  let gsent: any;
  const gem: FetchLike = async (_url, init) => {
    gsent = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(shape) }] } }] }), { status: 200 });
  };
  const a = await ask(cfgOf("openai"), "x", REQUEST_SCHEMA, undefined, { deps: { fetch: oai, env: { OPENAI_API_KEY: OAI } } });
  const g = await ask(cfgOf("gemini"), "x", REQUEST_SCHEMA, undefined, { deps: { fetch: gem, env: { CY_AGENT_GEMINI_API_KEY: GKEY } } });
  const js = sent.response_format.json_schema;
  assert.equal(js.strict, true);
  assert.deepEqual(strictErrors(js.schema), []);
  assert.deepEqual(gsent.generationConfig.responseJsonSchema, JSON.parse(JSON.stringify(REQUEST_SCHEMA)), "Gemini 는 원래 스키마 그대로");
  assert.deepEqual(a, shape);
  assert.deepEqual(g, shape);
});
