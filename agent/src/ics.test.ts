import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsInWindow, occurrenceDates, parseIcs, parseLine, unfold, zonedToUtc } from "./ics.ts";
import { CalendarSync, icsSource, skipReason, toMeetings } from "./calendar-sync.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";

// 지어낸 일정. Google "비공개 주소(iCal)" 모양(IANA TZID, ATTENDEE, X-GOOGLE-CONFERENCE)
const GOOGLE = `BEGIN:VCALENDAR\r
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r
VERSION:2.0\r
X-WR-TIMEZONE:Asia/Seoul\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20260907T100000\r
DTEND;TZID=Asia/Seoul:20260907T101500\r
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r
EXDATE;TZID=Asia/Seoul:20261012T100000\r
UID:standup@example.com\r
SUMMARY:데일리 스탠드업\r
ORGANIZER;CN=Lead:mailto:lead@example.com\r
ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@example.com\r
ATTENDEE;CN=Pat;PARTSTAT=ACCEPTED:mailto:pat@example.com\r
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij\r
STATUS:CONFIRMED\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
DESCRIPTION:This is an event reminder\r
TRIGGER:-P0DT0H10M0S\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261014T150000\r
DTEND;TZID=Asia/Seoul:20261014T153000\r
RECURRENCE-ID;TZID=Asia/Seoul:20261014T100000\r
UID:standup@example.com\r
SUMMARY:데일리 스탠드업 (오후로 이동)\r
ORGANIZER:mailto:lead@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:pat@example.com\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261016T100000\r
DTEND;TZID=Asia/Seoul:20261016T101500\r
RECURRENCE-ID;TZID=Asia/Seoul:20261016T100000\r
UID:standup@example.com\r
SUMMARY:데일리 스탠드업\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;VALUE=DATE:20261013\r
DTEND;VALUE=DATE:20261014\r
UID:allday@example.com\r
SUMMARY:워크숍 (종일)\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART:20261013T050000Z\r
DTEND:20261013T060000Z\r
UID:review@example.com\r
SUMMARY:디자인 리뷰\\, 2차\r
DESCRIPTION:안건:\\n- 시안 비교\\n참여: https://example.zoom.us/j/123456?pwd=x\r
LOCATION:회의실 A\r
ORGANIZER:mailto:me@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:sam@example.com\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261013T170000\r
DTEND;TZID=Asia/Seoul:20261013T180000\r
UID:declined@example.com\r
SUMMARY:거절한 회의\r
ORGANIZER:mailto:lead@example.com\r
ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:pat@example.com\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261013T120000\r
DTEND;TZID=Asia/Seoul:20261013T130000\r
UID:lunch@example.com\r
SUMMARY:점심 (한가함)\r
TRANSP:TRANSPARENT\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261012T160000\r
DTEND;TZID=Asia/Seoul:20261012T170000\r
UID:cancelled@example.com\r
SUMMARY:취소된 회의\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Seoul:20261012T140000\r
DTEND;TZID=Asia/Seoul:20261012T150000\r
UID:folded@example.com\r
SUMMARY:아주 긴 제목이 여러 줄로 접혀서 \r
 오는 회의\r
ORGANIZER:mailto:lead@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r
END:VEVENT\r
END:VCALENDAR\r
`;

// Outlook "게시된 캘린더" 모양: Windows 시간대 이름 + VTIMEZONE
const OUTLOOK = `BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Korea Standard Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
END:STANDARD
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:Custom Zone
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0530
TZOFFSETTO:+0530
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:outlook-1
SUMMARY:주간 회의
DTSTART;TZID=Korea Standard Time:20260105T110000
DTEND;TZID=Korea Standard Time:20260105T120000
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=SU
LOCATION:Microsoft Teams 모임
DESCRIPTION:참가: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x
END:VEVENT
BEGIN:VEVENT
UID:outlook-2
SUMMARY:사용자 정의 시간대
DTSTART;TZID=Custom Zone:20261012T103000
DTEND;TZID=Custom Zone:20261012T113000
END:VEVENT
END:VCALENDAR
`;

const FROM = Date.parse("2026-10-12T00:00:00+09:00"), TO = Date.parse("2026-10-14T00:00:00+09:00");
const OPTS = { timeZone: "Asia/Seoul", email: "me@example.com" };
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

test("줄 접기·파라미터·이스케이프", () => {
  assert.deepEqual(unfold("A:1\r\n 2\r\nB:3"), ["A:12", "B:3"]);
  const p = parseLine('ATTENDEE;CN="Kim, A";PARTSTAT=ACCEPTED:mailto:a@example.com')!;
  assert.equal(p.name, "ATTENDEE");
  assert.equal(p.params.CN, "Kim, A");
  assert.equal(p.value, "mailto:a@example.com");
  const cal = parseIcs(GOOGLE);
  assert.equal(cal.events.find((e) => e.uid === "review@example.com")!.summary, "디자인 리뷰, 2차");
  assert.equal(cal.events.find((e) => e.uid === "folded@example.com")!.summary, "아주 긴 제목이 여러 줄로 접혀서 오는 회의");
  assert.ok(!cal.events.some((e) => e.summary === "This is an event reminder"), "VALARM 은 건너뜀");
});

test("Google ICS: 반복(EXDATE·바뀐 회차·취소된 회차)·종일·UTC·거절·한가함·취소", () => {
  const evs = eventsInWindow(GOOGLE, FROM, TO, OPTS);
  const by = (s: string) => evs.filter((e) => e.subject.startsWith(s));
  // 스탠드업: 10/12(월)은 EXDATE, 10/14(수)는 범위 밖(오후로 옮긴 회차도 10/14) → 창 안 회차 없음
  assert.equal(by("데일리 스탠드업").length, 0);
  const wider = eventsInWindow(GOOGLE, FROM, Date.parse("2026-10-17T00:00:00+09:00"), OPTS).filter((e) => e.subject.startsWith("데일리"));
  assert.deepEqual(wider.map((e) => [kst(e.start), e.subject, e.cancelled]), [
    ["2026-10-14 15:00", "데일리 스탠드업 (오후로 이동)", false],
    ["2026-10-16 10:00", "데일리 스탠드업", true],
  ]);
  assert.equal(wider[0].joinUrl, undefined, "바뀐 회차엔 회의 링크가 없음");
  const allDay = by("워크숍")[0];
  assert.equal(allDay.allDay, true);
  assert.equal(kst(allDay.start), "2026-10-13 00:00");
  assert.equal(skipReason(allDay), "all-day");
  const review = by("디자인 리뷰")[0];
  assert.equal(kst(review.start), "2026-10-13 14:00", "UTC → KST");
  assert.equal(review.response, "organizer");
  assert.equal(review.attendees, 1);
  assert.equal(review.joinUrl, "https://example.zoom.us/j/123456?pwd=x");
  assert.equal(skipReason(review), null);
  assert.equal(skipReason(by("거절한 회의")[0]), "declined");
  assert.equal(skipReason(by("점심")[0]), "free");
  assert.equal(skipReason(by("취소된 회의")[0]), "cancelled");
  const meetings = toMeetings(evs);
  assert.deepEqual(meetings.map((m) => m.subject), ["아주 긴 제목이 여러 줄로 접혀서 오는 회의", "디자인 리뷰, 2차"]);
});

test("Google ICS: 반복 회차의 회의 링크·참석자, 회차마다 다른 id", () => {
  const evs = eventsInWindow(GOOGLE, Date.parse("2026-10-09T00:00:00+09:00"), Date.parse("2026-10-10T00:00:00+09:00"), OPTS);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(evs[0].response, "accepted");
  assert.equal(evs[0].attendees, 2, "나 말고 Pat + 주최자");
  assert.equal(evs[0].id, "standup@example.com#2026-10-09T01:00:00.000Z");
});

test("Outlook ICS: Windows 시간대 이름, VTIMEZONE 고정 오프셋, Teams 링크", () => {
  const evs = eventsInWindow(OUTLOOK, FROM, TO, { timeZone: "Asia/Seoul" });
  const weekly = evs.find((e) => e.subject === "주간 회의")!;
  assert.equal(kst(weekly.start), "2026-10-12 11:00");
  assert.match(weekly.joinUrl!, /^https:\/\/teams\.microsoft\.com\//);
  const custom = evs.find((e) => e.subject === "사용자 정의 시간대")!;
  assert.equal(custom.start, "2026-10-12T05:00:00.000Z", "+05:30");
  assert.equal(evs.length, 2);
});

test("RRULE: 서머타임 넘는 주간 반복은 벽시계 시각 유지, COUNT·UNTIL·월 마지막 금요일·INTERVAL", () => {
  const ny = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:ny
SUMMARY:NY sync
DTSTART;TZID=America/New_York:20261026T090000
DTEND;TZID=America/New_York:20261026T093000
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
END:VCALENDAR`;
  const evs = eventsInWindow(ny, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"), { timeZone: "Asia/Seoul" });
  assert.deepEqual(evs.map((e) => e.start), ["2026-10-26T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-09T14:00:00.000Z"], "11/1 서머타임 끝 → UTC 가 한 시간 늦어짐");
  const toUtc = (d: { y: number; mo: number; d: number }) => zonedToUtc({ ...d, h: 9, mi: 0, s: 0 }, "Asia/Seoul");
  const start = { y: 2026, mo: 1, d: 30, h: 9, mi: 0, s: 0, date: false, utc: false };
  const lastFri = occurrenceDates(start, { FREQ: "MONTHLY", BYDAY: "-1FR", UNTIL: "20260501T000000Z" }, toUtc, Infinity);
  assert.deepEqual(lastFri.map((x) => `${x.mo}/${x.d}`), ["1/30", "2/27", "3/27", "4/24"]);
  const biweekly = occurrenceDates({ ...start, d: 5 }, { FREQ: "WEEKLY", INTERVAL: "2", BYDAY: "MO,TH", COUNT: "5" }, toUtc, Infinity);
  assert.deepEqual(biweekly.map((x) => `${x.mo}/${x.d}`), ["1/5", "1/8", "1/19", "1/22", "2/2"]);
  const daily = occurrenceDates({ ...start, y: 2016, mo: 1, d: 1 }, { FREQ: "DAILY" }, toUtc, Date.parse("2026-10-12T23:00:00Z"), Date.parse("2026-10-10T01:00:00Z"));
  assert.deepEqual(daily.map((x) => `${x.y}-${x.mo}-${x.d}`), ["2026-10-11", "2026-10-12"], "10년 된 매일 반복도 창 근처만");
  const monthly31 = occurrenceDates({ ...start, d: 31 }, { FREQ: "MONTHLY", COUNT: "3" }, toUtc, Infinity);
  assert.deepEqual(monthly31.map((x) => `${x.mo}/${x.d}`), ["1/31", "3/31", "5/31"], "31일 없는 달은 건너뜀");
  // BYDAY·BYMONTH·BYMONTHDAY 는 거르기 — COUNT 는 거른 뒤 센다
  const md = (r: Record<string, string>, d = start, stop = Infinity) => occurrenceDates(d, r, toUtc, stop).map((x) => `${x.mo}/${x.d}`);
  assert.deepEqual(md({ FREQ: "DAILY", BYDAY: "MO,TU,WE,TH,FR", COUNT: "4" }), ["1/30", "2/2", "2/3", "2/4"], "평일만 매일(1/30 금 → 주말 건너뜀)");
  assert.deepEqual(md({ FREQ: "DAILY", BYMONTH: "2", COUNT: "2" }), ["2/1", "2/2"], "매일이지만 2월만");
  assert.deepEqual(md({ FREQ: "WEEKLY", BYMONTH: "3", COUNT: "2" }), ["3/6", "3/13"], "매주(금)지만 3월만");
  assert.deepEqual(md({ FREQ: "MONTHLY", BYDAY: "FR", BYMONTHDAY: "13", COUNT: "2" }), ["2/13", "3/13"], "13일의 금요일");
  const t0 = performance.now();
  assert.deepEqual(md({ FREQ: "MONTHLY", BYMONTH: "2", BYMONTHDAY: "31" }, start, Date.parse("2027-01-01T00:00:00Z")), [], "맞는 날이 없는 규칙");
  assert.ok(performance.now() - t0 < 200, "맞는 날이 없어도 창을 넘으면 멈춘다");
});

test("icsSource → CalendarSync: 창 안 회의만 저장, 실패하면 예전 것 유지, 주소는 로그에 안 남김", async () => {
  const store = new Store(":memory:");
  const cfg = loadConfig({});
  let fail = false;
  const urls: string[] = [];
  const src = icsSource(["https://calendar.example.com/private-secret/basic.ics"], OPTS, async (u) => { urls.push(u); if (fail) throw new Error("ICS HTTP 500"); return GOOGLE; });
  const now = new Date("2026-10-12T09:00:00+09:00");
  const sync = new CalendarSync(cfg, store, { source: src, now: () => now });
  assert.equal(sync.enabled, true);
  const r = await sync.sync();
  assert.equal(r.errors, 0);
  assert.equal(r.costUsd, 0);
  assert.deepEqual(sync.upcoming().map((m) => m.subject), ["아주 긴 제목이 여러 줄로 접혀서 오는 회의", "디자인 리뷰, 2차"]);
  fail = true;
  const warn = console.warn; const logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const r2 = await sync.sync();
    assert.equal(r2.errors, 1);
  } finally { console.warn = warn; }
  assert.equal(sync.upcoming().length, 2, "실패면 예전 것 유지");
  assert.ok(logs.every((l) => !l.includes("private-secret")), "비밀 주소는 로그에 없음");
});

test("캘린더 off: 동기화·알림 없음", async () => {
  const store = new Store(":memory:");
  const sync = new CalendarSync(loadConfig({}), store, { source: null });
  assert.equal(sync.enabled, false);
  let fired = 0;
  const stop = sync.schedule(() => { fired++; });
  const r = await sync.sync();
  assert.equal(r.calls, 0);
  assert.equal(fired, 0);
  stop();
});
