// 맥 캘린더(EventKit) 연결: agent/bin/maccal 도우미로 맥 「캘린더」 앱의 계정(회사 구글 워크스페이스·네이버 CalDAV·iCloud 등)을 읽는다.
// 캘린더 하나 = 주소 maccal://<캘린더 id>. 가져오기는 그 캘린더 일정을 ICS 글로 받아 기존 ICS 처리(ics.ts)를 그대로 쓴다.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MACCAL_PREFIX = "maccal://";
export const isMacCalUrl = (u: unknown): boolean => typeof u === "string" && /^maccal:\/\/[A-Za-z0-9:_.\-]{1,200}$/.test(u.trim());
export const macCalBin = (): string => process.env.CY_MACCAL_BIN ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "maccal");
export const macCalAvailable = (): boolean => process.platform === "darwin" && existsSync(macCalBin());

function run(args: string[], timeoutMs = 30e3): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(macCalBin(), args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const denied = /denied/.test(String(stderr)) || (err as any).code === 3;
        reject(new Error(denied ? "맥 캘린더 접근이 꺼져 있어요. 시스템 설정 → 개인정보 보호 및 보안 → 캘린더에서 치이카와 매니저를 켜 주세요." : "맥 캘린더를 읽지 못했어요."));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export type MacCalendar = { id: string; title: string; account: string; color: string; url: string };
export async function listMacCalendars(): Promise<MacCalendar[]> {
  if (!macCalAvailable()) throw new Error("이 컴퓨터에서는 맥 캘린더를 쓸 수 없어요.");
  const raw = JSON.parse(await run(["list"], 120e3)); // 처음엔 허락 창을 기다린다
  return (Array.isArray(raw) ? raw : [])
    .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
    .map((c: any) => ({ id: c.id, title: c.title, account: String(c.account ?? ""), color: String(c.color ?? ""), url: MACCAL_PREFIX + c.id }));
}
export async function macCalIcs(url: string): Promise<string> {
  if (!isMacCalUrl(url)) throw new Error("맥 캘린더 주소가 아님");
  const t = await run(["ics", url.trim().slice(MACCAL_PREFIX.length)]);
  if (!/BEGIN:VCALENDAR/.test(t)) throw new Error("맥 캘린더 형식이 아님");
  return t;
}
