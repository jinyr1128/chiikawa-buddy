import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CHARACTERS, characterClips, installCharacters, setCharacter, withCharacter } from "./characters.ts";
import { localAsk, localLine } from "./local-mode.ts";
import { phrase, fillVars } from "./phrases.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import { alertVars } from "./calendar-sync.ts";
import { Bus } from "./bus.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); });
const src = { today: () => [], open: () => [], calendar: () => ({ enabled: false, meetings: [] }) };

test("치이카와: 소리(에에에…·싫어…!·에?·에헤헤·와…!!) 뒤 괄호 안에 할 말, AI 프롬프트도 같은 규칙", () => {
  const SOUND = /^(에에에…|싫어…!|에\?|에헤헤|와…!!) \(/;
  for (const [k, lines] of Object.entries(CHARACTERS.chiikawa.phrases)) for (const l of lines) assert.match(l, SOUND, `phrases.${k}: ${l}`);
  for (const [k, l] of Object.entries(CHARACTERS.chiikawa.lines).filter(([k]) => k !== "weatherRain")) assert.match(l as string, SOUND, `local.${k}: ${l}`);
  for (const l of CHARACTERS.chiikawa.cheer!) assert.match(l, SOUND, l);
  setCharacter("chiikawa");
  assert.match(withCharacter(CHAT_SYSTEM), /치이카와는 말을 거의 못 하고 소리로 반응한다/);
});

test("치이카와 영상: 춤 두 개 중 랜덤, 일정 알림 두 번째(우는 장면)는 전용 한마디가 일정 말풍선 대신", () => {
  setCharacter("chiikawa");
  assert.deepEqual(characterClips("dance").map((x) => x.file), ["dance", "dance2"]);
  const plan = characterClips("plan");
  assert.deepEqual(plan.map((x) => x.file), ["plan", "plan2"]);
  assert.equal(plan[0].say, undefined);
  const m = { id: "e1", subject: "주간 회의", start: "2026-10-17T05:00:00.000Z", end: "2026-10-17T06:00:00.000Z", location: "3층" } as any;
  assert.equal(fillVars(plan[1].say!, alertVars(m, 10)), "에에에… (〈주간 회의〉 10분 전이야! 14:00 · 📍 3층)");
  // 데몬이 고른 번호와 말이 맞다(우는 장면일 때만 그 말)
  const bus = new Bus();
  for (let i = 0; i < 10; i++) {
    const d = bus.activity.play(1000, "plan");
    assert.equal(bus.state().danceVariant, d.variant);
    assert.equal(d.say, d.variant === 1 ? plan[1].say : undefined);
  }
  bus.activity.stop();
  assert.deepEqual(characterClips("study").map((x) => x.file), ["study", "plan", "cheer"]);
  assert.deepEqual(characterClips("lunch").map((x) => x.file), ["lunch"]);
});

test("쿠리만쥬: 소리는 「캬」뿐, 할 말은 괄호 안에", () => {
  setCharacter("kuri");
  assert.equal(CHARACTERS.kuri.name, "쿠리만쥬");
  // 술 소리로 시작(괄호 없이 소리만인 줄도 있다 — 사용자가 고친 대사)
  const DRINK = /^캬/;
  for (const l of CHARACTERS.kuri.cheer!) assert.match(l, DRINK, l);
  for (const l of CHARACTERS.kuri.phrases.dance) assert.match(l, DRINK, l);
  for (let i = 0; i < 20; i++) { assert.match(localAsk("cheer", src)!.text, DRINK); assert.match(localAsk("dance", src)!.text, DRINK); }
  assert.match(localLine("lunch"), /^캬\S* \(/);
  for (const [k, l] of Object.entries(CHARACTERS.kuri.lines).filter(([k]) => k !== "weatherRain")) assert.match(l as string, /^\S.*? \(.*\)$/, `local.${k}`);
  // 춤·일정 알림 영상이 없어 응원 영상(맥주 캔), 집중은 술상, 점심은 타코
  assert.deepEqual(characterClips("dance").map((x) => x.file), ["cheer"]);
  assert.deepEqual(characterClips("plan").map((x) => x.file), ["cheer"]);
  assert.deepEqual(characterClips("study").map((x) => x.file), ["study", "cheer", "lunch"]);
  assert.deepEqual(characterClips("lunch").map((x) => x.file), ["lunch"]);
  assert.match(CHARACTERS.kuri.tone, /「캬」만/);
  assert.match(phrase("meeting_alert", { mins: 5, title: "x", time: "1", where: "" }), /^캬\S* \(.*〈x〉/);
});
