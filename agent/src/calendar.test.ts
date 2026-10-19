import { test } from "node:test";
import assert from "node:assert/strict";
import { isBusinessDay, kstDate, kstMinutes, msUntilNext, prevBusinessDay } from "./calendar.ts";

const at = (iso: string) => new Date(iso);

test("kstDate·kstMinutes: UTC 15시는 KST 다음날 0시", () => {
  assert.equal(kstDate(at("2026-10-07T15:00:00Z")), "2026-10-08");
  assert.equal(kstDate(at("2026-10-07T14:59:59Z")), "2026-10-07");
  assert.equal(kstMinutes(at("2026-10-08T01:30:00Z")), 10 * 60 + 30);
});

test("isBusinessDay: 주말·공휴일·대체공휴일·추가 휴일", () => {
  assert.equal(isBusinessDay("2026-10-08"), true); // 목
  assert.equal(isBusinessDay("2026-10-09"), false); // 한글날
  assert.equal(isBusinessDay("2026-10-10"), false); // 토
  assert.equal(isBusinessDay("2026-10-05"), false); // 개천절 대체
  assert.equal(isBusinessDay("2026-07-17"), false); // 제헌절(2026 복귀)
  assert.equal(isBusinessDay("2026-06-08"), true); // 현충일은 대체 없음
  assert.equal(isBusinessDay("2027-02-09"), false); // 설날 대체
  assert.equal(isBusinessDay("2027-12-27"), false); // 성탄절 대체
  assert.equal(isBusinessDay("2026-10-08", ["2026-10-08"]), false);
  assert.equal(isBusinessDay(at("2026-10-09T00:00:00Z")), false); // Date도 KST로 본다
});

test("prevBusinessDay: 월요일 → 금요일, 연휴 건너뜀", () => {
  assert.equal(prevBusinessDay("2026-10-12"), "2026-10-08"); // 월 → (금 한글날, 주말) → 목
  assert.equal(prevBusinessDay("2026-10-06"), "2026-10-02"); // 화 → (월 대체, 주말) → 금
  assert.equal(prevBusinessDay("2026-09-29"), "2026-09-28");
});

test("msUntilNext: 오늘 전이면 오늘, 지났으면 다음 영업일", () => {
  // 목 10:00 KST → 오늘 10:30
  assert.equal(msUntilNext(10, 30, at("2026-10-08T01:00:00Z")), 30 * 60e3);
  // 목 10:30 정각 → 다음 영업일(금 한글날·주말 건너 월 10/12)
  const ms = msUntilNext(10, 30, at("2026-10-08T01:30:00Z"));
  assert.equal(new Date(at("2026-10-08T01:30:00Z").getTime() + ms).toISOString(), "2026-10-12T01:30:00.000Z");
  // 추석 연휴 직전(9/23 수 11시) → 9/28 월
  const ms2 = msUntilNext(10, 30, at("2026-09-23T02:00:00Z"));
  assert.equal(kstDate(new Date(at("2026-09-23T02:00:00Z").getTime() + ms2)), "2026-09-28");
});

test("로컬 시간대: 날짜·시각·정기 브리핑 시간은 이 맥의 TZ 를 따른다(KST 고정 아님)", async () => {
  const { localDate, localHhmm, localMinutes, briefingHours } = await import("./calendar.ts");
  const { DailyPlanService } = await import("./daily-plan.ts");
  const { Store } = await import("./store.ts");
  const prev = process.env.TZ;
  // 시간대를 바꾼 뒤엔 Date 를 새로 만든다 — Node 24(V8 13)는 한 번 읽은 Date 의 로컬 값을 TZ 를 바꿔도 그대로 둔다(앱의 now() 는 늘 새 Date)
  const t = () => new Date("2026-10-14T02:30:00Z"); // 서울 수 11:30 · 뉴욕 화 22:30
  try {
    process.env.TZ = "Asia/Seoul";
    assert.equal(localDate(t()), "2026-10-14");
    assert.equal(localHhmm(t()), "11:30");
    assert.equal(localMinutes(t()), 11 * 60 + 30);
    assert.equal(briefingHours(t()), true);
    process.env.TZ = "America/New_York";
    assert.equal(localDate(t()), "2026-10-13");
    assert.equal(localHhmm(t()), "22:30");
    assert.equal(briefingHours(t()), false); // 밤
    assert.equal(briefingHours(new Date("2026-10-13T14:00:00Z")), true); // 뉴욕 화 10:00
    assert.equal(briefingHours(new Date("2026-10-17T14:00:00Z")), false); // 뉴욕 토
    // 오늘 할 일의 「오늘」도 로컬 날짜
    const plan = new DailyPlanService(new Store(":memory:"), { now: t });
    assert.equal(plan.state().date, "2026-10-13");
    // 아침 알림: 로컬 9시 전이면(앱을 막 연 게 아니면) 아직
    const early = new DailyPlanService(new Store(":memory:"), { now: () => new Date("2026-10-13T12:00:00Z") }); // 뉴욕 08:00
    assert.equal(early.remind({ mode: "auto", everyHours: 0, times: [] }), null);
    const nine = new DailyPlanService(new Store(":memory:"), { now: () => new Date("2026-10-13T13:05:00Z") }); // 뉴욕 09:05
    assert.equal(nine.remind({ mode: "auto", everyHours: 0, times: [] })?.kind, "ask");
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});
