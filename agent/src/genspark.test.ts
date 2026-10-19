// Genspark 뇌: 무료 키로 실제 프록시에 보낸 응답 본문을 그대로 쓴 가짜 fetch 로 본다(키는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Settings } from "./settings.ts";
import { statusOf } from "./status.ts";
import { redact } from "./connections.ts";
import {
  GENSPARK_NO_CREDIT, GENSPARK_URL, BrainAuthError, BrainCreditError, brainAuthFailed, brainCreditNeeded, brainKeyReady, gensparkJson, gensparkKey,
  gensparkModels, gskLoginKey, gskLoginPath, isGensparkCreditNotice, pickGensparkModel, resetBrainAuth, resetGensparkModels, type FetchLike,
} from "./providers.ts";

const FAKE = "gsk-unit-test-fake-key-0123456789abcdefghijklmnopqrstuvwxyz";
const SCHEMA = { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" }, note: { type: "string" } } };
// GET /models 실제 모양(73개 중 몇 개)
const MODELS = JSON.stringify({ object: "list", data: ["gpt-5.4-mini", "claude-haiku-5-5", "claude-sonnet-5-5", "kimi-k3"].map((id) => ({ id, object: "model", created: 0, owned_by: id.startsWith("claude") ? "anthropic" : "openai" })) });
const FREE = "Free-plan credits can't be used with the Genspark API / LLM proxy. Please visit https://www.genspark.ai/pricing?fromurl=credit_exhausted&entry=llm_proxy to subscribe.";
const chatBody = (content: string) => JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

function cfgOf(general = "claude-sonnet-5-5", key?: string) {
  const base = loadConfig({});
  return { ...base, brain: { provider: "genspark" as const, ...(key ? { gensparkApiKey: key } : {}) }, models: { ...base.models, general } };
}

type Call = { url: string; init: any };
function fake(chat: (body: any) => Response, models: () => Response = () => new Response(MODELS, { status: 200 })) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/models") ? models() : chat(JSON.parse(init?.body ?? "{}"));
  };
  return { fetch, calls };
}

function fresh() { resetBrainAuth(); resetGensparkModels(); }
const ENV = { HOME: "/nonexistent-home-for-test" };

test("genspark: 200 JSON 답 — OpenAI 모양 요청(Bearer·strict json_schema·리다이렉트 안 따라감), 기본 모델은 목록에서", async () => {
  fresh();
  const { fetch, calls } = fake(() => new Response(chatBody(JSON.stringify({ reply: "안녕", note: null })), { status: 200 }));
  const out = await gensparkJson(cfgOf(), "hi", SCHEMA, { system: "sys", fetch, env: { ...ENV, CY_AGENT_GENSPARK_API_KEY: FAKE } });
  assert.deepEqual(out, { reply: "안녕" }); // strict 의 null 자리는 지운다
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${GENSPARK_URL}/models`);
  assert.equal(calls[1]!.url, `${GENSPARK_URL}/chat/completions`);
  for (const c of calls) {
    assert.equal(c.init.redirect, "error");
    assert.equal(c.init.headers.Authorization, `Bearer ${FAKE}`);
  }
  const body = JSON.parse(calls[1]!.init.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ["reply", "note"]);
  assert.equal(brainCreditNeeded(cfgOf("x", FAKE), ENV), false);
});

test("genspark: 모델 목록은 잠깐 기억하고, 목록에 없는 모델은 보내기 전에 막는다", async () => {
  fresh();
  const { fetch, calls } = fake(() => new Response(chatBody('{"reply":"ok"}'), { status: 200 }));
  const env = { ...ENV, CY_AGENT_GENSPARK_API_KEY: FAKE };
  await gensparkJson(cfgOf("gpt-5.4-mini"), "a", SCHEMA, { fetch, env });
  await gensparkJson(cfgOf("kimi-k3"), "b", SCHEMA, { fetch, env });
  assert.equal(calls.filter((c) => c.url.endsWith("/models")).length, 1); // 목록은 한 번만
  assert.deepEqual(calls.filter((c) => c.url.endsWith("/chat/completions")).map((c) => JSON.parse(c.init.body).model), ["gpt-5.4-mini", "kimi-k3"]);
  const before = calls.length;
  await assert.rejects(gensparkJson(cfgOf("gemini-3.8-flash"), "c", SCHEMA, { fetch, env }), /Genspark 에서 못 써요/);
  assert.equal(calls.length, before); // 요청을 보내지 않았다
  // 캐시가 지나면 다시 받는다
  let t = 0;
  await gensparkModels(`${FAKE}-ttl`, { fetch, now: () => t });
  t = 11 * 60_000;
  await gensparkModels(`${FAKE}-ttl`, { fetch, now: () => t });
  assert.equal(calls.filter((c) => c.url.endsWith("/models")).length, 3);
});

test("genspark: 기본 모델은 목록에서 고른다(sonnet → gpt-5.4-mini → 첫 번째)", () => {
  assert.equal(pickGensparkModel(["gpt-5.4-mini", "claude-sonnet-5-5"]), "claude-sonnet-5-5");
  assert.equal(pickGensparkModel(["kimi-k3", "gpt-5.4-mini"]), "gpt-5.4-mini");
  assert.equal(pickGensparkModel(["kimi-k3", "glm-5"]), "kimi-k3");
});

test("genspark: 무료 플랜 안내문(200) → 「크레딧이 필요해요」, 상태에도 그대로", async () => {
  fresh();
  const { fetch } = fake(() => new Response(chatBody(FREE), { status: 200 }));
  const cfg = cfgOf("claude-sonnet-5-5", FAKE);
  await assert.rejects(gensparkJson(cfg, "hi", SCHEMA, { fetch, env: ENV }), (e: Error) => e instanceof BrainCreditError && e.message === GENSPARK_NO_CREDIT);
  assert.match(GENSPARK_NO_CREDIT, /https:\/\/www\.genspark\.ai\/pricing/);
  assert.equal(brainCreditNeeded(cfg, ENV), true);
  assert.equal(brainAuthFailed(cfg, ENV), false);
  const st = statusOf(cfg, { env: ENV });
  assert.equal(st.brain.ready, false);
  assert.equal(st.brain.detail, "Genspark 키는 맞지만 크레딧이 필요해요");
  // 결제 뒤 한 번 되면 풀린다
  const ok = fake(() => new Response(chatBody('{"reply":"ok"}'), { status: 200 }));
  await gensparkJson(cfg, "hi", SCHEMA, { fetch: ok.fetch, env: ENV });
  assert.equal(brainCreditNeeded(cfg, ENV), false);
  assert.equal(statusOf(cfg, { env: ENV }).brain.ready, true);
  assert.ok(isGensparkCreditNotice("Your Genspark credits have been exhausted"));
  assert.ok(!isGensparkCreditNotice("오늘 할 일 세 개 남았어요"));
});

test("genspark: 401 → 키가 맞지 않아요(gsk login), 400 모델 → 못 써요, 422 → 형식 오류(로그에 errors)", async () => {
  fresh();
  const cfg = cfgOf("claude-sonnet-5-5", FAKE);
  // 401: 목록부터
  const a = fake(() => new Response("", { status: 500 }), () => new Response('{"detail":"Missing authorization header"}', { status: 401 }));
  await assert.rejects(gensparkJson(cfg, "hi", SCHEMA, { fetch: a.fetch, env: ENV }), (e: Error) => e instanceof BrainAuthError && /Genspark 키가 맞지 않아요\(gsk login 을 다시 해 주세요\)/.test(e.message) && !e.message.includes(FAKE));
  assert.equal(brainAuthFailed(cfg, ENV), true);
  assert.equal(statusOf(cfg, { env: ENV }).brain.detail, "Genspark 키가 맞지 않아요(gsk login 을 다시 해 주세요)");
  fresh();
  // 400: 목록엔 있는데 프록시가 거절(목록이 바뀐 사이)
  const b = fake(() => new Response(JSON.stringify({ detail: "Model 'kimi-k3' is not allowed. See GET /v1/models for the available models." }), { status: 400 }));
  await assert.rejects(gensparkJson(cfgOf("kimi-k3", FAKE), "hi", SCHEMA, { fetch: b.fetch, env: ENV }), /그 모델은 Genspark 에서 못 써요.*\(HTTP 400\)/);
  // 422
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...x: unknown[]) => { logged.push(x.join(" ")); };
  try {
    const c = fake(() => new Response(JSON.stringify({ status: -2, message: "Request parameter validation failed", errors: [{ type: "missing", loc: ["body", "messages"], msg: "Field required" }], data: {} }), { status: 422 }));
    await assert.rejects(gensparkJson(cfg, "hi", SCHEMA, { fetch: c.fetch, env: ENV }), /Genspark 가 요청 형식을 받지 않았어요 \(HTTP 422\)/);
  } finally { console.warn = warn; }
  assert.ok(logged.some((l) => l.includes("Field required") && l.includes("messages")));
  assert.equal(brainAuthFailed(cfg, ENV), false);
});

test("genspark: 붐비면(503) 기존 규칙대로 쉬었다 다시, 네트워크 실패는 짧은 말", async () => {
  fresh();
  let n = 0;
  const waits: number[] = [];
  const { fetch } = fake(() => (++n < 3 ? new Response("busy", { status: 503 }) : new Response(chatBody('{"reply":"ok"}'), { status: 200 })));
  const out = await gensparkJson(cfgOf("claude-sonnet-5-5", FAKE), "hi", SCHEMA, { fetch, env: ENV, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(out, { reply: "ok" });
  assert.deepEqual(waits, [2000, 5000]);
  const down: FetchLike = async (url) => { if (url.endsWith("/models")) return new Response(MODELS, { status: 200 }); throw new TypeError(`fetch failed ${FAKE}`); };
  await assert.rejects(gensparkJson(cfgOf("claude-sonnet-5-5", FAKE), "hi", SCHEMA, { fetch: down, env: ENV }), (e: Error) => e.message === "Genspark 요청을 보내지 못했어요." );
});

test("genspark: 리다이렉트는 따라가지 않는다(진짜 fetch 로 30x 를 주면 실패)", async () => {
  fresh();
  const { createServer } = await import("node:http");
  let hits = 0;
  const srv = createServer((req, res) => { hits++; res.writeHead(302, { location: "http://127.0.0.1:1/steal" }); res.end(); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  // 주소만 로컬 서버로 바꿔 진짜 fetch 에 같은 옵션을 넘긴다
  const fetch: FetchLike = (url, init) => globalThis.fetch(url.replace(GENSPARK_URL, `http://127.0.0.1:${port}`), init as RequestInit);
  try {
    await assert.rejects(gensparkModels(FAKE, { fetch, fresh: true }), /Genspark 모델 목록을 받지 못했어요/);
    assert.equal(hits, 1);
  } finally { srv.close(); }
});

test("genspark: 키는 환경변수 > 설정 > gsk login 파일(읽기만, 쓸 때마다 읽는다)", () => {
  const home = mkdtempSync(join(tmpdir(), "gsk-home-"));
  try {
    const env = { HOME: home, USERPROFILE: home };
    assert.equal(gskLoginKey(env), undefined);
    assert.equal(brainKeyReady(cfgOf(), env), false);
    mkdirSync(join(home, ".genspark-tool-cli"));
    const file = join(home, ".genspark-tool-cli", "config.json");
    const raw = JSON.stringify({ api_key: FAKE, base_url: "https://www.genspark.ai" });
    writeFileSync(file, raw);
    assert.equal(gskLoginKey(env), FAKE);
    assert.equal(gensparkKey(cfgOf(), env), FAKE);
    assert.equal(brainKeyReady(cfgOf(), env), true);
    // 다시 로그인해 키가 바뀌면 바로 따라간다
    writeFileSync(file, JSON.stringify({ api_key: `${FAKE}-2` }));
    assert.equal(gensparkKey(cfgOf(), env), `${FAKE}-2`);
    assert.equal(gensparkKey(cfgOf("x", "gsk-from-settings"), env), "gsk-from-settings");
    assert.equal(gensparkKey(cfgOf("x", "gsk-from-settings"), { ...env, CY_AGENT_GENSPARK_API_KEY: "gsk-from-env" }), "gsk-from-env");
    // 깨진 파일·다른 모양은 없는 것과 같다
    writeFileSync(file, "{oops");
    assert.equal(gskLoginKey(env), undefined);
    writeFileSync(file, JSON.stringify({ api_key: "not-a-gsk-key" }));
    assert.equal(gskLoginKey(env), undefined);
    // 메모장 등이 붙인 BOM 은 벗기고 읽는다
    writeFileSync(file, "\uFEFF" + raw);
    assert.equal(gskLoginKey(env), FAKE);
    // 홈 없는 env 를 따로 넘기면 진짜 홈은 읽지 않는다
    assert.equal(gskLoginKey({}), undefined);
    writeFileSync(file, raw);
    assert.equal(readFileSync(file, "utf8"), raw); // 우리는 고치지 않는다
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("genspark: gsk login 홈은 os.homedir() 와 같게 — 윈도우는 USERPROFILE(전역 HOME 이 따로 있어도), 그 밖은 HOME", () => {
  const p = (dir: string) => join(dir, ".genspark-tool-cli", "config.json");
  assert.equal(gskLoginPath({ HOME: "/h/git", USERPROFILE: "C:/Users/me" }, "win32"), p("C:/Users/me"));
  assert.equal(gskLoginPath({ HOME: "/h/git" }, "win32"), undefined);
  assert.equal(gskLoginPath({ HOME: "/home/me", USERPROFILE: "/x" }, "linux"), p("/home/me"));
  assert.equal(gskLoginPath({ HOME: "/Users/me" }, "darwin"), p("/Users/me"));
  assert.equal(gskLoginPath({ USERPROFILE: "/x" }, "darwin"), undefined);
  assert.equal(gskLoginPath(process.env), p(homedir())); // 진짜 env 면 os.homedir()
});

test("genspark: 설정 — provider·키 받기, 화면엔 있는지만(gsk login 파일 포함), 키는 오류 글·로그에 안 나간다", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsk-settings-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".genspark-tool-cli"), { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    const cfg = loadConfig({});
    const s = new Settings(cfg, { path, env: { HOME: home, USERPROFILE: home } });
    assert.ok(s.put({ brain: { provider: "genspark", keys: { genspark: FAKE } } }).ok);
    assert.equal(cfg.brain.provider, "genspark");
    assert.equal(cfg.brain.gensparkApiKey, FAKE);
    assert.equal(s.view().brain.keys.genspark, true);
    assert.ok(!JSON.stringify(s.view()).includes(FAKE));
    // 키를 지우면(「gsk login 한 키 쓰기」) 설정엔 없고, 파일이 있으면 있는 것으로 본다
    assert.ok(s.put({ brain: { keys: { genspark: null } } }).ok);
    assert.equal(cfg.brain.gensparkApiKey, undefined);
    assert.ok(!readFileSync(path, "utf8").includes(FAKE));
    assert.equal(s.view().brain.keys.genspark, false);
    writeFileSync(join(home, ".genspark-tool-cli", "config.json"), JSON.stringify({ api_key: FAKE }));
    assert.equal(s.view().brain.keys.genspark, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(redact(`HTTP 401 Bearer ${FAKE}`), "HTTP 401 Bearer ***");
  assert.equal(redact(`key=${FAKE} 그리고 ${FAKE}`).includes(FAKE), false);
  assert.equal(loadConfig({ CY_AGENT_BRAIN: FAKE }).brain.provider, "local"); // 오타 자리의 키도 글에 남기지 않는다
  assert.ok(!loadConfig({ CY_AGENT_BRAIN: FAKE }).configNotes?.join(" ").includes(FAKE));
});
