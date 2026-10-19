import { test } from "node:test";
import assert from "node:assert/strict";
import { PHRASES, phrase, phraseVoice, setPhrases, customPhrase, unknownVars, fillVars, phraseLines, phraseDef } from "./phrases.ts";
import { validatePhrases } from "./settings.ts";
import { voice } from "./voice.ts";
import { Reactions } from "./reactions.ts";
import { alertText } from "./calendar-sync.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("문구 목록: 키는 하나씩, 기본값의 자리표시는 그 문구가 받는 것만", () => {
  const keys = PHRASES.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const p of PHRASES) {
    assert.ok(p.default.length >= 1, p.key);
    for (const l of p.default) assert.deepEqual(unknownVars(l, p.vars), [], `${p.key}: ${l}`);
  }
});

test("phrase: 기본값 · 자리표시 채우기 · 여러 줄이면 r 로 하나 · 고친 것이 이기고 비우면 기본으로", () => {
  setPhrases({});
  assert.equal(phrase("dance"), "💃 춤춰요!");
  assert.equal(phrase("todo_new_one", { title: "보고서" }), "새 할 일이 생겼어요: '보고서'");
  assert.equal(phrase("daily_all", { total: 3 }, 0), "오늘 할 일 3개 다 끝냈어요! 최고예요 🎉 (스이시~사)");
  assert.equal(phrase("daily_all", { total: 3 }, 0.99), "다 했어요! 3개 전부 끝 🎉 오늘 고생 많으셨어요");
  setPhrases({ dance: ["춤!", "얍"], todo_new_one: "새 거: {title}", nope: ["모르는 키는 무시"], hello: "  \n " });
  assert.equal(phrase("dance", {}, 0), "춤!");
  assert.equal(phrase("dance", {}, 0.7), "얍");
  assert.equal(phrase("todo_new_one", { title: "보고서" }), "새 거: 보고서");
  assert.equal(customPhrase("dance"), true);
  assert.equal(customPhrase("hello"), false, "빈 글은 기본값");
  assert.equal(phrase("hello"), "안녕하세요! 곧 브리핑할게요");
  setPhrases({});
  assert.equal(phrase("dance"), "💃 춤춰요!");
});

test("phraseVoice: 기본 문구에는 양념(voice) 그대로, 고친 문구에는 안 친다", () => {
  setPhrases({});
  // 양념이 붙는 seed 를 찾는다
  const seed = Array.from({ length: 200 }, (_, i) => `s${i}`).find((s) => voice("안녕하세요! 곧 브리핑할게요", s) !== "안녕하세요! 곧 브리핑할게요")!;
  assert.equal(phraseVoice("hello", {}, seed), voice("안녕하세요! 곧 브리핑할게요", seed));
  setPhrases({ hello: ["반가워요"] });
  assert.equal(phraseVoice("hello", {}, seed), "반가워요");
  setPhrases({});
});

test("unknownVars·fillVars·phraseLines", () => {
  assert.deepEqual(unknownVars("{title} {n} {pr} {pr}", ["title"]), ["n", "pr"]);
  assert.deepEqual(unknownVars("중괄호 없는 글", []), []);
  assert.equal(fillVars("{a}-{b}-{c}", { a: 1, b: "x" }), "1-x-{c}");
  assert.deepEqual(phraseLines(" 하나 \n\n 둘 "), ["하나", "둘"]);
  assert.deepEqual(phraseLines(["a", "b\nc", 3]), ["a", "b", "c"]);
  assert.deepEqual(phraseLines(5), []);
});

test("고친 문구가 실제 말풍선에: 새 할 일·머지·회의 알림", async () => {
  setPhrases({ todo_new_many: ["할 일 {n}개 추가!"], merge_declined: ["오케이, 머지 안 해요"], meeting_alert: ["⏰ {time} {title}{where}"] });
  try {
    const bubbles: any[] = [];
    const r = new Reactions({ bubble: (b) => { bubbles.push(b); return b.id ?? ""; }, clear: () => {} }, { logPath: join(mkdtempSync(join(tmpdir(), "cy-phr-")), "r.json") });
    r.newTodos([{ id: "a", title: "A" }, { id: "b", title: "B" }], "브리핑");
    assert.equal(bubbles[0].text, "할 일 2개 추가!");
    r.offerMerge({ id: "p1", title: "버튼", prUrl: "https://github.com/o/r/pull/1" });
    await r.decideMerge("p1", "decline", "overlay");
    assert.equal(bubbles.at(-1).text, "오케이, 머지 안 해요");
    assert.equal(alertText({ id: "m", subject: "주간 회의", start: "2026-10-13T04:00:00Z", end: "2026-10-13T05:00:00Z", location: "Room_1" }), "⏰ 13:00 주간 회의 · 📍 Room_1");
  } finally {
    setPhrases({});
  }
});

test("일정 알림 문구: {mins} 는 실제 분, {mins} 없는 예전 고친 문구도 그대로 뜬다", () => {
  const m = { id: "m", subject: "주간 회의", start: "2026-10-13T04:00:00Z", end: "2026-10-13T05:00:00Z" };
  assert.equal(alertText(m, 15), "일정 15분 전이에요! 〈주간 회의〉 13:00");
  assert.equal(alertText(m), "일정 10분 전이에요! 〈주간 회의〉 13:00");
  assert.deepEqual(validatePhrases({ meeting_alert: "{mins}분 뒤 {title}" }), { meeting_alert: ["{mins}분 뒤 {title}"] });
  setPhrases({ meeting_alert: ["회의 10분 전이에요! 〈{title}〉 {time}{where}"] });
  try {
    assert.equal(alertText({ ...m, location: "Room_1" }, 5), "회의 10분 전이에요! 〈주간 회의〉 13:00 · 📍 Room_1");
    setPhrases({ meeting_alert: ["{mins}분 남았어요: {title}"] });
    assert.equal(alertText(m, 5), "5분 남았어요: 주간 회의");
  } finally {
    setPhrases({});
  }
  assert.equal(phraseDef("meeting_alert")?.label.startsWith("일정 알림"), true);
});
