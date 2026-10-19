import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from '../renderer/vendor/marked.js';
import { createMarkdown } from '../src/markdown.js';
import { looksMarkdown, bubbleMd, isListBubble, keepClasses, BUBBLE_PURIFY } from '../src/bubbles.js';

const md = createMarkdown(Marked);
const render = (s) => md(bubbleMd(s));

test('말풍선 마크다운 감지: 목록·표·굵게·코드·색·형광펜은 마크다운, 평범한 문장은 아님', () => {
  for (const s of ['- a\n- b', '1. 하나', '**굵게** 말', '`npm test` 통과', ':red[마감]', '==거의 끝==', '| a | b |\n|---|---|', '• [P1] 옛 글머리']) assert.ok(looksMarkdown(s), s);
  for (const s of ['오늘 할 일이 많네요… 급한 것만 8개예요.', '회의 10분 전이에요! 〈디자인 싱크〉 15:00', '머지했어요 🎉', '', null]) assert.equal(looksMarkdown(s), false, String(s));
});

test('글머리표 목록: 한 줄에 하나, 굵게·설명 줄바꿈', () => {
  const h = render('- **[P1]** 하늘님 답장 · slack\n  결제 화면 재현 방법\n- **[P2]** QA 정리 · slack');
  assert.equal((h.match(/<li>/g) ?? []).length, 2);
  assert.match(h, /<strong>\[P1\]<\/strong> 하늘님 답장 · slack<br>결제 화면 재현 방법/);
});

test('예전 데몬의 "• " 글머리도 목록으로, 제목은 굵은 줄로', () => {
  const h = render('• [P1] 하나 (slack)\n• [P2] 둘 (mail)');
  assert.equal((h.match(/<li>/g) ?? []).length, 2);
  assert.match(render('## 지금 챙길 것'), /<strong>지금 챙길 것<\/strong>/);
  assert.doesNotMatch(render('## 지금 챙길 것'), /<h2>/);
});

test('표·색·형광펜·인라인 코드', () => {
  const h = render('| | 할 일 | 출처 |\n|---|---|---|\n| **P1** | OKR | mail |');
  assert.match(h, /<table>/);
  assert.match(h, /<td><strong>P1<\/strong><\/td>/);
  assert.match(render(':red[오늘 마감] ==거의 끝== `NOTE-142`'), /<span class="c-red">오늘 마감<\/span> <mark>거의 끝<\/mark> <code>NOTE-142<\/code>/);
});

test('위험한 것: 원시 HTML 은 글자로, javascript: 링크는 글자만, 이미지는 글자로', () => {
  const raw = render('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(raw, /<script|<img/);
  assert.match(raw, /&lt;script&gt;/);
  const h = render('- [나쁜](javascript:alert(1)) [좋은](https://example.com) ![그림](https://x/y.png)');
  assert.doesNotMatch(h, /href="javascript|<img/);
  assert.match(h, /<a href="https:\/\/example.com">좋은<\/a>/);
  assert.equal(BUBBLE_PURIFY.ALLOWED_URI_REGEXP.test('javascript:alert(1)'), false);
  assert.equal(BUBBLE_PURIFY.ALLOWED_URI_REGEXP.test('slack://channel?id=C1'), true);
  assert.ok(BUBBLE_PURIFY.FORBID_TAGS.includes('img') && BUBBLE_PURIFY.FORBID_ATTR.includes('style'));
});

test('넓은 목록 말풍선: 목록 2줄 이상 또는 표', () => {
  assert.equal(isListBubble({ text: '새 할 일 2개', detail: '- a\n- b' }), true);
  assert.equal(isListBubble({ text: '새 할 일', detail: '- a' }), false);
  assert.equal(isListBubble({ text: 'x', detail: '| a | b |\n|---|---|\n| 1 | 2 |' }), true);
  assert.equal(isListBubble({ text: '머지했어요 🎉' }), false);
  assert.equal(isListBubble({ text: 'x', detail: '• 하나\n• 둘' }), true);
});

test('class 는 색 글자·콜아웃만 남김', () => {
  assert.equal(keepClasses('c-red evil'), 'c-red');
  assert.equal(keepClasses('callout callout-warning'), 'callout callout-warning');
  assert.equal(keepClasses('x y'), '');
});
