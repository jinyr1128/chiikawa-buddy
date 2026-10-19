// OpenAI 키 확인: 제한 키(모델 목록 권한 없음)도 대화가 되면 통과, 크레딧·권한 오류는 따로 알린다. 진짜 키·네트워크 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkLlm, completeLlm, errorText, keyFetch, KEY_REQ, listModels, OPENAI_NO_CREDIT, OPENAI_NO_PERMISSION, OPENAI_NO_MODEL_LIST } from '../src/llm-check.js';
import { listErrorText } from '../renderer/models-view.js';
import { daemonArgs } from '../src/bundle.js';

const KEY = 'sk-unit-test-not-real';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const oaiErr = (message, code = null, type = 'invalid_request_error') => ({ error: { message, type, param: null, code } });
const PERM = oaiErr('You have insufficient permissions for this operation. Missing scopes: api.model.read.');

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

test('openai 키 확인: /models 403(제한 키) → 짧은 대화로 다시 보고, 되면 통과', async () => {
  const f = fake({
    'https://api.openai.com/v1/models': res(403, PERM),
    'https://api.openai.com/v1/chat/completions': res(200, { choices: [{ message: { content: 'h' } }] }),
  });
  assert.deepEqual(await checkLlm('openai', KEY, f), { ok: true });
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(f.calls[1].init.method, 'POST');
  assert.equal(body.model, 'gpt-4.1-mini', '데몬 기본 모델과 같다');
  assert.equal(body.max_completion_tokens, 1);
  assert.equal(f.calls[1].init.headers.Authorization, `Bearer ${KEY}`);
});

test('openai 키 확인: 권한 오류는 크레딧이 아니라 권한 안내, 크레딧은 insufficient_quota 만', async () => {
  const perm = await checkLlm('openai', KEY, fake({
    'https://api.openai.com/v1/models': res(403, PERM),
    'https://api.openai.com/v1/chat/completions': res(403, oaiErr('You have insufficient permissions for this operation. Missing scopes: model.request.')),
  }));
  assert.deepEqual(perm, { ok: false, error: OPENAI_NO_PERMISSION });
  assert.doesNotMatch(perm.error, /크레딧/);
  const quota = await checkLlm('openai', KEY, fake({ 'https://api.openai.com/v1/models': res(429, oaiErr('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota')) }));
  assert.deepEqual(quota, { ok: false, error: OPENAI_NO_CREDIT });
  // 제한 키인데 대화하려니 크레딧이 없음
  const quota2 = await checkLlm('openai', KEY, fake({
    'https://api.openai.com/v1/models': res(403, PERM),
    'https://api.openai.com/v1/chat/completions': res(429, oaiErr('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota')),
  }));
  assert.deepEqual(quota2, { ok: false, error: OPENAI_NO_CREDIT });
  // 틀린 키(401): JSON 대신 message, 대화로 다시 보내지 않는다, 키는 오류에 없다
  const f = fake({ 'https://api.openai.com/v1/models': res(401, oaiErr(`Incorrect API key provided: ${KEY}.`, 'invalid_api_key')) });
  const bad = await checkLlm('openai', KEY, f);
  assert.equal(bad.ok, false);
  assert.equal(f.calls.length, 1);
  assert.match(bad.error, /^Incorrect API key provided/);
  assert.equal(bad.error.includes(KEY), false);
  assert.equal(bad.error.includes('{'), false);
});

test('목록: OpenAI 권한 오류는 안내 문장, 오류 JSON 은 message 만 보인다', async () => {
  const perm = await listModels('openai', KEY, fake({ 'https://api.openai.com/v1/models': res(403, PERM) }));
  assert.deepEqual(perm, { ok: false, error: OPENAI_NO_MODEL_LIST });
  assert.equal(errorText(JSON.stringify(oaiErr('Bad gateway', null, 'server_error'))), 'Bad gateway (server_error)');
  assert.equal(errorText('plain text'), 'plain text');
  assert.equal(errorText(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } })), 'Resource has been exhausted (e.g. check quota). (RESOURCE_EXHAUSTED)', '제미나이 한도는 상태 이름이 남아야 크레딧으로 오해하지 않는다(panel keyFail)');
  assert.equal(listErrorText(JSON.stringify(oaiErr('Something broke'))), 'Something broke');
  assert.equal(listErrorText('HTTP 502'), 'HTTP 502');
  assert.equal(listErrorText(undefined), '');
});

test('daemonArgs: 윈도우·맥은 --use-system-ca(OS 인증서 저장소), 리눅스는 그대로', () => {
  assert.deepEqual(daemonArgs('main.ts', 'win32'), ['--use-system-ca', 'main.ts']);
  assert.deepEqual(daemonArgs('main.ts', 'darwin'), ['--use-system-ca', 'main.ts']);
  assert.deepEqual(daemonArgs('main.ts', 'linux'), ['main.ts']);
});

test('키를 싣는 요청은 모두 redirect:error·credentials:omit (OpenAI·Gemini·Anthropic)', async () => {
  const ok = { 'https://api.openai.com/v1/models': res(200, { data: [] }), 'https://api.openai.com/v1/chat/completions': res(200, { choices: [{ message: { content: 'h' } }] }), 'https://api.anthropic.com/v1/messages': res(200, { content: [{ text: 'h' }] }), 'https://api.anthropic.com/v1/models?limit=100': res(200, { data: [] }) };
  const f = async (url, init = {}) => {
    f.calls.push({ url, init });
    return ok[url] ?? res(200, { models: [], candidates: [{ content: { parts: [{ text: 'h' }] } }] });
  };
  f.calls = [];
  const msg = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
  for (const p of ['openai', 'gemini', 'claude']) {
    await checkLlm(p, KEY, f);
    await listModels(p, KEY, f);
    await completeLlm(p, KEY, { ...msg, model: p === 'gemini' ? 'gemini-x' : '' }, f);
  }
  // 제한 키 경로(/models 403 → 대화)도
  const r = fake({ 'https://api.openai.com/v1/models': res(403, PERM), 'https://api.openai.com/v1/chat/completions': res(200, {}) });
  await checkLlm('openai', KEY, r);
  assert.equal(r.calls.length, 2);
  assert.ok(f.calls.length >= 9);
  for (const c of [...f.calls, ...r.calls]) {
    assert.equal(c.init.redirect, 'error', c.url);
    assert.equal(c.init.credentials, 'omit', c.url);
  }
  assert.deepEqual(KEY_REQ, { redirect: 'error', credentials: 'omit' });
});

test('keyFetch: Node fetch 도 옵션을 받고, 리다이렉트는 따라가지 않는다(로컬 서버, 네트워크 없음)', async () => {
  let hits = 0;
  const srv = http.createServer((req, r) => {
    hits += 1;
    if (req.url === '/go') { r.writeHead(302, { location: '/elsewhere' }); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/plain' }); r.end('ok');
  });
  await new Promise((done) => srv.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const f = keyFetch(globalThis.fetch);
    assert.equal(await (await f(`${base}/plain`, { headers: { Authorization: `Bearer ${KEY}` } })).text(), 'ok');
    await assert.rejects(f(`${base}/go`, { headers: { Authorization: `Bearer ${KEY}` } }));
    assert.equal(hits, 2, '/elsewhere 로 키를 다시 보내지 않았다');
  } finally {
    srv.close();
  }
});
test('openai 키 확인: 모델 목록은 열려도 크레딧이 없으면(대화 429 insufficient_quota) 연결 실패로 알린다', async () => {
  const quota = oaiErr('You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota');
  const f = fake({
    'https://api.openai.com/v1/models': res(200, { data: [{ id: 'gpt-4.1-mini' }] }),
    'https://api.openai.com/v1/chat/completions': res(429, quota),
  });
  const r = await checkLlm('openai', KEY, f);
  assert.equal(r.ok, false);
  assert.equal(r.error, OPENAI_NO_CREDIT);
  assert.match(OPENAI_NO_CREDIT, /platform\.openai\.com\/settings\/organization\/billing/);
  assert.equal(f.calls.length, 2);
  // 크레딧이 있으면 통과, 잠깐 너무 잦음(rate_limit_exceeded)은 키 문제가 아니라 통과 + 안내
  assert.deepEqual(await checkLlm('openai', KEY, fake({ 'https://api.openai.com/v1/models': res(200, { data: [] }), 'https://api.openai.com/v1/chat/completions': res(200, { choices: [{ message: { content: '' } }] }) })), { ok: true });
  const rl = await checkLlm('openai', KEY, fake({ 'https://api.openai.com/v1/models': res(200, { data: [] }), 'https://api.openai.com/v1/chat/completions': res(429, oaiErr('Rate limit reached', 'rate_limit_exceeded', 'requests')) }));
  assert.equal(rl.ok, true);
  assert.match(rl.warn, /너무 잦았어요/);
});
