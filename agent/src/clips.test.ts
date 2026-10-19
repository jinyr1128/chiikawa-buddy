import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CLIPS_JSON, CLIP_KINDS, clipList, pickVariant, builtinClips, SAY_VARS } from "./clips.ts";
import { CHARACTER_IDS, characterClips, installCharacters, setCharacter } from "./characters.ts";
import { ActivityTracker } from "./activity.ts";
import { Bus } from "./bus.ts";
import { Chat } from "./chat.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import type { ChatEvent } from "./chat.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); });

const SUIT = "스잇~ 스잇~ 스이 시~사 ~ 🎵";

test("clips.json: 기본 캐릭터 여덟 다 있고, 시사 춤은 두 개(새 영상에 전용 한마디)", () => {
  for (const id of CHARACTER_IDS) assert.ok(builtinClips(id), id);
  assert.equal(builtinClips("_help"), undefined);
  const dance = clipList(CLIPS_JSON.shisa, "dance");
  assert.deepEqual(dance.map((x) => x.file), ["dance", "dance2"]);
  assert.equal(dance[0].say, undefined);
  assert.equal(dance[1].say, SUIT);
  assert.equal(dance[1].scene, true);
  // 일정 알림·응원은 같은 목록이지만 한마디는 빼고(그 칸 기본 대사). 점심은 먹는 영상
  assert.deepEqual(clipList(CLIPS_JSON.shisa, "lunch").map((x) => x.file), ["lunch"]);
  for (const k of ["plan", "cheer"] as const) {
    const l = clipList(CLIPS_JSON.shisa, k);
    assert.deepEqual(l.map((x) => x.file), ["dance", "dance2"], k);
    assert.ok(l.every((x) => !x.say), k);
  }
  // 점심시간: 먹는 영상이 있는 캐릭터는 그것, 모몽가는 일정 알림 영상(기본값)
  for (const id of CHARACTER_IDS.filter((x) => x !== "momonga")) assert.deepEqual(clipList(CLIPS_JSON[id], "lunch").map((x) => x.file), ["lunch"], id);
  for (const id of ["momonga"]) assert.deepEqual(clipList(CLIPS_JSON[id], "lunch").map((x) => x.file), clipList(CLIPS_JSON[id], "plan").map((x) => x.file), id);
  assert.deepEqual(clipList(CLIPS_JSON.hachi, "dance").map((x) => x.file), ["plan"]);
  assert.deepEqual(clipList(CLIPS_JSON.rakko, "cheer").map((x) => x.file), ["plan"]);
});

test("빈 칸 대신 쓰는 순서: 응원↔춤, 일정 알림 → 춤 → 응원, 점심 → 일정 알림 → 춤 → 응원, 집중은 없음", () => {
  const t = { cheer: [{ file: "c", say: "응원!" }] };
  assert.deepEqual(clipList(t, "dance"), [{ file: "c" }], "대신 쓰면 한마디는 뺀다");
  assert.deepEqual(clipList(t, "plan"), [{ file: "c" }]);
  assert.deepEqual(clipList(t, "lunch"), [{ file: "c" }]);
  assert.deepEqual(clipList(t, "study"), []);
  assert.deepEqual(clipList({ plan: [{ file: "p" }], dance: [{ file: "d" }] }, "lunch"), [{ file: "p" }]);
  assert.deepEqual(clipList({}, "dance"), []);
  assert.deepEqual(clipList({ dance: "cheer", cheer: "dance" } as any, "dance"), [], "서로 가리켜도 멈춘다");
  // 일정 알림 한마디는 그대로(일정 말풍선 글 대신, 자리표시는 meeting_alert 와 같다)
  assert.equal(clipList({ plan: [{ file: "p", say: "x {mins}" }] }, "plan")[0].say, "x {mins}");
  assert.equal(clipList({ dance: [{ file: "d", say: "x" }] }, "plan")[0].say, undefined, "대신 쓰면 빼고");
  for (const k of CLIP_KINDS) assert.ok(Array.isArray(clipList(undefined, k)));
});

test("pickVariant: 범위 안, 두 개 이상이면 연달아 같은 번호가 안 나온다, 골고루", () => {
  assert.equal(pickVariant(0), 0);
  assert.equal(pickVariant(1, 0), 0);
  for (const n of [2, 3, 5]) {
    let last: number | undefined;
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const v = pickVariant(n, last);
      assert.ok(v >= 0 && v < n);
      assert.notEqual(v, last);
      seen.add(v);
      last = v;
    }
    assert.equal(seen.size, n);
  }
  assert.equal(pickVariant(2, 0, () => 0.99), 1);
  assert.equal(pickVariant(2, 1, () => 0), 0);
  assert.equal(pickVariant(3, 9, () => 0.999), 2, "이상한 last 는 무시");
});

test("데몬이 고른 번호와 한마디가 맞다: state.danceVariant · play().say 는 같은 영상의 것", () => {
  const bus = new Bus();
  setCharacter("shisa");
  const seen: number[] = [];
  for (let i = 0; i < 40; i++) {
    const d = bus.activity.play(1000, "dance");
    const s = bus.state();
    assert.equal(s.danceVariant, d.variant);
    assert.equal(s.danceClip, "dance");
    assert.equal(d.say, characterClips("dance")[d.variant].say);
    if (d.variant === 1) assert.equal(d.say, SUIT); else assert.equal(d.say, undefined);
    if (seen.length) assert.notEqual(d.variant, seen.at(-1), "연달아 같은 영상 안 나옴");
    seen.push(d.variant);
  }
  // 일정 알림·응원·점심은 한마디는 그 칸 기본(일정 말풍선·응원 글·점심 인사)
  for (const k of ["plan", "cheer", "lunch"] as const) for (let i = 0; i < 6; i++) assert.equal(bus.activity.play(1000, k).say, undefined);
  // 영상이 하나뿐인 캐릭터는 늘 0
  setCharacter("hachi");
  for (let i = 0; i < 5; i++) assert.equal(bus.activity.play(1000, "cheer").variant, 0);
  bus.activity.stop();
});

test("ActivityTracker: 목록이 없으면 번호 0, 목록 읽기가 깨져도 춘다", () => {
  const a = new ActivityTracker();
  assert.equal(a.play(1000, "dance").variant, 0);
  assert.equal(a.snapshot().danceVariant, 0);
  a.variants = () => { throw new Error("x"); };
  assert.equal(a.play(1000, "dance").variant, 0);
  a.variants = () => [{}, { say: "  둘째  " }];
  a.rand = () => 0.99;
  const d = a.play(1000, "dance");
  assert.deepEqual([d.variant, d.say], [1, "둘째"]);
  a.stop();
});

test("채팅 「춤」: 고른 영상의 전용 한마디가 답 글·말풍선이 된다", async () => {
  const events: ChatEvent[] = [];
  const store = new Store(":memory:");
  const chat = new Chat(loadConfig({}, {}), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {},
    dance: () => SUIT,
  }, async () => { throw new Error("모델을 부르면 안 됨"); });
  const s = chat.send("춤춰조", { kind: "hover" });
  await chat.idle();
  if ("error" in s) throw new Error("send");
  assert.equal((events.find((e) => e.chatId === s.chatId && e.status === "done") as any).text, SUIT);
});

test("사용자 캐릭터: 칸마다 넣은 목록·한마디가 데몬 목록으로", () => {
  installCharacters({ users: [{ id: "u-abcd1234", lines: { name: "까망" }, clips: { dance: [{ file: "dance-aaaaaaaa.gif", say: "까망 춤!" }, { file: "dance-bbbbbbbb.webm" }] } }] });
  setCharacter("u-abcd1234");
  assert.deepEqual(characterClips("dance").map((x) => x.say), ["까망 춤!", undefined]);
  assert.deepEqual(characterClips("lunch").map((x) => x.file), ["dance-aaaaaaaa.gif", "dance-bbbbbbbb.webm"], "점심 → 일정 알림 → 춤");
  assert.deepEqual(characterClips("study"), []);
});
