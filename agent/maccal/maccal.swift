// 맥 캘린더(EventKit) 읽기 도우미 — 맥 「캘린더」 앱에 추가한 계정(회사 구글 워크스페이스·네이버 CalDAV·iCloud 등)의 일정을 읽는다.
// 비공개 iCal 주소를 막아 둔 회사 계정도 맥 캘린더에 로그인만 하면 된다. 읽기만 하고 아무것도 바꾸지 않는다.
//   maccal list                      → [{"id","title","account","color"}] (JSON)
//   maccal ics <캘린더 id> [앞 일수] [뒤 일수] → 그 캘린더 일정(반복 일정은 펼쳐서)을 ICS 글로
// 처음 실행하면 macOS가 「캘린더 접근」 허락을 묻는다(앱 Info.plist 의 NSCalendarsFullAccessUsageDescription).
import EventKit
import Foundation

let args = CommandLine.arguments
func fail(_ msg: String, _ code: Int32) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(code) }

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { g, _ in granted = g; sem.signal() }
} else {
  store.requestAccess(to: .event) { g, _ in granted = g; sem.signal() }
}
sem.wait()
if !granted { fail("denied: 시스템 설정 → 개인정보 보호 및 보안 → 캘린더에서 치이카와 매니저를 켜 주세요", 3) }

func hex(_ c: CGColor?) -> String {
  guard let c = c, let comps = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components, comps.count >= 3 else { return "" }
  return String(format: "#%02x%02x%02x", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
}

guard args.count >= 2 else { fail("usage: maccal list | ics <id> [past] [future]", 2) }

if args[1] == "list" {
  let cals = store.calendars(for: .event).map { c -> [String: String] in
    ["id": c.calendarIdentifier, "title": c.title, "account": c.source?.title ?? "", "color": hex(c.cgColor)]
  }
  let data = try! JSONSerialization.data(withJSONObject: cals, options: [])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

guard args[1] == "ics", args.count >= 3 else { fail("usage: maccal ics <id>", 2) }
guard let cal = store.calendar(withIdentifier: args[2]) else { fail("no calendar", 4) }
let past = Double(args.count > 3 ? args[3] : "31") ?? 31
let future = Double(args.count > 4 ? args[4] : "62") ?? 62
let now = Date()
let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-past * 86400), end: now.addingTimeInterval(future * 86400), calendars: [cal])
let events = store.events(matching: pred)

let utc = DateFormatter()
utc.locale = Locale(identifier: "en_US_POSIX"); utc.timeZone = TimeZone(identifier: "UTC"); utc.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
let day = DateFormatter()
day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = TimeZone.current; day.dateFormat = "yyyyMMdd"
func esc(_ s: String) -> String {
  s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: ";", with: "\\;").replacingOccurrences(of: ",", with: "\\,")
    .replacingOccurrences(of: "\r\n", with: "\\n").replacingOccurrences(of: "\n", with: "\\n")
}
var out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//chiikawa-buddy//maccal//KO", "X-WR-CALNAME:\(esc(cal.title))"]
for e in events {
  guard let s = e.startDate, let en = e.endDate else { continue }
  if e.status == .canceled { continue }
  // 내가 거절한 회의는 넣지 않는다(알림·브리핑에 안 나오게)
  if let me = e.attendees?.first(where: { $0.isCurrentUser }), me.participantStatus == .declined { continue }
  out.append("BEGIN:VEVENT")
  out.append("UID:\(esc((e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? UUID().uuidString)))-\(Int(s.timeIntervalSince1970))")
  if e.isAllDay {
    out.append("DTSTART;VALUE=DATE:\(day.string(from: s))")
    out.append("DTEND;VALUE=DATE:\(day.string(from: en.addingTimeInterval(1)))")
  } else {
    out.append("DTSTART:\(utc.string(from: s))")
    out.append("DTEND:\(utc.string(from: en))")
  }
  out.append("SUMMARY:\(esc(e.title ?? "(제목 없음)"))")
  if let l = e.location, !l.isEmpty { out.append("LOCATION:\(esc(l))") }
  if let n = e.notes, !n.isEmpty { out.append("DESCRIPTION:\(esc(String(n.prefix(2000))))") }
  if let u = e.url { out.append("URL:\(esc(u.absoluteString))") }
  out.append("END:VEVENT")
}
out.append("END:VCALENDAR")
print(out.joined(separator: "\r\n"))
