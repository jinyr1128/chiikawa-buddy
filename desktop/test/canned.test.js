import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANNED, CANNED_CATALOG, cannedReply, cannedPool, fillCanned, plainTitle, resetCanned, sanitizeCanned } from '../src/canned.js';

const seeded = (seed = 7) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

const CASES = [
  { open: 0, done: 0 },
  { open: 3, done: 0, next: '빨래 널기' },
  { open: 2, done: 2, next: '보고서' },
  { open: 0, done: 4 },
];

test('모든 버튼이 어떤 상황에서도 말을 한다', () => {
  for (const c of CANNED) {
    for (const ctx of CASES) {
      resetCanned();
      const t = cannedReply(c.id, { ...ctx, hour: 9 }, { rng: seeded() });
      assert.equal(typeof t, 'string', c.id);
      assert.ok(t.length > 4, c.id);
      assert.doesNotMatch(t, /undefined|NaN|null|\(는\)|\(를\)/, `${c.id}: ${t}`);
    }
  }
});

test('모든 문장을 하나도 빼지 않고 훑어 본다', () => {
  const sample = { open: 2, done: 1, total: 3, next: '빨래' };
  assert.equal(new Set(CANNED_CATALOG.map((g) => g.button)).size, CANNED.length);
  for (const g of CANNED_CATALOG) {
    g.lines.forEach((line, i) => {
      const t = fillCanned(line, sample);
      assert.doesNotMatch(t, /undefined|NaN|null|\(는\)|\(를\)|\{|\}/, `${g.key}#${i}: ${t}`);
      assert.match(t, /\n/, `${g.key}#${i}: 줄바꿈 없음`);
      assert.match(t, /\*\*[^*\n]+\*\*/, `${g.key}#${i}: 굵게 없음`);
      assert.ok(t.split('\n').every((l) => l.length <= 60), `${g.key}#${i}: 한 줄이 너무 김 ${t}`);
    });
  }
});

test('말은 줄을 바꾸고 굵은 글씨가 있다', () => {
  for (const c of CANNED) {
    resetCanned();
    const t = cannedReply(c.id, { open: 2, done: 1, next: '빨래', hour: 14 }, { rng: seeded() });
    assert.match(t, /\n/, `${c.id}: 줄바꿈`);
    assert.match(t, /\*\*[^*\n]+\*\*/, `${c.id}: 굵게`);
  }
});

test('버튼마다 말이 여러 개이고, 같은 말이 연달아 나오지 않는다', () => {
  for (const kind of ['tired', 'done', 'rest', 'cheer', 'who', 'what', 'where', 'ai']) {
    const { pool } = cannedPool(kind, { open: 0, done: 0, next: '', period: 'day' });
    assert.ok(pool.length >= 3, `${kind}: 말이 적다`);
  }
  resetCanned();
  const rng = seeded(3);
  const seen = [];
  for (let i = 0; i < 30; i += 1) seen.push(cannedReply('tired', {}, { rng }));
  for (let i = 1; i < seen.length; i += 1) assert.notEqual(seen[i], seen[i - 1], `${i}번째가 앞과 같다`);
  assert.equal(new Set(seen).size, 6, '한 바퀴 돌 때까지 다른 말을 쓴다');
  // 한 바퀴(6번) 안에서는 겹치지 않는다
  assert.equal(new Set(seen.slice(0, 6)).size, 6);
});

test('할 일이 있으면 그 제목이 들어간다', () => {
  resetCanned();
  const t = cannedReply('next', { open: 2, done: 0, next: '빨래 널기' }, { rng: seeded() });
  assert.match(t, /빨래 널기/);
  const today = cannedReply('today', { open: 2, done: 3, next: '빨래 널기' }, { rng: seeded(11) });
  assert.match(today, /5개|3개/);
});

test('제목에 마크다운 기호가 있어도 모양이 깨지지 않는다', () => {
  assert.equal(plainTitle('**굵게** [링크](http://x) `코드`'), '굵게 링크http://x 코드');
  assert.ok(plainTitle('가'.repeat(80)).length <= 30);
  resetCanned();
  const t = cannedReply('next', { open: 1, done: 0, next: '**나쁜** 제목_' }, { rng: seeded() });
  assert.doesNotMatch(t.replace(/\*\*([^*\n]+)\*\*/g, ''), /\*/);
});

test('인사는 시간대에 맞는다', () => {
  resetCanned();
  assert.match(cannedReply('hello', { hour: 8 }, { rng: seeded() }), /아침|굿모닝|시사/);
  resetCanned();
  assert.match(cannedReply('hello', { hour: 23 }, { rng: seeded() }), /늦은|밤|시사|안녕|무리/);
});

test('끝냈다고 하는데 남은 일이 있으면 숨기지 않는다', () => {
  const texts = new Set();
  for (let i = 0; i < 40; i += 1) texts.add(cannedReply('done', { open: 2, done: 1 }, { rng: seeded(i + 1) }));
  assert.ok([...texts].some((t) => /2개/.test(t)));
});

test('저장한 말로 바꿔 쓴다', () => {
  resetCanned();
  const t = cannedReply('tired', {}, { rng: seeded(), override: { tired: ['안녕 **시사**예요.\n오늘은 쉬어요.'] } });
  assert.equal(t, '안녕 **시사**예요.\n오늘은 쉬어요.');
});

test('sanitizeCanned: 아는 칸만, 빈 줄은 빼고, 긴 줄·많은 줄은 그대로(글자 수·줄 수 제한 없음)', () => {
  assert.deepEqual(sanitizeCanned({ tired: ['  a  ', '', 'x'.repeat(5000), 3], nope: ['x'] }), { tired: ['a', 'x'.repeat(5000)] });
  assert.equal(sanitizeCanned({ tired: Array.from({ length: 40 }, (_, i) => `줄${i}`) }).tired.length, 40);
  assert.deepEqual(sanitizeCanned(null), {});
});
