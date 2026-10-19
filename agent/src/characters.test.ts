import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTERS, CHARACTER_IDS, LEGACY_SHISA_INTRO, SHISA_PERSONA, character, characterId, installCharacters, setCharacter, withCharacter } from "./characters.ts";
import { SYSTEM, INTERACTIVE_SYSTEM, systemPrompt, ask } from "./brain.ts";
import { CHAT_SYSTEM, CHAT_SYSTEM_INLINE, BG_AGENT_SYSTEM } from "./chat.ts";
import { ASK_SYSTEM } from "./todo-ask.ts";
import { PHRASES, phrase, phraseVoice, setPhrases, unknownVars, defaultLines } from "./phrases.ts";
import { voice, TONE, tone } from "./voice.ts";
import { localThought, quickAnswer, QUICK_ASKS } from "./local-mode.ts";
import { loadConfig } from "./config.ts";
import { Settings } from "./settings.ts";
import { Bus } from "./bus.ts";
import type { FetchLike } from "./providers.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); setPhrases({}); });

const OTHERS = CHARACTER_IDS.filter((id) => id !== "shisa");
const SYSTEMS = { SYSTEM, INTERACTIVE_SYSTEM, CHAT_SYSTEM, CHAT_SYSTEM_INLINE, BG_AGENT_SYSTEM, ASK_SYSTEM, connectorsOff: systemPrompt() };

test("캐릭터: 모르는 값은 시사, 고르면 바로 바뀐다", () => {
  for (const bad of [undefined, null, "", "nope", "__proto__", "Hachi", 1]) assert.equal(setCharacter(bad), "shisa", String(bad));
  setCharacter("rakko");
  assert.equal(characterId(), "rakko");
  assert.equal(character().name, "랏코");
  assert.equal(tone(), CHARACTERS.rakko.tone);
  assert.equal(TONE, CHARACTERS.shisa.tone); // 상수는 시사 그대로(고정 프롬프트의 바꿀 자리)
});

test("우사기: 저장·재시작·SSE·기본 문구에 적용되고 사용자가 고친 문구는 유지된다", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cy-usagi-")), "config.json");
  const settings = new Settings(loadConfig({}, {}), { path, env: {} });
  assert.ok(settings.put({ character: "usagi" }).ok);
  assert.equal(character().name, "우사기");
  assert.equal(new Bus().state().character, "usagi");
  assert.ok(settings.put({ phrases: { hello: "내 인사" } }).ok);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.character, "usagi");
  setCharacter("shisa");
  const restarted = new Settings(loadConfig({}, saved), { path, env: {} });
  assert.equal(restarted.view().character, "usagi");
  assert.equal(phrase("hello"), "내 인사");
  assert.equal(phrase("merge_ask", { title: "수정" }), "하아~~?('수정' PR을 머지할까?)");
});

test("우사기: 중요 안내의 사실·질문을 괄호에 남기고, 외침을 두 번 붙이지 않는다", () => {
  setCharacter("usagi");
  const serious = ["meeting_alert", "proposal_ask", "proposal_ask_fix", "proposal_go",
    ...Object.keys(CHARACTERS.usagi.phrases).filter((k) => /^(fix_|merge_|followup_)/.test(k))];
  for (const k of serious) for (const text of CHARACTERS.usagi.phrases[k]) {
    assert.match(text, /^(?:우나|하아~~\?)\(.+\)$/u, k);
  }
  for (let i = 0; i < 40; i++) {
    const text = "야하!(오늘도 같이 보자!)";
    assert.equal(voice(text, `usagi-${i}`), text);
    for (const kind of ["error", "merge", "approval", "meeting", "progress"] as const) {
      assert.equal(voice("확인이 필요해.", `usagi-${i}`, { kind }), "확인이 필요해.");
    }
  }
});

test("소개: 시사는 「cy」가 아니라 「시사」라고 소개하고, 이름만 바꾼 시사·예전 소개 글로 저장된 대사는 그 이름으로", () => {
  for (const [name, sys] of Object.entries(SYSTEMS)) {
    assert.ok(sys.startsWith('너는 사용자 개인 PC에 상주하는 비서 캐릭터 "시사"다.'), name);
    assert.ok(!sys.includes('비서 "cy"'), `${name}: 예전 소개가 남음`);
  }
  installCharacters({ overrides: { shisa: { name: "시사짱" } } });
  assert.ok(withCharacter(SYSTEM).startsWith('너는 사용자 개인 PC에 상주하는 비서 캐릭터 "시사짱"다.'));
  installCharacters({ overrides: { shisa: { prompt: { intro: LEGACY_SHISA_INTRO } } }, users: [{ id: "u-abc12345", lines: { name: "까망", prompt: { intro: LEGACY_SHISA_INTRO, tone: "까망 말투.", persona: "" } } }] });
  assert.equal(withCharacter(SYSTEM), SYSTEM, "예전 소개 글은 기본 소개로");
  setCharacter("u-abc12345");
  assert.ok(withCharacter(SYSTEM).startsWith('너는 사용자 개인 PC에 상주하는 비서 캐릭터 "까망"다. 까망 말투.'));
});

test("시스템 프롬프트: 시사면 글자 하나 안 바뀌고, 다른 캐릭터면 모든 프롬프트에서 시사 소개·말투가 그 캐릭터 것으로", () => {
  for (const [name, sys] of Object.entries(SYSTEMS)) {
    assert.ok(sys.includes(SHISA_PERSONA), `${name}: 바꿀 자리(시사 소개+말투)가 없다`);
    assert.equal(withCharacter(sys), sys, `${name}: 시사인데 바뀜`);
  }
  for (const id of OTHERS) {
    setCharacter(id);
    const c = CHARACTERS[id];
    for (const [name, sys] of Object.entries(SYSTEMS)) {
      const out = withCharacter(sys);
      assert.ok(!out.includes(CHARACTERS.shisa.tone), `${id}/${name}: 시사 말투가 남음`);
      assert.ok(!out.includes('"시사"다'), `${id}/${name}: 시사 소개가 남음`);
      assert.ok(out.startsWith(`${c.intro} ${c.tone}`), `${id}/${name}`);
      assert.equal(out.split(c.tone).length - 1, 1, `${id}/${name}: 말투 줄은 한 번만`);
      // 말투 말고 나머지(규칙·안전 지시)는 그대로
      assert.equal(out.slice(`${c.intro} ${c.tone}`.length), sys.slice(SHISA_PERSONA.length), `${id}/${name}: 나머지가 바뀜`);
    }
  }
  assert.equal(withCharacter(undefined), undefined);
  assert.equal(withCharacter(""), "");
});

test("시스템 프롬프트: 실제로 모델에 가는 글이 바뀐다(Gemini 경로) — 바꾼 직후 다음 질문부터", async () => {
  const sent: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    sent.push(body.systemInstruction?.parts?.[0]?.text ?? "");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "응" }) }] } }] }), { status: 200 });
  };
  const base = loadConfig({});
  const cfg = { ...base, brain: { provider: "gemini" as const } };
  const opts = { system: CHAT_SYSTEM, deps: { fetch, env: { CY_AGENT_GEMINI_API_KEY: "unit-test-gemini-key-chars" } } };
  await ask(cfg, "안녕", null, undefined, opts);
  setCharacter("momonga");
  await ask(cfg, "안녕", null, undefined, opts);
  setCharacter("shisa");
  await ask(cfg, "안녕", null, undefined, opts);
  assert.equal(sent.length, 3);
  assert.equal(sent[0], CHAT_SYSTEM);
  assert.ok(sent[1].startsWith(CHARACTERS.momonga.intro) && !sent[1].includes(CHARACTERS.shisa.tone));
  assert.equal(sent[2], CHAT_SYSTEM);
});

test("고정 문구: 캐릭터 기본 → 고친 문구가 이긴다, 캐릭터 문구는 아는 키·아는 자리표시만", () => {
  const keys = new Set<string>(PHRASES.map((p) => p.key));
  for (const id of OTHERS) {
    const c = CHARACTERS[id];
    for (const [k, lines] of Object.entries(c.phrases)) {
      assert.ok(keys.has(k), `${id}: 모르는 문구 키 ${k}`);
      const vars = PHRASES.find((p) => p.key === k)!.vars;
      for (const l of lines) assert.deepEqual(unknownVars(l, vars), [], `${id}/${k}: ${l}`);
    }
    // 모든 키를 캐릭터 말로 채워 둔다(빠지면 시사 존댓말이 섞여 나온다)
    assert.deepEqual([...keys].filter((k) => !c.phrases[k]), [], `${id}: 빠진 문구`);
  }
  setCharacter("rakko");
  assert.equal(phrase("meeting_alert", { mins: 10, title: "파르페", time: "15:00", where: "" }), "음!! 〈파르페〉 10분 전!! 15:00");
  assert.deepEqual(defaultLines("hello"), CHARACTERS.rakko.phrases.hello);
  setPhrases({ meeting_alert: ["내 문구 {mins}"] });
  assert.equal(phrase("meeting_alert", { mins: 5 }), "내 문구 5");
  setPhrases({});
  setCharacter("shisa");
  assert.equal(phrase("meeting_alert", { mins: 10, title: "회의", time: "15:00", where: "" }), "일정 10분 전이에요! 〈회의〉 15:00");
});

test("말투 양념: 반말 캐릭터는 '~요'·시사 감정 표시를 절대 붙이지 않고, 진지한 말엔 아무것도", () => {
  for (const id of OTHERS) {
    setCharacter(id);
    let changed = 0;
    for (let i = 0; i < 400; i++) {
      const text = "할 일이 생겼어";
      const out = voice(text, `seed-${i}`, { mood: (["happy", "excited", "calm", "busy"] as const)[i % 4] });
      assert.doesNotMatch(out, /~요|시사\)|스이시/, `${id}: ${out}`);
      assert.ok(out.includes(text));
      if (out !== text) changed++;
      assert.equal(voice(out, `seed-${i}`), out, `${id}: 양념이 두 번`);
      assert.equal(voice(text, `seed-${i}`, { kind: "error" }), text);
      assert.equal(voice(text, `seed-${i}`, { kind: "meeting" }), text);
    }
    if (["usagi", "kani", "chiikawa", "kuri"].includes(id)) assert.equal(changed, 0, `${id}: 완성된 소리·괄호에 양념을 다시 붙이지 않는다`);
    else assert.ok(changed > 40 && changed < 200, `${id}: 양념 빈도 ${changed}/400`);
    assert.doesNotMatch(phraseVoice("todo_new_one", { title: "x" }, "s1"), /요/);
  }
});

test("AI 없이 하는 말(local-mode): 캐릭터 말로, 반말 캐릭터는 존댓말 끝이 없다", () => {
  const now = new Date("2026-10-15T09:00:00+09:00");
  const facts = { now, today: [{ title: "보고", done: true }, { title: "리뷰", done: false }], open: [{ title: "리뷰", priority: 1 }], calendar: { enabled: true, meetings: [{ subject: "회의", start: "2026-10-15T09:10:00+09:00", end: "2026-10-15T10:00:00+09:00" }] } };
  for (const id of OTHERS) {
    setCharacter(id);
    const t = localThought(now, [{ title: "리뷰", priority: 1 }], [{ title: "보고" }]);
    const all = [t.bubble, t.reply_md, ...QUICK_ASKS.map((q) => quickAnswer(q, facts).text)];
    for (const s of all) assert.doesNotMatch(s, /(어|에|해|세|게|죠|예)요[.!]?(\s|$)|시사\)|스이시|습니다/, `${id}: ${s}`);
  }
  setCharacter("shisa");
  assert.match(localThought(now, [], []).reply_md, /요/);
});

test("설정: PUT character → config.json 에 쓰고 바로 바뀌고, 모르는 값은 400, 문구 기본값도 그 캐릭터 것", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-chars-"));
  const path = join(dir, "config.json");
  const cfg = loadConfig({}, {});
  const seen: string[][] = [];
  const s = new Settings(cfg, { path, env: {}, onChange: (k) => seen.push(k) });
  assert.equal(s.view().character, "shisa");
  assert.deepEqual(s.view().characters.map((c) => c.id), [...CHARACTER_IDS]);
  const r = s.put({ character: "hachi" });
  assert.ok(r.ok);
  assert.equal(characterId(), "hachi");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).character, "hachi");
  assert.deepEqual(seen.at(-1), ["character"]);
  assert.equal(r.ok && r.settings.character, "hachi");
  assert.deepEqual(r.ok && r.settings.phrases.find((p) => p.key === "hello")?.default, [...CHARACTERS.hachi.phrases.hello]);
  // 캐릭터 기본과 같은 줄을 저장하면 「고친 것」이 아니다(다른 캐릭터로 바꾸면 따라간다)
  assert.ok(s.put({ phrases: { hello: CHARACTERS.hachi.phrases.hello.join("\n") } }).ok);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).phrases, undefined);
  for (const bad of ["nope", "", 3, null, ["hachi"]]) {
    const x = s.put({ character: bad });
    assert.ok(!x.ok && x.status === 400, String(bad));
  }
  assert.equal(characterId(), "hachi"); // 실패한 저장은 그대로
  // 다시 켜도(config.json 에서 읽어) 같은 캐릭터
  setCharacter("shisa");
  const again = new Settings(loadConfig({}, JSON.parse(readFileSync(path, "utf8"))), { path, env: {} });
  assert.equal(again.view().character, "hachi");
  assert.equal(characterId(), "hachi");
  // config.json 에 이상한 값이 있어도 시사로 켜진다
  new Settings(loadConfig({}, { character: "???" }), { path: join(dir, "x.json"), env: {} });
  assert.equal(characterId(), "shisa");
});

test("SSE state 에 지금 캐릭터 id 가 실린다(앱이 그림·영상을 고른다)", () => {
  const bus = new Bus();
  assert.equal(bus.state().character, "shisa");
  setCharacter("momonga");
  assert.equal(bus.state().character, "momonga");
});

test("춤춰 줘·응원해 줘 칩: 캐릭터 말, 누를 때마다 줄을 고르고, 춤 영상 종류(dance·cheer)가 state 에 실린다", async () => {
  const { localAsk, isQuickAsk } = await import("./local-mode.ts");
  const { ActivityTracker } = await import("./activity.ts");
  assert.ok(isQuickAsk("dance") && isQuickAsk("cheer"));
  const src = { today: () => [], open: () => [], calendar: () => ({ enabled: false, meetings: [] }) };
  setCharacter("rakko");
  assert.equal(localAsk("dance", src)?.text, "춤은 못 추지만, 멋있는 걸 보여 주지. (쓩)");
  const cheers = new Set(Array.from({ length: 40 }, () => localAsk("cheer", src)?.text));
  assert.ok(cheers.size > 1, "응원은 누를 때마다 다른 줄");
  for (const t of cheers) assert.ok(CHARACTERS.rakko.cheer!.some((l) => t!.includes(l)), String(t));
  setCharacter("shisa");
  assert.equal(localAsk("dance", src)?.text, "💃 춤춰요!");
  // 춤 영상 종류: 기본 plan(일정 알림), 칩·채팅은 dance·cheer
  const a = new ActivityTracker();
  a.startDance(1000);
  assert.equal(a.snapshot().danceClip, "plan");
  a.startDance(1000, "cheer");
  assert.equal(a.snapshot().danceClip, "cheer");
  assert.equal(a.snapshot().activity, "dancing");
});

test("우사기 춤: 머리 위 대사는 요청한 두 줄 외침을 그대로 유지한다", () => {
  setCharacter("usagi");
  const expected = "이-야~ 야하 야하!\n우-라 푸루푸루푸루!! 우라~!";
  const facts = { now: new Date("2026-10-16T00:00:00Z"), today: [], open: [], calendar: { enabled: false, meetings: [] } };
  for (const seed of ["one", "two", "three"]) assert.equal(quickAnswer("dance", facts, seed).text, expected);
  assert.equal(phrase("dance"), expected);
  setPhrases({ dance: "내가 고친 대사" });
  assert.equal(quickAnswer("dance", facts).text, "내가 고친 대사");
});
