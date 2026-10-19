// 한국어 조사 고르기: 앞 낱말의 마지막 글자 받침으로 이/가, 은/는, 을/를, (이)야, (으)로 … 를 고른다.
// 문구 안에서는 자리표시 바로 뒤에 「{task}(이)야」「{task}은(는)」「{task}을(를)」「{task}(으)로」처럼 쓴다(phrases.ts fillVars).
// 영어·숫자로 끝나면 읽는 소리로 본다: 숫자는 「일·삼·육·칠·팔·영」만 받침, 영어는 l·m·n·r(엘·엠·엔·알)만 받침 — 「main.js」→ 받침 없음.

const DIGIT_JONG = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0]; // 영 일 이 삼 사 오 육 칠 팔 구
const LETTER_JONG: Record<string, number> = { l: 8, m: 16, n: 4, r: 8 };

// 마지막 글자의 받침 번호(0 = 없음, 8 = ㄹ). 끝의 괄호·따옴표·말줄임표 같은 건 건너뛴다
export function jong(word: string): number {
  const chars = [...word];
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28;
    if (ch >= "0" && ch <= "9") return DIGIT_JONG[c - 48];
    if (/[a-z]/i.test(ch)) return LETTER_JONG[ch.toLowerCase()] ?? 0;
    if (/[\p{L}\p{N}]/u.test(ch)) return 0; // 자모·한자·다른 글자: 받침 없음으로
  }
  return 0;
}
export const hasBatchim = (word: string): boolean => jong(word) !== 0;

// 표기 → [받침 있을 때, 없을 때]. (으)로는 ㄹ 받침이면 「로」
const PAIRS: Record<string, readonly [string, string]> = {
  "은(는)": ["은", "는"], "는(은)": ["은", "는"], "(은)는": ["은", "는"],
  "을(를)": ["을", "를"], "를(을)": ["을", "를"], "(을)를": ["을", "를"],
  "이(가)": ["이", "가"], "가(이)": ["이", "가"], "(이)가": ["이", "가"],
  "과(와)": ["과", "와"], "와(과)": ["과", "와"], "(과)와": ["과", "와"],
  "(이)": ["이", ""], "(으)": ["으", ""],
};
// 자리표시 바로 뒤에 올 수 있는 표기(긴 것 먼저 — 「(이)가」가 「(이)」보다 먼저)
export const JOSA_MARK = /^(?:은\(는\)|는\(은\)|\(은\)는|을\(를\)|를\(을\)|\(을\)를|이\(가\)|가\(이\)|\(이\)가|과\(와\)|와\(과\)|\(과\)와|\(이\)|\(으\))/;

// 낱말 + 표기 → 알맞은 조사(표기만 돌려준다). 모르는 표기는 그대로
export function josa(word: string, mark: string): string {
  const pair = PAIRS[mark];
  if (!pair) return mark;
  const j = jong(word);
  if (mark === "(으)") return j !== 0 && j !== 8 ? "으" : "";
  return j !== 0 ? pair[0] : pair[1];
}
