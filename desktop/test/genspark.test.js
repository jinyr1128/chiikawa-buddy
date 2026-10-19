// Genspark 연결 확인·모델 목록·gsk login 키·저장 모양. 실제 프록시 응답 본문을 그대로 쓴 가짜 fetch(키는 가짜)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLlm, listModels, gskLoginKey, KEY_REQ, GENSPARK_URL, GENSPARK_NO_CREDIT, GENSPARK_BAD_KEY, pickGensparkModel } from '../src/llm-check.js';
import { normalizeSisa, connectedProviders, withKey, withGsk, withoutProvider, daemonBrainPatch, settingsBrainBody, withDaemonBrain, KEY_PROVIDERS } from '../src/sisa-store.js';
import { disconnectBrainBody, withBrainBody, brainRows, brainDisconnectCopy } from '../src/disconnect.js';
import { phaseAfterBrain } from '../src/setup-plan.js';
import { BRAIN_CHOICES, providerById } from '../src/ai-onboard.js';

const KEY = 'gsk-unit-test-fake-key-0123456789abcdefghijklmnopqrstuvwxyz';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const MODELS = { object: 'list', data: ['gpt-5.4-mini', 'claude-haiku-5-5', 'claude-sonnet-5-5'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })) };
const FREE = "Free-plan credits can't be used with the Genspark API / LLM proxy. Please visit https://www.genspark.ai/pricing?fromurl=credit_exhausted&entry=llm_proxy to subscribe.";
const chat = (content) => ({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function fake(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const r = routes[url];
    return typeof r === 'function' ? r(init) : r;
  };
  f.calls = calls;
  return f;
}

test('genspark 확인: 목록(무료 OK) + 아주 짧은 대화, 무료 안내문이면 연결은 하고 크레딧이 필요하다고 알린다', async () => {
  const f = fake({ [`${GENSPARK_URL}/models`]: res(200, MODELS), [`${GENSPARK_URL}/chat/completions`]: res(200, chat(FREE)) });
  assert.deepEqual(await checkLlm('genspark', KEY, f), { ok: true, warn: GENSPARK_NO_CREDIT });
  assert.match(GENSPARK_NO_CREDIT, /크레딧이 필요해요.*https:\/\/www\.genspark\.ai\/pricing/);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(c.init.redirect, KEY_REQ.redirect); // 리다이렉트 안 따라감
    assert.equal(c.init.credentials, 'omit');
  }
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.model, 'claude-sonnet-5-5'); // 목록에서 고른 모델
  assert.equal(body.max_tokens, 1);
  // 결제한 키: 그냥 통과
  const paid = fake({ [`${GENSPARK_URL}/models`]: res(200, MODELS), [`${GENSPARK_URL}/chat/completions`]: res(200, chat('h')) });
  assert.deepEqual(await checkLlm('genspark', KEY, paid), { ok: true });
});

test('genspark 확인: 401 → gsk login 다시, 400 모델 → 못 써요, 422·5xx 는 짧은 말, 키는 글에 안 나간다', async () => {
  const bad = fake({ [`${GENSPARK_URL}/models`]: res(401, { detail: 'Missing authorization header' }) });
  assert.deepEqual(await checkLlm('genspark', KEY, bad), { ok: false, error: GENSPARK_BAD_KEY });
  const model = fake({ [`${GENSPARK_URL}/models`]: res(200, MODELS), [`${GENSPARK_URL}/chat/completions`]: res(400, { detail: "Model 'no-such-model-x' is not allowed. See GET /v1/models for the available models." }) });
  assert.deepEqual(await checkLlm('genspark', KEY, model), { ok: false, error: '그 모델은 Genspark 에서 못 써요.' });
  const shape = fake({ [`${GENSPARK_URL}/models`]: res(200, MODELS), [`${GENSPARK_URL}/chat/completions`]: res(422, { status: -2, message: 'Request parameter validation failed', errors: [{ type: 'missing', loc: ['body', 'messages'], msg: 'Field required' }], data: {} }) });
  assert.deepEqual(await checkLlm('genspark', KEY, shape), { ok: false, error: 'Genspark 가 요청 형식을 받지 않았어요.' });
  const busy = fake({ [`${GENSPARK_URL}/models`]: res(503, 'busy') });
  assert.match((await checkLlm('genspark', KEY, busy)).error, /지금 답하지 못했어요/);
  const down = async () => { throw new Error(`fetch failed for ${KEY}`); };
  const r = await checkLlm('genspark', KEY, down);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(KEY));
});

test('genspark 모델 목록: 프록시 목록 그대로(자르지 않는다), 기본은 목록에서', async () => {
  const many = { object: 'list', data: Array.from({ length: 73 }, (_, i) => ({ id: `m-${i}` })) };
  const f = fake({ [`${GENSPARK_URL}/models`]: res(200, many) });
  const r = await listModels('genspark', KEY, f);
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 73);
  assert.deepEqual(r.models[0], { id: 'm-0', label: '' });
  assert.deepEqual(await listModels('genspark', KEY, fake({ [`${GENSPARK_URL}/models`]: res(401, { detail: 'x' }) })), { ok: false, error: GENSPARK_BAD_KEY });
  assert.equal(pickGensparkModel(['kimi-k3', 'gpt-5.4-mini']), 'gpt-5.4-mini');
  assert.equal(pickGensparkModel(['kimi-k3']), 'kimi-k3');
  assert.equal(pickGensparkModel([]), '');
});

test('gsk login 키: ~/.genspark-tool-cli/config.json 의 api_key 를 읽기만 한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsk-desk-'));
  try {
    assert.equal(gskLoginKey(home), '');
    fs.mkdirSync(path.join(home, '.genspark-tool-cli'));
    const file = path.join(home, '.genspark-tool-cli', 'config.json');
    const raw = JSON.stringify({ api_key: KEY, base_url: 'https://www.genspark.ai' });
    fs.writeFileSync(file, raw);
    assert.equal(gskLoginKey(home), KEY);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    fs.writeFileSync(file, '\uFEFF' + raw); // 메모장 등이 붙인 BOM
    assert.equal(gskLoginKey(home), KEY);
    fs.writeFileSync(file, '{broken');
    assert.equal(gskLoginKey(home), '');
    fs.writeFileSync(file, JSON.stringify({ api_key: 'sk-not-genspark' }));
    assert.equal(gskLoginKey(home), '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('저장 모양: 「gsk login 한 키 쓰기」는 키를 저장하지 않고, 데몬 설정의 키도 지운다', () => {
  assert.ok(KEY_PROVIDERS.includes('genspark'));
  assert.equal(phaseAfterBrain('genspark'), 'ai-key');
  assert.ok(BRAIN_CHOICES.some((c) => c.id === 'genspark'));
  assert.equal(providerById('genspark').url, 'https://www.genspark.ai');
  assert.equal(providerById('genspark').pricing, 'https://www.genspark.ai/pricing');
  // 붙여 넣은 키
  const pasted = withKey({}, 'genspark', KEY);
  assert.deepEqual(connectedProviders(pasted), ['genspark']);
  assert.deepEqual(settingsBrainBody(daemonBrainPatch(pasted)), { brain: { provider: 'genspark', keys: { genspark: KEY }, model: null } });
  // gsk login 키: 붙인 키는 지우고, 데몬엔 keys.genspark: null(데몬이 파일을 읽는다)
  const gsk = withGsk(pasted);
  assert.equal(gsk.keys.genspark, undefined);
  assert.equal(normalizeSisa(gsk).gsk, true);
  assert.deepEqual(connectedProviders(gsk), ['genspark']);
  assert.ok(!JSON.stringify(gsk).includes(KEY));
  assert.deepEqual(settingsBrainBody(daemonBrainPatch(gsk)), { brain: { provider: 'genspark', keys: { genspark: null }, model: null } });
  const file = withDaemonBrain({ brain: { provider: 'gemini', geminiApiKey: 'AIza-keep', gensparkApiKey: KEY } }, daemonBrainPatch(gsk));
  assert.deepEqual(file.brain, { provider: 'genspark', geminiApiKey: 'AIza-keep' });
  // 연결 해제: gsk 표시도 뗀다
  const off = withoutProvider(gsk, 'genspark');
  assert.deepEqual(connectedProviders(off), []);
  assert.equal(off.provider, 'none');
  assert.deepEqual(disconnectBrainBody('genspark', 'genspark'), { brain: { provider: 'local', keys: { genspark: null } } });
  assert.deepEqual(withBrainBody({ brain: { provider: 'genspark', gensparkApiKey: KEY } }, { brain: { provider: 'local', keys: { genspark: null } } }).brain, { provider: 'local' });
  assert.match(brainDisconnectCopy('genspark', false).note, /gsk login 키 파일은 그대로/);
  // 설정 창: 데몬이 keys.genspark true 면 연결된 AI 줄
  assert.deepEqual(brainRows({ connected: [] }, { provider: 'genspark', keys: { genspark: true } }).map((r) => [r.id, r.active]), [['genspark', true]]);
});
