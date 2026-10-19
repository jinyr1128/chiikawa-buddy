// AI를 안 붙였을 때 캐릭터가 하는 정해진 말(canned.js)의 캐릭터별 기본값. 시사는 canned.js 그대로.
// 글은 assets/characters/lines.json 의 canned(여기는 그 사본 character-lines.js 에서 꺼낸다). 키·자리표시는 canned.js 와 같다.
import { CHARACTER_LINES } from './character-lines.js';

export const CHARACTER_CANNED = Object.fromEntries(Object.entries(CHARACTER_LINES).map(([id, c]) => [id, c.canned ?? {}]));
