import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTER_LINES } from '../src/character-lines.js';
import { CANNED, cannedReply, resetCanned } from '../src/canned.js';
import { sayFor } from '../src/ai-onboard.js';
import { tourSteps } from '../src/tour.js';
import { localSay } from '../src/character.js';
import { personaFor, systemFor } from '../src/persona.js';
import { answerBubble } from '../src/quick-ask.js';
import { createMarkdown } from '../src/markdown.js';
import { Marked } from '../renderer/vendor/marked.js';

function intent(text) {
  assert.match(text, /^(?:우나(?: 야하)?|야하!|푸루루루루루루루|이야하~!!!|우라라 야하\.|하아~~\?)\(/u, text);
  let depth = 0;
  for (let i = text.indexOf('('); i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    assert.ok(depth > 0 || i === text.length - 1, text);
  }
  assert.equal(depth, 0, text);
}

test('우사기: 정해진 답의 모든 시간대·할 일 상태에서 뜻을 괄호에 넣고 두 줄 춤 외침은 유지한다', () => {
  for (const hour of [9, 15, 19, 23]) for (const [open, done] of [[0, 0], [3, 0], [2, 1], [0, 3]]) {
    resetCanned();
    for (const { id } of CANNED) for (let i = 0; i < 5; i++) {
      const text = cannedReply(id, { open, done, next: '보고서', hour }, { character: 'usagi' });
      if (id === 'dance') assert.equal(text, CHARACTER_LINES.usagi.phrases.dance[0]);
      else intent(text);
    }
  }
  assert.equal(cannedReply('who', {}, { character: 'usagi', override: { who: ['내 인사'] } }), '내 인사');
});

test('우사기: 설치·오버레이와 조합한 둘러보기 문구의 괄호가 유지된다', () => {
  for (const text of [...Object.values(sayFor('usagi')), ...Object.values(localSay('usagi'))]) intent(text);
  for (const ready of [true, false]) for (const connected of [[], ['slack'], ['calendar'], ['calendar', 'slack']]) {
    for (const { text } of tourSteps({ ready, connected }, 'usagi')) {
      intent(text);
      assert.doesNotMatch(text, /\{(?:cal|slack_on|slack_off)\}/);
    }
  }
});

test('우사기: 모든 AI 연결에 같은 외침·괄호 지시를 주고 사용자 말투는 그대로 쓴다', () => {
  for (const provider of ['gemini', 'claude', 'openai', 'claudecode', 'codexcli']) {
    const text = personaFor(provider, 'usagi');
    assert.match(text, /괄호 밖에는/);
    assert.match(text, /하아~~\?\(어느 할 일을 말하는 거야\?\)/);
    assert.match(text, /대사 필드에만/);
    assert.ok(systemFor(provider, '내 말투', 'usagi').startsWith('내 말투'));
  }
});

test('우사기 춤: 정해진 답·머리 위 말풍선·채팅 마크다운 모두 요청한 줄바꿈을 보존한다', () => {
  const expected = '이-야~ 야하 야하!\n우-라 푸루푸루푸루!! 우라~!';
  const text = cannedReply('dance', {}, { character: 'usagi' });
  assert.equal(text, expected);
  assert.equal(answerBubble('dance', { ok: true, data: { answer: { text, kind: 'done' } } }).text, expected);
  assert.match(createMarkdown(Marked)(text), /이-야~ 야하 야하!<br>\s*우-라 푸루푸루푸루!! 우라~!/u);
});
