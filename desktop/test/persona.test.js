import test from 'node:test';
import assert from 'node:assert/strict';
import { SISA_BASE, PROVIDER_STYLE, personaFor, systemFor, isStockPersona } from '../src/persona.js';

const PROVIDERS = ['gemini', 'claude', 'openai', 'claudecode', 'codexcli'];

test('PROVIDER_STYLE 은 다섯 AI 모두 갖고 있다', () => {
  assert.deepEqual(Object.keys(PROVIDER_STYLE).sort(), [...PROVIDERS].sort());
});

test('모든 provider 의 personaFor 는 공통 문구와 AI별 문구를 함께 담는다', () => {
  for (const p of PROVIDERS) {
    const text = personaFor(p);
    assert.ok(text.length > 0);
    assert.ok(text.includes(SISA_BASE), p);
    assert.ok(text.includes(PROVIDER_STYLE[p]), p);
  }
});

test('공통 규칙: 시사·해요체·한두 문장·스이시 양념', () => {
  assert.match(SISA_BASE, /시사/);
  assert.match(SISA_BASE, /해요체/);
  assert.match(SISA_BASE, /한두 문장/);
  assert.match(SISA_BASE, /지어내지/);
  assert.match(SISA_BASE, /스이시~사/);
  assert.match(SISA_BASE, /있어~요/);
  assert.match(SISA_BASE, /기쁜 시사/);
  for (const p of PROVIDERS) {
    const t = personaFor(p);
    assert.match(t, /시사/);
    assert.match(t, /스이시~사/);
  }
});

test('AI별 문구는 서로 다르고, 코딩 에이전트형은 코딩 에이전트가 아니라고 강조한다', () => {
  assert.equal(new Set(PROVIDERS.map((p) => PROVIDER_STYLE[p])).size, PROVIDERS.length);
  for (const p of ['claudecode', 'codexcli']) assert.match(PROVIDER_STYLE[p], /코딩 에이전트가 아니다/);
  assert.match(PROVIDER_STYLE.gemini, /이모지/);
  assert.match(PROVIDER_STYLE.openai, /목록/);
  assert.match(PROVIDER_STYLE.claude, /목록/);
});

test('알 수 없는 provider 는 공통 설정만 쓴다', () => {
  for (const p of ['', 'none', 'toString', '__proto__', undefined, null]) {
    assert.equal(personaFor(p), SISA_BASE);
    assert.equal(systemFor(p, ''), SISA_BASE);
  }
  assert.equal(systemFor('nope', '나만의 말투'), '나만의 말투');
});

test('systemFor: custom 이 없으면 personaFor 와 같다', () => {
  for (const p of PROVIDERS) {
    assert.equal(systemFor(p, ''), personaFor(p));
    assert.equal(systemFor(p, '   '), personaFor(p));
    assert.equal(systemFor(p), personaFor(p));
  }
});

test('systemFor: custom 이 있어도 AI별 규칙은 항상 붙는다', () => {
  const custom = '너는 시사야. 아주 짧고 차분하게 말해요.';
  for (const p of PROVIDERS) {
    const t = systemFor(p, custom);
    assert.ok(t.startsWith(custom), p);
    assert.ok(t.endsWith(PROVIDER_STYLE[p]), p);
    assert.equal(t.includes(SISA_BASE), false, p);
  }
});

test('짧은 예전 기본 글은 기본값으로 본다', () => {
  assert.equal(isStockPersona(''), true);
  assert.equal(isStockPersona(SISA_BASE), true);
  assert.equal(isStockPersona(`너는 시사야. 사용자의 오늘 할 일을 함께 보는 작은 비서다.
오늘 할 일 현황은 대화 맨 앞에 따로 알려 준다. 거기 없는 일은 지어내지 않는다.
끝낸 일이 많으면 짧게 칭찬한다. 적으면 다그치지 않고, 남은 것 하나만 골라 응원한다.
말투는 다정한 해요체로, 한두 문장 안에서 쉬운 한국어로 말한다.
코드를 고치는 일은 하지 않는다.`), true);
  assert.equal(isStockPersona('나만의 말투'), false);
});

test('길이 상한과 키 같은 문자열 없음', () => {
  for (const p of PROVIDERS) {
    const t = personaFor(p);
    assert.ok(t.length <= 1400, `${p} ${t.length}`);
    assert.equal(/AIza|sk-|xox[a-z]-|Bearer|api[_-]?key/i.test(t), false, p);
  }
});
