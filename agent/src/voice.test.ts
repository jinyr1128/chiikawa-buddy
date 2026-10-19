import test from "node:test";
import assert from "node:assert/strict";
import { EMOTION_TAGS, MOODS, SERIOUS_KINDS, TONE, VOICE_EVERY, seedHash, stretch, voice } from "./voice.ts";
import { SYSTEM } from "./brain.ts";

const seeds = (n: number, prefix = "b") => Array.from({ length: n }, (_, i) => `${prefix}:${i}:2026-10-10`);

test("voice: 진지한 말(오류·머지·결재·회의 알림·진행 보고)에는 절대 양념을 치지 않는다", () => {
  for (const kind of SERIOUS_KINDS) {
    for (const seed of seeds(400, kind)) assert.equal(voice("머지했어요 🎉", seed, { kind: kind as any }), "머지했어요 🎉", `${kind} ${seed}`);
  }
});

test("voice: 네 번에 한 번 정도만 — 빈도 상한", () => {
  const all = seeds(4000);
  const changed = all.filter((s) => voice("오늘 할 일 다 끝냈어요!", s) !== "오늘 할 일 다 끝냈어요!").length;
  const rate = changed / all.length;
  assert.ok(rate > 0.15 && rate <= 0.3, `rate ${rate}`);
  assert.equal(VOICE_EVERY, 4);
});

test("voice: 같은 seed면 늘 같은 결과, 바뀐 말은 '~요' 늘이기 아니면 데모 감정 표시 하나", () => {
  let tilde = 0, tagged = 0;
  for (const s of seeds(800)) {
    const a = voice("새 할 일이 생겼어요", s, { mood: "excited" });
    assert.equal(a, voice("새 할 일이 생겼어요", s, { mood: "excited" }));
    if (a === "새 할 일이 생겼어요") continue;
    if (a === "새 할 일이 생겼어~요") tilde++;
    else {
      const tag = a.slice("새 할 일이 생겼어요 ".length);
      assert.ok((MOODS.excited as readonly string[]).includes(tag), a);
      tagged++;
    }
  }
  assert.ok(tilde > 0 && tagged > 0, `tilde ${tilde} tagged ${tagged}`);
});

test("voice: 이미 양념이 있으면 더 붙이지 않는다", () => {
  for (const s of seeds(200)) {
    assert.equal(voice("머지했어요 🎉 (스이시~사)", s), "머지했어요 🎉 (스이시~사)");
    assert.equal(voice("회의가 3개에~요", s), "회의가 3개에~요");
  }
});

test("stretch: 마지막 '…어요/에요'의 요 앞에 ~", () => {
  assert.equal(stretch("14시–15시가 비어 있어요"), "14시–15시가 비어 있어~요");
  assert.equal(stretch("오늘은 회의가 3개예요. 좋아요"), "오늘은 회의가 3개예~요. 좋아요");
  assert.equal(stretch("테스트 돌리는 중이에요 🧪"), "테스트 돌리는 중이에~요 🧪");
  assert.equal(stretch("좋아요"), null);
  assert.equal(stretch("있어~요"), null);
});

test("감정 표시는 데모와 같은 '(…시사)' 꼴, seedHash는 32비트", () => {
  for (const t of EMOTION_TAGS) assert.match(t, /^\((.+ 시사|스이시~사)\)$/);
  assert.ok(seedHash("x") >= 0 && seedHash("x") < 2 ** 32);
});

test("모델 페르소나: 존댓말 + 가끔 양념, 진지한 내용 예외(반말 지시 없음)", () => {
  assert.ok(SYSTEM.includes(TONE));
  assert.match(TONE, /존댓말로 짧고 다정하게/);
  assert.match(TONE, /오류·머지·결재/);
  assert.doesNotMatch(SYSTEM, /반말/);
});
