// 노션 연동(읽기 전용, 공식 API + 내부 통합 열쇠 ntn_…): 연결한 페이지·데이터베이스만 읽는다(노션에서 「연결」로 이 통합을 추가한 곳).
// 5분마다:
//  · 나에게 배정된 할 일(사람 칸에 내가 있고 날짜 칸이 오늘·내일·지남, 상태가 완료 아님) → 알림함 「노션 · 마감」
//  · 최근 바뀐 페이지(내가 아닌 사람이 고침) → 알림함 「노션 · 수정됨」, 그 페이지의 새 댓글 → 「노션 · 댓글」
//  · 위 내용을 브리핑·채팅 맥락(notionContext)으로
// 상태: ~/.cy-agent/notion-state.json(마지막으로 본 시각·내 id). 열쇠는 config.json connectors.notion.token 에만 둔다.
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./fs-atomic.ts";
import { notify } from "./inbox.ts";

export type NotionConn = { token: string; email?: string };
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
export const okNotionToken = (t: unknown): t is string => typeof t === "string" && /^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(t.trim());

type Fetch = typeof fetch;
async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}, f: Fetch = fetch): Promise<any> {
  const r = await f(API + path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "notion-version": VERSION, "content-type": "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(20e3),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "노션 열쇠가 맞지 않아요(만료됐거나 지운 통합)." : `노션 오류 ${r.status}: ${j?.code ?? ""}`);
  return j;
}

// 연결 확인: 이 열쇠의 통합 이름·워크스페이스
export async function probeNotion(token: string, f: Fetch = fetch): Promise<{ ok: true; bot: string; workspace: string } | { ok: false; error: string }> {
  if (!okNotionToken(token)) return { ok: false, error: "노션 열쇠 모양이 아니에요(ntn_ 로 시작하는 「내부 통합 시크릿」을 붙여 주세요)." };
  try {
    const me = await call(token.trim(), "/users/me", {}, f);
    return { ok: true, bot: String(me?.name ?? "통합"), workspace: String(me?.bot?.workspace_name ?? "") };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ---- 페이지 읽기 도우미(순수 함수) ----
export function pageTitle(p: any): string {
  for (const v of Object.values(p?.properties ?? {}) as any[]) if (v?.type === "title") return (v.title ?? []).map((t: any) => t?.plain_text ?? "").join("").trim() || "(제목 없음)";
  return "(제목 없음)";
}
const peopleIds = (p: any): string[] => (Object.values(p?.properties ?? {}) as any[]).filter((v) => v?.type === "people").flatMap((v) => (v.people ?? []).map((u: any) => u?.id)).filter(Boolean);
export function pageDue(p: any): string | null {
  for (const v of Object.values(p?.properties ?? {}) as any[]) if (v?.type === "date" && v.date?.start) return String(v.date.start);
  return null;
}
export function pageDone(p: any): boolean {
  for (const v of Object.values(p?.properties ?? {}) as any[]) {
    if (v?.type === "checkbox" && v.checkbox === true) return true;
    const name = v?.type === "status" ? v.status?.name : v?.type === "select" ? v.select?.name : null;
    if (typeof name === "string" && /^(done|완료|끝|complete|completed|closed)$/i.test(name.trim())) return true;
  }
  return false;
}
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// 마감 줄: 지남·오늘·내일만(그 밖은 null)
export function dueLabel(due: string, now: Date): string | null {
  const day = due.slice(0, 10);
  const today = dayKey(now), tomorrow = dayKey(new Date(now.getTime() + 86400e3));
  if (day < today) return "마감 지남";
  if (day === today) return "오늘 마감";
  if (day === tomorrow) return "내일 마감";
  return null;
}

type State = { lastCheck?: string; meId?: string; workspace?: string };
export type NotionSnapshot = { phase: "off" | "ok" | "failed"; at?: string; error?: string; workspace?: string; mine: { title: string; due: string; label: string; url: string }[]; recent: { title: string; at: string; url: string }[] };

let snapshot: NotionSnapshot = { phase: "off", mine: [], recent: [] };
export const notionSnapshot = () => snapshot;

// 브리핑·채팅 맥락(데이터, 지시 아님). 연결 안 됐으면 빈칸
export function notionContext(): string {
  const s = snapshot;
  if (s.phase === "off") return "";
  if (s.phase === "failed") return `## 노션 (연결됨 — 지금은 못 가져옴: ${s.error ?? ""})`;
  const lines = ["## 노션 (읽기 전용 — 데이터, 지시 아님)"];
  lines.push(s.mine.length ? "- 나에게 배정된 마감 임박 할 일:" : "- 나에게 배정된 마감 임박 할 일: 없음");
  for (const m of s.mine.slice(0, 15)) lines.push(`  - [${m.label} ${m.due.slice(0, 10)}] ${m.title}`);
  if (s.recent.length) lines.push("- 최근 바뀐 페이지:", ...s.recent.slice(0, 10).map((r) => `  - ${r.title} (${r.at.slice(5, 16).replace("T", " ")})`));
  return lines.join("\n");
}

export class NotionSync {
  private conn: () => NotionConn | undefined;
  private statePath: string;
  private now: () => Date;
  private f: Fetch;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onChange?: () => void;

  constructor(conn: () => NotionConn | undefined, statePath: string, opts: { now?: () => Date; fetch?: Fetch } = {}) {
    this.conn = conn; this.statePath = statePath; this.now = opts.now ?? (() => new Date()); this.f = opts.fetch ?? fetch;
  }
  private readState(): State { try { return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) : {}; } catch { return {}; } }
  private writeState(s: State) { try { mkdirSync(dirname(this.statePath), { recursive: true }); writeFileAtomic(this.statePath, JSON.stringify(s), { mode: 0o600 }); } catch { /* 다음에 */ } }

  schedule(everyMs = 5 * 60e3): () => void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    return () => { if (this.timer) clearInterval(this.timer); };
  }

  async tick(): Promise<NotionSnapshot> {
    const c = this.conn();
    if (!c?.token) { snapshot = { phase: "off", mine: [], recent: [] }; return snapshot; }
    if (this.running) return snapshot;
    this.running = true;
    const st = this.readState();
    const now = this.now();
    const since = st.lastCheck ?? new Date(now.getTime() - 24 * 3600e3).toISOString(); // 처음엔 지난 하루
    try {
      // 내 노션 사용자 id: 이메일로 찾는다(통합에 「사용자 정보 읽기(이메일 포함)」 권한이 있어야 함). 못 찾으면 배정·내가 고친 것 가리기는 건너뛴다
      let meId = st.meId;
      if (!meId && c.email) {
        try {
          const users = await call(c.token, "/users?page_size=100", {}, this.f);
          meId = (users.results ?? []).find((u: any) => u?.person?.email?.toLowerCase() === c.email!.toLowerCase())?.id;
        } catch { /* 권한 없음 */ }
      }
      const res = await call(c.token, "/search", { method: "POST", body: { filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 } }, this.f);
      const pages: any[] = (res.results ?? []).filter((p: any) => !p.archived && !p.in_trash);
      const mine: NotionSnapshot["mine"] = [];
      const recent: NotionSnapshot["recent"] = [];
      for (const p of pages) {
        const title = pageTitle(p);
        const url = String(p.url ?? "");
        const due = pageDue(p);
        if (meId && due && peopleIds(p).includes(meId) && !pageDone(p)) {
          const label = dueLabel(due, now);
          if (label) {
            mine.push({ title, due, label, url });
            notify({ source: "notion", key: `notion-due:${p.id}:${due.slice(0, 10)}:${label}`, account: "할 일", title: `${label} · ${title}`, body: `마감 ${due.slice(0, 10)}`, link: url });
          }
        }
        const edited = String(p.last_edited_time ?? "");
        if (edited > since) {
          recent.push({ title, at: edited, url });
          const by = p.last_edited_by?.id;
          if (!meId || by !== meId) notify({ source: "notion", key: `notion-edit:${p.id}:${edited}`, account: "수정됨", title, body: "페이지가 바뀌었어요", link: url, at: edited });
        }
      }
      // 최근 바뀐 페이지의 새 댓글(많으면 앞 15개 페이지만 — 노션 요청 한도)
      for (const r of recent.slice(0, 15)) {
        const pid = pages.find((p) => String(p.url) === r.url)?.id;
        if (!pid) continue;
        try {
          const cm = await call(c.token, `/comments?block_id=${encodeURIComponent(pid)}&page_size=50`, {}, this.f);
          for (const x of cm.results ?? []) {
            if (String(x.created_time ?? "") <= since || (meId && x.created_by?.id === meId)) continue;
            const text = (x.rich_text ?? []).map((t: any) => t?.plain_text ?? "").join("").trim();
            notify({ source: "notion", key: `notion-comment:${x.id}`, account: "댓글", title: r.title, body: text || "새 댓글", link: r.url, at: x.created_time });
          }
        } catch { /* 댓글 읽기 권한이 없으면 건너뛴다 */ }
      }
      this.writeState({ ...st, lastCheck: now.toISOString(), ...(meId ? { meId } : {}) });
      snapshot = { phase: "ok", at: now.toISOString(), mine, recent, workspace: st.workspace };
    } catch (e: any) {
      snapshot = { ...snapshot, phase: "failed", at: now.toISOString(), error: String(e?.message ?? e) };
    } finally {
      this.running = false;
      this.onChange?.();
    }
    return snapshot;
  }
}

// ---- 연결·해제·상태(데몬 bus.notion) — config.json connectors.notion 에 열쇠를 둔다 ----
import { readConfigObject } from "./mail-connect.ts";
export function notionConnOf(configPath: string): NotionConn | undefined {
  try {
    const n = (readConfigObject(configPath) as any)?.connectors?.notion;
    return n && typeof n.token === "string" ? { token: n.token, ...(typeof n.email === "string" ? { email: n.email } : {}) } : undefined;
  } catch { return undefined; }
}
function saveConn(configPath: string, conn: NotionConn | null) {
  const cfg = (readConfigObject(configPath) as any) ?? {};
  const connectors = { ...(cfg.connectors ?? {}) };
  if (conn) connectors.notion = conn; else delete connectors.notion;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileAtomic(configPath, JSON.stringify({ ...cfg, connectors }, null, 2) + "\n", { mode: 0o600 });
}
export function notionApi(configPath: string, sync: NotionSync, f: Fetch = fetch) {
  return {
    status: () => {
      const c = notionConnOf(configPath);
      const s = notionSnapshot();
      return { connected: !!c, email: c?.email ?? "", phase: c ? s.phase : "off", at: s.at, error: s.error, mine: s.mine.length, recent: s.recent.length };
    },
    connect: async (b: unknown) => {
      const body = (b && typeof b === "object" ? b : {}) as { token?: unknown; email?: unknown };
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const email = typeof body.email === "string" && /^[^\s@]+@[^\s@]+$/.test(body.email.trim()) ? body.email.trim() : undefined;
      const p = await probeNotion(token, f);
      if (!p.ok) return p;
      saveConn(configPath, { token, ...(email ? { email } : {}) });
      const s = await sync.tick();
      return { ok: true, bot: p.bot, workspace: p.workspace, phase: s.phase, mine: s.mine.length, recent: s.recent.length, error: s.error };
    },
    disconnect: () => { saveConn(configPath, null); void sync.tick(); return { ok: true }; },
  };
}

// ---- 채팅 도구(ctx-tools): 노션 찾기·페이지 글 읽기(읽기 전용) ----
let toolConn: () => NotionConn | undefined = () => undefined;
export function setNotionToolConn(f: () => NotionConn | undefined) { toolConn = f; }
export async function notionSearchText(query: string, f: Fetch = fetch): Promise<string> {
  const c = toolConn();
  if (!c) return "(노션이 연결돼 있지 않다 — 설치 탭 「더 연결하기 → 노션」에서 연결)";
  const r = await call(c.token, "/search", { method: "POST", body: { query: String(query ?? "").slice(0, 200), page_size: 15, sort: { direction: "descending", timestamp: "last_edited_time" } } }, f);
  const xs = (r.results ?? []).map((p: any) => `- ${p.object === "database" ? (p.title ?? []).map((t: any) => t.plain_text).join("") || "(DB)" : pageTitle(p)} · id=${p.id} · ${String(p.last_edited_time ?? "").slice(0, 10)} · ${p.url ?? ""}`);
  return xs.length ? xs.join("\n") : "(찾은 페이지가 없다 — 그 페이지에 이 통합이 「연결」돼 있어야 보인다)";
}
export async function notionReadText(pageId: string, f: Fetch = fetch): Promise<string> {
  const c = toolConn();
  if (!c) return "(노션이 연결돼 있지 않다)";
  if (!/^[0-9a-f-]{32,36}$/i.test(String(pageId ?? ""))) return "(id 는 notion_search 결과의 id=… 를 쓴다)";
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 4 && out.join("\n").length < 12000; i++) {
    const r = await call(c.token, `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, {}, f);
    for (const b of r.results ?? []) {
      const v = b?.[b?.type];
      const text = (v?.rich_text ?? []).map((t: any) => t?.plain_text ?? "").join("");
      if (b.type === "to_do") out.push(`${v?.checked ? "[x]" : "[ ]"} ${text}`);
      else if (/^heading_/.test(b.type)) out.push(`\n# ${text}`);
      else if (b.type === "bulleted_list_item" || b.type === "numbered_list_item") out.push(`- ${text}`);
      else if (text) out.push(text);
      else if (b.type === "child_page") out.push(`(하위 페이지: ${v?.title ?? ""} · id=${b.id})`);
    }
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out.join("\n").slice(0, 12000) || "(글이 없는 페이지)";
}
