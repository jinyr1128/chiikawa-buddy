import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakerLines, SPEAKER_COLORS } from '../src/speakers.js';

test('주고받기 대사: 사람마다 한 줄·대표 색, 보통 대사는 그대로', () => {
  const l = speakerLines('모몽가: 뭐어?! 또 / 시킨 거야?! / 카니: 헤헤헤... (같이 하자) 외 1개');
  assert.deepEqual(l.map((x) => x.name), ['모몽가', '카니']);
  assert.equal(l[0].text, '뭐어?! 또 / 시킨 거야?!', '이름 앞이 아닌 / 는 나누지 않는다');
  assert.equal(l[1].color, SPEAKER_COLORS.카니);
  assert.equal(speakerLines('흥! 명령 실행 중이야. 비켜!'), null);
  assert.equal(speakerLines(undefined), null);
  assert.equal(Object.keys(SPEAKER_COLORS).length >= 8, true);
});
