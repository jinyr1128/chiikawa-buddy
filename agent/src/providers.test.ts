import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, loadConfig, readFileConfig } from "./config.ts";
import { REQUEST_SCHEMA, SCHEMA, ask, think } from "./brain.ts";
import { TODO_OPS_SCHEMA, parseOps } from "./todos.ts";
import { Store } from "./store.ts";
import { converse } from "./chat.ts";
import { inlineContext } from "./ctx-tools.ts";
import type { ContentBlock } from "./attachments.ts";
import {
  ANTHROPIC_URL, MISSING_ANTHROPIC_KEY, GEMINI_DEFAULT_MODEL, bestGeminiFlash, geminiQuota, MISSING_CODEX, MISSING_GEMINI_KEY, MISSING_OPENAI_KEY, OPENAI_DEFAULT_MODEL, OPENAI_URL,
  type ExecFileLike, type FetchLike, openaiStrict, openaiUnstrict, parseCodexStdout, resolveHttpModel, brainAuthFailed, resetBrainAuth, onBrainAuthChange, BrainAuthError,
} from "./providers.ts";

const KEY = "unit-test-gemini-key";
const OAI = "unit-test-openai-key";

function thoughtJson(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ bubble: "안녕", reply_md: "본문", todos: [], done_todo_ids: [], proposals: [], ...extra });
}

function cfgOf(provider: "claude-code" | "codex" | "anthropic" | "gemini" | "openai" | "local", general = "claude-sonnet-5-5") {
  const base = loadConfig({});
  return { ...base, brain: { provider }, models: { ...base.models, general } };
}

test("loadConfig: 기본은 claude-code, 환경변수가 파일과 키보다 우선", () => {
  assert.ok(process.env.CY_AGENT_HOME && HOME_DIR === process.env.CY_AGENT_HOME && HOME_DIR.startsWith(tmpdir()), HOME_DIR);
  // 공유 테스트 홈(HOME_DIR)의 config.json 에 쓰지 않는다: 다른 테스트 파일(다른 프로세스)이 같은 때 loadConfig() 로 읽어서
  // 그 사이 뇌가 local 로 보이면 흔들린다. 이 테스트만의 임시 파일을 readFileConfig 로 읽는다
  const path = join(mkdtempSync(join(tmpdir(), "cy-prov-")), "config.json");
  const secret = "sk-test-not-a-real-key-1234567890abcdef";
  const load = (env: NodeJS.ProcessEnv) => loadConfig(env, readFileConfig(path));
  assert.equal(load({}).brain.provider, "claude-code");
  assert.equal(load({}).brain.geminiApiKey, undefined);
  assert.equal(load({}).models.general, "claude-sonnet-5-5");
  writeFileSync(path, JSON.stringify({ brain: { provider: "local", geminiApiKey: "file-gemini", openaiApiKey: "file-openai" }, models: { general: "claude-sonnet-5-5" } }));
  assert.equal(load({}).brain.provider, "local");
  assert.equal(load({ CY_AGENT_BRAIN: "openai" }).brain.provider, "openai");
  assert.equal(load({}).brain.geminiApiKey, "file-gemini");
  assert.equal(load({}).brain.openaiApiKey, "file-openai");
  assert.equal(load({ GEMINI_API_KEY: "env-gemini" }).brain.geminiApiKey, "env-gemini");
  assert.equal(load({ CY_AGENT_GEMINI_API_KEY: "ns-gemini", GEMINI_API_KEY: "env-gemini" }).brain.geminiApiKey, "ns-gemini");
  assert.equal(load({ CY_AGENT_GEMINI_API_KEY: "  " }).brain.geminiApiKey, "file-gemini");
  assert.equal(load({ OPENAI_API_KEY: "env-openai" }).brain.openaiApiKey, "env-openai");
  assert.equal(load({ CY_AGENT_OPENAI_API_KEY: "ns-openai", OPENAI_API_KEY: "env-openai" }).brain.openaiApiKey, "ns-openai");
  // 모르는 뇌: 죽지 않고 local + configNotes 한 줄(키 같은 값은 숨김)
  const hid = load({ CY_AGENT_BRAIN: secret });
  assert.equal(hid.brain.provider, "local");
  assert.equal(JSON.stringify(hid.configNotes).includes(secret), false);
  assert.match(hid.configNotes!.join("\n"), /brain\.provider/);
  const nope = load({ CY_AGENT_BRAIN: "nope" });
  assert.equal(nope.brain.provider, "local");
  assert.match(nope.configNotes!.join("\n"), /nope/);
});

// 테스트 파일들은 같은 테스트 홈을 함께 쓴다 — 거기 config.json 에 쓰는 테스트가 있으면 다른 파일의 loadConfig() 가 흔들린다
test("테스트가 공유 테스트 홈의 config.json 에 쓰지 않는다", () => {
  const dir = new URL(".", import.meta.url);
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".test.ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    if (/join\(HOME_DIR,\s*"config\.json"\)/.test(src)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test("HTTP 모델: general이 Claude 기본이면 싼 공식 모델, 직접 지정하면 그 이름", () => {
  assert.equal(resolveHttpModel("gemini", "claude-sonnet-5-5"), GEMINI_DEFAULT_MODEL);
  assert.equal(resolveHttpModel("openai", "claude-sonnet-5-5"), OPENAI_DEFAULT_MODEL);
  assert.equal(resolveHttpModel("gemini", "gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(resolveHttpModel("openai", "gpt-4.1"), "gpt-4.1");
  assert.equal(resolveHttpModel("gemini", "claude-sonnet-5-5", "gemini-2.0-flash"), "gemini-2.0-flash");
  assert.equal(GEMINI_DEFAULT_MODEL, "gemini-3.8-flash");
  assert.equal(OPENAI_DEFAULT_MODEL, "gpt-4.1-mini");
});

test("gemini: URL·헤더만, 도구 없음, 키는 오류에 없다", async () => {
  let calls = 0;
  const fetch: FetchLike = async (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(url.includes(KEY), false);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.["x-goog-api-key"], KEY);
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(body.tools, undefined);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseJsonSchema);
    assert.match(body.contents[0].parts[0].text, /브리핑 표식/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: thoughtJson() }] } }] }), { status: 200 });
  };
  const out = await ask<{ reply_md: string }>(cfgOf("gemini"), "브리핑 표식", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_GEMINI_API_KEY: KEY } } });
  assert.equal(calls, 1);
  assert.equal(out.reply_md, "본문");
});

test("gemini: 기본 모델이 404면 목록에서 가장 새 flash로 한 번 더 보내고, 다음부터는 그 모델", async () => {
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(`${init?.method} ${url}`);
    if (url.includes("gemini-3.8-flash:")) return new Response("{}", { status: 404 });
    if (init?.method === "GET") {
      assert.equal(url.includes(KEY), false);
      assert.equal(init?.headers?.["x-goog-api-key"], `${KEY}-404`);
      return new Response(JSON.stringify({ models: [
        { name: "models/gemini-4-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4-flash-embed", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-9-flash", supportedGenerationMethods: ["embedContent"] },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: thoughtJson() }] } }] }), { status: 200 });
  };
  const key = `${KEY}-404`;
  const opts = { deps: { fetch, env: { CY_AGENT_GEMINI_API_KEY: key } } };
  const out = await ask<{ reply_md: string }>(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.equal(out.reply_md, "본문");
  assert.equal(urls.length, 3);
  assert.match(urls[2], /models\/gemini-4-flash:generateContent$/);
  urls.length = 0;
  await ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.deepEqual(urls.map((u) => u.split("/").pop()), ["gemini-4-flash:generateContent"]);
});

test("gemini: 붐비면(503) 목록에서 가장 새 flash-lite 로 넘어가고, lite 도 붐비면 쉬었다 다시", async () => {
  const posts: string[] = [];
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  const list = () => new Response(JSON.stringify({ models: [
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
  ] }), { status: 200 });
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: thoughtJson() }] } }] }), { status: 200 });
  let liteBusy = 0;
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === "GET") return list();
    const m = url.split("/").pop()!.replace(":generateContent", "");
    posts.push(m);
    if (m === "gemini-3.8-flash") return new Response("{}", { status: 503 });
    if (liteBusy-- > 0) return new Response("{}", { status: 503 });
    return ok();
  };
  const opts = { deps: { fetch, sleep, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-busy` } } };
  const out = await ask<{ reply_md: string }>(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.equal(out.reply_md, "본문");
  assert.deepEqual(posts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  assert.deepEqual(waits, []);

  posts.length = 0; liteBusy = 1;
  await ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.deepEqual(posts, ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
  assert.deepEqual(waits, [2000]);
});

test("gemini: 끝내 붐비면 알아듣기 쉬운 오류, Retry-After 를 따른다", async () => {
  let posts = 0;
  const waits: number[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if (init?.method === "GET") return new Response(JSON.stringify({ models: [] }), { status: 200 });
    posts++;
    return new Response("{}", { status: 503, headers: { "retry-after": "7" } });
  };
  await assert.rejects(
    ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch, sleep: async (ms: number) => { waits.push(ms); }, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-busy2` } } }),
    /붐벼서.*HTTP 503/,
  );
  assert.equal(posts, 3);
  assert.deepEqual(waits, [7000, 7000]);
});

// 2026-10 무료 키로 받은 429 본문 모양(하루 한도·분당 한도)
const quota429 = (quotaId: string, retryDelay: string, quotaValue = "20") => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota", details: [
  { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId, quotaValue }] },
  { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
] } }), { status: 429 });
const geminiList = (...ids: string[]) => new Response(JSON.stringify({ models: ids.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] })) }), { status: 200 });
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: thoughtJson() }] } }] }), { status: 200 });

test("geminiQuota: 하루 한도·분당 한도·retryDelay 읽기", async () => {
  assert.deepEqual(geminiQuota(await quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "62128s").text()), { day: true, waitMs: 62_128_000, limit: 20 });
  assert.deepEqual(geminiQuota(await quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "12.5s", "5").text()), { day: false, waitMs: 12_500 });
  assert.deepEqual(geminiQuota("{}"), { day: false });
  assert.deepEqual(geminiQuota("not json"), { day: false });
});

test("gemini: 하루 한도(429 PerDay)면 기다리지 않고 flash-lite 로, 그 뒤로는 다 쓴 모델을 건너뛴다", async () => {
  const posts: string[] = [], waits: number[] = [];
  let t = 1_000;
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === "GET") return geminiList("gemini-3.8-flash", "gemini-3.5-flash-lite");
    const m = url.split("/").pop()!.replace(":generateContent", "");
    posts.push(m);
    return m === "gemini-3.8-flash" ? quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "100s") : geminiOk();
  };
  const opts = { deps: { fetch, sleep: async (ms: number) => { waits.push(ms); }, now: () => t, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-day` } } };
  assert.equal((await ask<{ reply_md: string }>(cfgOf("gemini"), "x", SCHEMA, undefined, opts)).reply_md, "본문");
  assert.deepEqual(posts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  posts.length = 0;
  await ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.deepEqual(posts, ["gemini-3.5-flash-lite"], "다 쓴 모델은 건너뛴다");
  t += 101_000; posts.length = 0;
  await ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts);
  assert.deepEqual(posts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"], "다시 쓸 수 있는 때가 지나면 원래 모델부터");
  assert.deepEqual(waits, []);
});

test("gemini: 하루 한도인데 lite 가 이 계정에 없으면(404) 하루 한도 글로 알리고, 다음부터 lite 를 묻지 않는다", async () => {
  const posts: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === "GET") return geminiList("gemini-3.8-flash", "gemini-3.5-flash-lite");
    const m = url.split("/").pop()!.replace(":generateContent", "");
    posts.push(m);
    return m === "gemini-3.8-flash" ? quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "62128s") : new Response("", { status: 404 });
  };
  const opts = { deps: { fetch, sleep: async () => {}, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-day404` } } };
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts), (e: Error) => {
    assert.equal(e.message, "오늘 쓸 수 있는 Gemini 무료 사용량을 다 썼어요(무료 키는 모델마다 하루 20번이 정해져 있어요). 내일 다시 쓰거나, 결제를 켠 키를 넣어 주세요 (HTTP 429).");
    return true;
  });
  assert.deepEqual(posts, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  posts.length = 0;
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, opts), /무료 사용량을 다 썼어요/);
  assert.deepEqual(posts, [], "다 쓴 모델도, 없는 lite 도 다시 보내지 않는다");
});

test("gemini: 분당 한도(429 PerMinute)는 retryDelay 만큼 기다렸다 다시, 너무 길면 기다리지 않는다", async () => {
  let n = 0;
  const waits: number[] = [];
  const fetch: FetchLike = async (_url, init) => {
    if (init?.method === "GET") return geminiList("gemini-3.8-flash");
    return n++ < 1 ? quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "9s", "5") : geminiOk();
  };
  await ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch, sleep: async (ms: number) => { waits.push(ms); }, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-min` } } });
  assert.deepEqual(waits, [9000]);
  const long: FetchLike = async (_url, init) => (init?.method === "GET" ? geminiList("gemini-3.8-flash") : quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "600s", "5"));
  waits.length = 0;
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: long, sleep: async (ms: number) => { waits.push(ms); }, env: { CY_AGENT_GEMINI_API_KEY: `${KEY}-min2` } } }), /사용량 한도에 걸렸어요.*HTTP 429/);
  assert.deepEqual(waits, []);
});

test("gemini: 빈 답은 이유(안전 필터·길이)를 알리고, 400 은 Gemini 가 준 이유 한 줄을 붙인다(키는 없다)", async () => {
  const env = { CY_AGENT_GEMINI_API_KEY: `${KEY}-empty` };
  const one = (r: () => Response): FetchLike => async (_u, init) => (init?.method === "GET" ? geminiList() : r());
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: one(() => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }))), env } }), /안전 필터/);
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: one(() => new Response(JSON.stringify({ promptFeedback: { blockReason: "OTHER" } }))), env } }), /안전 필터/);
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: one(() => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }))), env } }), /너무 길어/);
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: one(() => new Response(JSON.stringify({ candidates: [] }))), env } }), /빈 답/);
  await assert.rejects(ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: one(() => new Response(JSON.stringify({ error: { message: `Invalid JSON payload ${env.CY_AGENT_GEMINI_API_KEY}\nmore` } }), { status: 400 })), env } }), (e: Error) => {
    assert.equal(e.message, "Gemini 요청이 실패했어요 (HTTP 400: Invalid JSON payload …).");
    return true;
  });
});

test("bestGeminiFlash: lite 고르기", () => {
  assert.equal(bestGeminiFlash(["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"], true), "gemini-3.5-flash-lite");
});

test("bestGeminiFlash: 일반 flash 중 가장 새 것", () => {
  assert.equal(bestGeminiFlash(["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.10-flash", "gemini-9-flash-lite", "gemini-3.8-pro"]), "gemini-3.10-flash");
  assert.equal(bestGeminiFlash(["gemini-pro"]), undefined);
});

test("gemini: 키가 없으면 한국어 오류, fetch도 local 폴백도 없다", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => { calls++; return new Response("{}", { status: 200 }); };
  await assert.rejects(() => ask(cfgOf("gemini"), "안녕", SCHEMA, undefined, { deps: { fetch, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_GEMINI_KEY);
    assert.equal(err.message.includes("안녕"), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("gemini: 실패 본문과 예외 문자열에 키를 넣지 않는다", async () => {
  const boom: FetchLike = async () => { throw new Error(`network ${KEY}`); };
  await assert.rejects(() => ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: boom, env: { GEMINI_API_KEY: KEY } } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Gemini 요청을 보내지 못했어요.");
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
  const denied: FetchLike = async () => new Response(JSON.stringify({ error: KEY }), { status: 401 });
  await assert.rejects(() => ask(cfgOf("gemini"), "x", SCHEMA, undefined, { deps: { fetch: denied, env: { GEMINI_API_KEY: KEY } } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Gemini API 키가 맞지 않아요. 키를 확인해 주세요 (HTTP 401).");
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
  resetBrainAuth();
});

test("openai: URL·Bearer·모델, 도구 없음", async () => {
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, OPENAI_URL);
    assert.equal(url.includes(OAI), false);
    assert.equal(init?.headers?.Authorization, `Bearer ${OAI}`);
    const body = JSON.parse(init?.body ?? "{}");
    assert.equal(body.model, "gpt-4.1-mini");
    assert.equal(body.tools, undefined);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: thoughtJson() } }] }), { status: 200 });
  };
  const out = await ask<{ bubble: string }>(cfgOf("openai"), "채팅 표식", SCHEMA, undefined, { deps: { fetch, env: { OPENAI_API_KEY: OAI } } });
  assert.equal(out.bubble, "안녕");
});

test("anthropic(Claude API 키): Messages API · x-api-key · json_schema, 모델은 Claude 이름만, 도구 없음", async () => {
  const KEYA = "sk-ant-unit-test-key-1234567890";
  const seen: any[] = [];
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, ANTHROPIC_URL);
    assert.equal(init?.headers?.["x-api-key"], KEYA);
    assert.equal(init?.headers?.["anthropic-version"], "2023-06-01");
    const body = JSON.parse(init?.body ?? "{}");
    seen.push(body);
    assert.equal(body.tools, undefined);
    assert.equal(body.output_config.format.type, "json_schema");
    return new Response(JSON.stringify({ content: [{ type: "text", text: thoughtJson() }], stop_reason: "end_turn" }), { status: 200 });
  };
  const out = await ask<{ bubble: string }>(cfgOf("anthropic", "claude-haiku-5-5"), "채팅 표식", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } });
  assert.equal(out.bubble, "안녕");
  assert.equal(seen[0].model, "claude-haiku-5-5");
  await ask(cfgOf("anthropic", "gemini-2.5-pro"), "x", SCHEMA, undefined, { deps: { fetch, env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } });
  assert.equal(seen[1].model, "claude-sonnet-5-5", "Claude 이름이 아니면 기본 Claude 모델");
  // 키가 없으면 한국어 오류 · fetch 없음, 실패에도 키는 없다
  let called = 0;
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => { called++; return new Response("", { status: 500 }); }, env: {} } }), (e: Error) => e.message === MISSING_ANTHROPIC_KEY);
  assert.equal(called, 0);
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response(`bad ${KEYA}`, { status: 401 }), env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } }), (e: Error) => !e.message.includes(KEYA) && /401/.test(e.message));
  await assert.rejects(ask(cfgOf("anthropic"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), { status: 200 }), env: { CY_AGENT_ANTHROPIC_API_KEY: KEYA } } }), /답하지 않았어요/);
  // config: CY_AGENT_ANTHROPIC_API_KEY > 파일, ANTHROPIC_API_KEY 는 읽지 않는다
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-general" }).brain.anthropicApiKey, undefined);
  assert.equal(loadConfig({ CY_AGENT_ANTHROPIC_API_KEY: "sk-ant-ns" }).brain.anthropicApiKey, "sk-ant-ns");
  assert.equal(loadConfig({ CY_AGENT_BRAIN: "anthropic" }).brain.provider, "anthropic");
});

test("openai: 키가 없으면 한국어 오류", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => { calls++; return new Response("{}", { status: 200 }); };
  await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_OPENAI_KEY);
    assert.equal(err.message.includes(OAI), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("codex: 없으면 한국어 오류이고 exec는 한 번도 없다", async () => {
  let execs = 0;
  const execFile: ExecFileLike = async () => { execs++; return { stdout: "" }; };
  await assert.rejects(() => ask(cfgOf("codex"), "x", SCHEMA, undefined, { deps: { commandExists: () => false, execFile, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, MISSING_CODEX);
    return true;
  });
  assert.equal(execs, 0);
});

test("codex: exec 한 번으로 JSONL Thought를 파싱하고 바이너리는 실행하지 않는다", async () => {
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const execFile: ExecFileLike = async (file, args, opts) => {
    calls.push({ file, args, input: opts?.input });
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: thoughtJson() } });
    return { stdout: `{"type":"thread.started"}\n${line}\n` };
  };
  const out = await ask<{ reply_md: string }>(cfgOf("codex"), "프롬프트-표식", SCHEMA, undefined, {
    deps: { commandExists: (name) => name === "codex", execFile, env: {} },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "codex");
  assert.ok(calls[0].args.includes("exec"));
  assert.ok(calls[0].args.includes("--json"));
  assert.ok(calls[0].args.includes("-"));
  assert.match(calls[0].input ?? "", /프롬프트-표식/);
  assert.equal(out.reply_md, "본문");
  assert.equal((parseCodexStdout(thoughtJson()) as { reply_md: string }).reply_md, "본문");
});

test("codex 출력이 JSON이 아니면 본문을 오류에 넣지 않는다", async () => {
  const secret = "codex-stdout-secret-value";
  const execFile: ExecFileLike = async () => ({ stdout: secret });
  await assert.rejects(() => ask(cfgOf("codex"), "x", SCHEMA, undefined, { deps: { commandExists: () => true, execFile, env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "codex 출력에서 JSON을 읽지 못했어요.");
    assert.equal(err.message.includes(secret), false);
    return true;
  });
});

test("local think: 스토어의 1·3만 말하고 할 일을 만들지 않는다", async () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "견적 회신", source: "other", priority: 1 });
  store.upsertTodo({ id: "b", title: "보면 좋은 글", source: "other", priority: 3 });
  store.upsertTodo({ id: "c", title: "나중 일", source: "other", priority: 2 });
  store.upsertTodo({ id: "d", title: "끝난 보고서", source: "other", priority: 2, status: "done" });
  const t = await think(cfgOf("local"), store, "정기 브리핑");
  assert.deepEqual(t.todos, []);
  assert.deepEqual(t.done_todo_ids, []);
  assert.deepEqual(t.proposals, []);
  assert.match(t.reply_md, /견적 회신/);
  assert.match(t.reply_md, /보면 좋은 글/);
  assert.match(t.reply_md, /끝난 보고서/);
  assert.doesNotMatch(t.reply_md, /나중 일/);
  assert.ok(t.bubble.length <= 40);
  assert.equal(t.bubble.includes("\n"), false);
});

test("local ask: 브리핑·채팅 스키마가 아니면 SDK 없이 거절한다", async () => {
  await assert.rejects(() => ask(cfgOf("local"), "설명", { type: "object", required: ["description"] }, undefined, { deps: { env: {} } }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "로컬 뇌는 브리핑·채팅만 답해요.");
    return true;
  });
});

test("잘못된 API 키(401·403): 그 키만 기억 → /status brain.ready=false·「키를 확인해 주세요」, 성공하거나 키가 바뀌면 풀림", async () => {
  const { statusOf } = await import("./status.ts");
  resetBrainAuth();
  let changes = 0;
  onBrainAuthChange(() => changes++);
  try {
    for (const [provider, envKey, status] of [["openai", "OPENAI_API_KEY", 401], ["gemini", "GEMINI_API_KEY", 403], ["anthropic", "CY_AGENT_ANTHROPIC_API_KEY", 401]] as const) {
      const env = { [envKey]: "bad-key-1" };
      const cfg = cfgOf(provider);
      const denied: FetchLike = async () => new Response("{}", { status });
      await assert.rejects(() => ask(cfg, "x", SCHEMA, undefined, { deps: { fetch: denied, env } }), (e: unknown) => e instanceof BrainAuthError && /키를 확인해 주세요/.test((e as Error).message));
      assert.equal(brainAuthFailed(cfg, env), true, provider);
      const st = statusOf(cfg, { env });
      assert.equal(st.brain.ready, false);
      assert.equal(st.chat, false);
      assert.match(st.brain.detail, /키를 확인해 주세요/);
      assert.equal(brainAuthFailed(cfg, { [envKey]: "new-key-2" }), false, "키를 바꾸면 다시 해 본다");
      assert.equal(statusOf(cfg, { env: { [envKey]: "new-key-2" } }).brain.ready, true);
    }
    assert.equal(changes, 3);
    // 500 같은 다른 오류는 키 탓으로 보지 않는다
    resetBrainAuth();
    const env = { OPENAI_API_KEY: "k" };
    await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response("{}", { status: 500 }), env } }), /HTTP 500/);
    assert.equal(brainAuthFailed(cfgOf("openai"), env), false);
    // 틀렸다가 성공하면 풀린다
    await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: async () => new Response("{}", { status: 401 }), env } }));
    assert.equal(brainAuthFailed(cfgOf("openai"), env), true);
    const ok: FetchLike = async () => new Response(JSON.stringify({ choices: [{ message: { content: thoughtJson() } }] }), { status: 200 });
    await ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: ok, env } });
    assert.equal(brainAuthFailed(cfgOf("openai"), env), false);
  } finally {
    onBrainAuthChange(undefined);
    resetBrainAuth();
  }
});

test("API 키·Codex 연결도 첨부(글·그림·PDF)를 받는다 — 예전엔 블록을 버려 본 척했다", async () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "<첨부>TEXT_MARK</첨부>" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "PNG_MARK" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF_MARK" }, title: "memo.pdf" },
  ];
  const reply = (p: string, text: string) => new Response(JSON.stringify(p === "gemini" ? { candidates: [{ content: { parts: [{ text }] } }] } : p === "openai" ? { choices: [{ message: { content: text } }] } : { content: [{ type: "text", text }], stop_reason: "end_turn" }), { status: 200 });
  for (const p of ["gemini", "openai", "anthropic"] as const) {
    let body: any;
    const fetch: FetchLike = async (_u, init) => { body = JSON.parse(init?.body ?? "{}"); return reply(p, thoughtJson()); };
    await ask(cfgOf(p), "첨부 봐 줘", SCHEMA, undefined, { blocks, deps: { fetch, env: { GEMINI_API_KEY: KEY, OPENAI_API_KEY: OAI, CY_AGENT_ANTHROPIC_API_KEY: "sk-ant-unit" } } });
    const parts = p === "gemini" ? body.contents[0].parts.slice(1) : p === "openai" ? body.messages.at(-1).content.slice(1) : body.messages[0].content.slice(1);
    assert.deepEqual(parts.map((x: any) => x.text !== undefined ? "text" : x.inlineData?.mimeType ?? x.type), p === "gemini" ? ["text", "image/png", "application/pdf"] : p === "openai" ? ["text", "image_url", "file"] : ["text", "image", "document"], p);
    for (const m of ["TEXT_MARK", "PNG_MARK", "PDF_MARK"]) assert.ok(JSON.stringify(body).includes(m), `${p} ${m}`);
  }
  let input = "";
  const execFile: ExecFileLike = async (_f, _a, o: any) => { input = o.input; return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: thoughtJson() } }) }; };
  await ask(cfgOf("codex"), "첨부 봐 줘", SCHEMA, undefined, { blocks, deps: { commandExists: () => true, execFile, env: {} } });
  assert.ok(input.includes("TEXT_MARK") && !input.includes("PNG_MARK"));
  assert.match(input, /memo\.pdf — 이 AI 연결\(Codex\)로는 그림·PDF 내용을 받지 못했다/);
});

test("Claude Code 가 아닌 뇌는 contextMode tools 여도 맥락을 프롬프트에(도구를 못 부른다) · 못 붙인 첨부는 열어 보라고 하지 않는다", async () => {
  assert.equal(inlineContext({ contextMode: "tools", brain: { provider: "gemini" } }), true);
  assert.equal(inlineContext({ contextMode: "tools", brain: { provider: "claude-code" } }), false);
  assert.equal(inlineContext({ contextMode: "tools" }), false);
  const store = new Store(":memory:");
  store.addTodo({ title: "DB_TODO_MARK", priority: 1 });
  const thread = store.createThread({ title: "t" });
  const dir = mkdtempSync(join(tmpdir(), "cy-att-")), path = join(dir, "report.docx");
  writeFileSync(path, "PK-fake");
  const original = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_u: any, init: any) => { body = String(init?.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply_md: "ok", bubble: "ok", show: null }) }] } }] }), { status: 200 }); }) as any;
  try {
    const cfg = { ...cfgOf("gemini"), brain: { provider: "gemini" as const, geminiApiKey: KEY }, contextMode: "tools" as const, repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" };
    await converse(cfg, store, [], "할 일 알려줘", () => {}, undefined, undefined, thread.id, undefined, undefined, undefined,
      [{ id: "a1", name: "report.docx", mime: "application/octet-stream", size: 7, kind: "file", file: "report.docx", path }]);
  } finally { globalThis.fetch = original; }
  assert.ok(body.includes("DB_TODO_MARK"));
  assert.ok(body.includes("이 AI 연결은 파일을 열 수 없어 내용을 못 받았다"));
  assert.ok(!body.includes("Read(글·그림·PDF·ipynb)"));
});

test("openai strict: 선택 속성도 전부 required 로 보내고, 받은 답은 원래 모양으로(생략 ≠ null 지우기)", async () => {
  const strictOk = (s: any, at = "$"): void => {
    if (!s || typeof s !== "object") return;
    if (s.properties) {
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), at);
      assert.equal(s.additionalProperties, false, at);
      for (const [k, v] of Object.entries(s.properties)) strictOk(v, `${at}.${k}`);
    }
    if (s.items) strictOk(s.items, `${at}[]`);
    for (const k of ["anyOf", "oneOf", "allOf"]) (s[k] ?? []).forEach((x: any) => strictOk(x, at));
  };
  for (const s of [SCHEMA, REQUEST_SCHEMA, TODO_OPS_SCHEMA]) {
    const before = JSON.stringify(s);
    strictOk(openaiStrict(s));
    assert.equal(JSON.stringify(s), before); // 원본은 그대로
  }
  // 우선순위만 바꾸는 edit: 생략 자리(null · {"_omit":true})는 지우고, note: null(메모 지우기)은 남는다
  const got = [{ op: "edit", id: "user:1", title: null, priority: 1, link: { _omit: true }, note: null, description: null, source_ref: null }];
  const ops = openaiUnstrict(got, TODO_OPS_SCHEMA);
  assert.deepEqual(ops, [{ op: "edit", id: "user:1", priority: 1, note: null }]);
  assert.equal(parseOps(ops).ok, true);
  // 실제 요청·응답 경로
  let sent: any;
  const fetch: FetchLike = async (_u, init) => { sent = JSON.parse(init?.body ?? "{}"); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bubble: "b", reply_md: "r", todos: [], done_todo_ids: [], proposals: [], todo_ops: got, plan_ops: [], memory_ops: [], rule: null }) } }] }), { status: 200 }); };
  const out: any = await ask(cfgOf("openai"), "x", REQUEST_SCHEMA, undefined, { deps: { fetch, env: { OPENAI_API_KEY: OAI } } });
  strictOk(sent.response_format.json_schema.schema);
  assert.deepEqual(out.todo_ops, [{ op: "edit", id: "user:1", priority: 1, note: null }]);
});

test("openai 429: 크레딧 없음(insufficient_quota)은 다시 보내지 않고 결제 안내, 너무 잦음은 쉬었다 다시", async () => {
  const quota = JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota", param: null, code: "insufficient_quota" } });
  const rate = JSON.stringify({ error: { message: "Rate limit reached for gpt-4.1-mini", type: "requests", param: null, code: "rate_limit_exceeded" } });
  // 크레딧 없음: 한 번만 보내고 바로 결제 안내
  let n = 0;
  const waits: number[] = [];
  const noCredit: FetchLike = async () => { n++; return new Response(quota, { status: 429 }); };
  await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: noCredit, sleep: async (ms: number) => { waits.push(ms); }, env: { OPENAI_API_KEY: OAI } } }), (e: unknown) => {
    const m = String((e as Error).message);
    assert.match(m, /OpenAI 크레딧이 없어요/);
    assert.match(m, /platform\.openai\.com\/settings\/organization\/billing/);
    assert.ok(!m.includes(OAI));
    return true;
  });
  assert.equal(n, 1);
  assert.deepEqual(waits, []);
  // 너무 잦음: 쉬었다 다시 보내고, 그다음에 되면 답
  let k = 0;
  const thenOk: FetchLike = async () => (++k < 3 ? new Response(rate, { status: 429 }) : new Response(JSON.stringify({ choices: [{ message: { content: thoughtJson() } }] }), { status: 200 }));
  const out = await ask<{ bubble: string }>(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: thenOk, sleep: async () => {}, env: { OPENAI_API_KEY: OAI } } });
  assert.equal(out.bubble, "안녕");
  assert.equal(k, 3);
  // 계속 너무 잦으면 「잠시 뒤 다시」
  const always: FetchLike = async () => new Response(rate, { status: 429 });
  await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: always, sleep: async () => {}, env: { OPENAI_API_KEY: OAI } } }), /OpenAI 요청이 너무 잦아요.*HTTP 429/);
});

test("openai 400: OpenAI 가 준 이유 한 줄을 붙이고 키 모양 글자는 가린다", async () => {
  const bad = JSON.stringify({ error: { message: "Invalid schema for response_format 'cy_brain': key sk-proj-ABCDEFGH12345678 leaked", type: "invalid_request_error", code: null } });
  const f: FetchLike = async () => new Response(bad, { status: 400 });
  await assert.rejects(() => ask(cfgOf("openai"), "x", SCHEMA, undefined, { deps: { fetch: f, env: { OPENAI_API_KEY: OAI } } }), (e: unknown) => {
    const m = String((e as Error).message);
    assert.match(m, /OpenAI 가 요청을 받지 않았어요: Invalid schema/);
    assert.ok(!m.includes("sk-proj-ABCDEFGH12345678"));
    return true;
  });
});
