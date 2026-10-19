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

test('캐릭터 대표 색: 이름 > 기본 캐릭터 id > 이름 속 캐릭터 > 바탕(from)', async () => {
  const { characterColor, SPEAKER_COLORS: C } = await import('../src/speakers.js');
  assert.equal(characterColor({ id: 'u-1', name: '우사기' }), C.우사기);
  assert.equal(characterColor({ id: 'hachi' }), C.하치와레);
  assert.equal(characterColor({ id: 'u-2', name: '카니와 모몽가' }), C.카니);
  assert.equal(characterColor({ id: 'u-3', name: '세이렌', from: 'hachi' }), C.하치와레);
  assert.equal(characterColor({ id: 'u-4', name: '아노코', from: 'kani' }), C.카니);
  assert.equal(characterColor({ id: 'u-5', name: '새 캐릭터' }), null);
});
