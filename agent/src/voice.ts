// 캐릭터 말투 양념: 존댓말 말풍선에 가끔(네 번에 한 번 정도) 말끝 늘이기("있어~요")나 감정 표시("(기쁜 시사)")를 붙인다.
// 같은 seed(말풍선 id·날짜)면 늘 같은 결과라 테스트가 흔들리지 않는다.
// 오류·머지·결재·회의 알림·진행 보고처럼 진지한 말에는 절대 붙이지 않는다.

// 다른 캐릭터(characters.ts)는 말끝 늘이기 대신 앞에 감탄사("우와, ")를 붙이거나 뒤에 제 감정 표시를 붙인다.
import { CHARACTERS, character, type Mood } from "./characters.ts";
export type { Mood };

// 모델 프롬프트에 넣는 시사 말투 한 줄(brain SYSTEM 이 쓰고, 다른 캐릭터면 characters.ts withCharacter 가 바꾼다)
export const TONE = CHARACTERS.shisa.tone;
// 지금 캐릭터의 말투 한 줄(그때그때 만드는 프롬프트용 — 머지 추가질문 등)
export const tone = (): string => character().tone;

// 데모(desktop/scripts/demo-*.mjs)에서 쓰는 시사 감정 표시를 기분별로 묶었다
export const MOODS = CHARACTERS.shisa.tail as Record<Mood, readonly string[]>;
export const EMOTION_TAGS: readonly string[] = [...new Set(Object.values(MOODS).flat())];

// 양념을 치지 않는 말: 오류·머지·결재(제안 승인/보류)·회의 알림·진행 보고
export const SERIOUS_KINDS: ReadonlySet<string> = new Set(["error", "merge", "approval", "meeting", "progress"]);
export type VoiceKind = "error" | "merge" | "approval" | "meeting" | "progress" | "info" | "todo" | "done";

export const VOICE_EVERY = 4; // 네 번에 한 번

// FNV-1a 32bit — 짧은 문자열에 고르게 퍼진다
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 마지막 "…어요/에요/해요/게요…"의 요 앞에 ~ 를 넣는다("있어요" → "있어~요"). 늘일 곳이 없으면 null
export function stretch(text: string): string | null {
  if (/~요/.test(text)) return null;
  const re = /([어에예여해워와돼래게네])요/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  const at = last.index + last[1].length;
  return `${text.slice(0, at)}~${text.slice(at)}`;
}

const hasFlair = (text: string) => {
  if (/~요|시사\)|스이시/.test(text)) return true;
  const c = character();
  return Object.values(c.lead ?? {}).flat().some((x) => text.startsWith(x.trim())) || Object.values(c.tail ?? {}).flat().some((x) => text.includes(x));
};

// 고정 말풍선에 가끔 양념. seed 는 말풍선 id + 날짜처럼 그 말풍선마다 정해진 값
export function voice(text: string, seed: string, opts: { kind?: VoiceKind; mood?: Mood } = {}): string {
  if (opts.kind && SERIOUS_KINDS.has(opts.kind)) return text;
  if (hasFlair(text)) return text;
  const h = seedHash(seed);
  if (h % VOICE_EVERY !== 0) return text;
  const c = character();
  const mood = opts.mood ?? "happy";
  if (c.stretch && (h >>> 8) % 2 === 0) {
    const s = stretch(text);
    if (s) return s;
  }
  // 뒤 감정 표시와 앞 감탄사가 둘 다 있으면 반씩
  const tails = c.tail?.[mood], leads = c.lead?.[mood];
  if (tails?.length && (!leads?.length || (h >>> 12) % 2 === 0)) return `${text} ${tails[(h >>> 16) % tails.length]}`;
  if (leads?.length) return `${leads[(h >>> 16) % leads.length]}${text}`;
  return text;
}
