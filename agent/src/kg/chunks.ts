// 지식그래프 추출용 청크: 세션(Claude Code·Codex, 서브에이전트 포함)과 Slack 메시지를 순서·시각을 지켜 ~7천 자로 자른다.
//
// 청크 경계는 앞에서부터 탐욕적으로 정해진다 → 세션·대화에 뒤로 내용이 붙어도 앞 청크의 텍스트(해시)는 그대로라
// 이미 추출한 청크를 다시 돌리지 않는다. 바뀐 건 마지막 청크(와 새 청크)뿐.
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { Store } from "../store.ts";
import { IS_WIN, winNorm } from "../plat.ts";
import { permalinkOf } from "../ingest/slack.ts";

export const CHUNK_TARGET = 7000;
const MAX_PROMPT = 4000, MAX_ASSISTANT = 2500, MAX_SUB_TASK = 1500, MAX_SUB_TEXT = 1500, MAX_TOOLS_LINE = 400;

export type ChunkSource = "sessions" | "slack";
export type ChunkStatus = "pending" | "filtered" | "done" | "error";
export type Chunk = {
  id: string;
  source: ChunkSource;
  ref: string;          // 근거 노드 id: session:<id> | message:<ch>:<ts>
  part: number;
  label: string;        // 사람이 읽는 출처(세션 cwd·도구 / Slack 채널)
  text: string;
  start: string;        // ISO
  end: string;          // ISO
  link?: string;        // Slack permalink
  meta: Record<string, unknown>; // cwd, tool, channel, thread …
};
export type ChunkRow = Chunk & { hash: string; status: ChunkStatus; work?: boolean; reason?: string; attempts: number; costUsd: number };

export type Item = { at: string; text: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kg_chunks (id TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, part INTEGER NOT NULL, label TEXT NOT NULL,
  text TEXT NOT NULL, hash TEXT NOT NULL, chars INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, link TEXT, meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', work INTEGER, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS kg_chunks_status ON kg_chunks(status, source, end);
CREATE TABLE IF NOT EXISTS kg_marks (path TEXT PRIMARY KEY, mtime REAL NOT NULL);
`;

export function ensureChunkTables(store: Store) {
  store.db.exec(SCHEMA);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const hashText = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// KST 기준 "MM-DD HH:MM"
export function kst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600e3);
  return isNaN(d.getTime()) ? "?" : d.toISOString().slice(5, 16).replace("T", " ");
}
const kstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);

// 하네스가 끼워 넣은 태그 블록은 지운다
function stripInjected(s: string): string {
  return s.replace(/<(system-reminder|local-command-stdout|command-message|command-args|environment_context|user_instructions)[^>]*>[\s\S]*?<\/\1>/g, "").trim();
}
function isHumanText(s: string): boolean {
  const t = s.trimStart();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("# AGENTS.md") && !t.startsWith("Caveat:") && !t.startsWith("[Request interrupted");
}
function textOf(content: unknown, kind: string): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((b: any) => b?.type === kind && typeof b.text === "string").map((b: any) => b.text);
  return parts.length ? parts.join("\n") : undefined;
}

// 도구 호출은 경로·명령·URL 한 줄만
export function toolExcerpt(name: string, input: any): string | undefined {
  const i = input ?? {};
  switch (name) {
    case "Bash": return i.command ? `$ ${clip(oneLine(String(i.command)), 160)}` : undefined;
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": {
      const p = i.file_path ?? i.notebook_path;
      return p ? `${name} ${p}` : undefined;
    }
    case "WebFetch": return i.url ? `fetch ${i.url}` : undefined;
    case "WebSearch": return i.query ? `search "${clip(String(i.query), 100)}"` : undefined;
    case "Agent": case "Task": return i.description ? `agent: ${clip(oneLine(String(i.description)), 100)}` : undefined;
    case "exec_command": case "shell": case "exec": {
      const c = i.cmd ?? i.command ?? i.input;
      return c ? `$ ${clip(oneLine(Array.isArray(c) ? c.join(" ") : String(c)), 160)}` : undefined;
    }
    case "apply_patch": return `apply_patch`;
    default:
      return name.startsWith("mcp__") ? name.replace(/^mcp__/, "") : undefined; // Read·Grep·Glob·TodoWrite 같은 잡음은 뺀다
  }
}

export type ParsedSession = { id: string; tool: "claude" | "codex"; cwd?: string; items: Item[] };

// 사람 프롬프트 + 어시스턴트 텍스트 + 도구 한 줄 요약(연속된 건 한 줄로). 도구 결과는 버린다.
export function claudeItems(raw: string, fallbackId: string, opts: { subagent?: boolean } = {}): ParsedSession {
  const s: ParsedSession = { id: fallbackId, tool: "claude", items: [] };
  let tools: string[] = [], toolsAt = "", firstUser = true;
  const flush = () => {
    if (tools.length) s.items.push({ at: toolsAt, text: `도구: ${clip(tools.join("; "), MAX_TOOLS_LINE)}` });
    tools = [];
  };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId && !opts.subagent) s.id = e.sessionId;
    if (e.cwd) s.cwd ??= e.cwd;
    const at = e.timestamp ?? "";
    if (e.type === "user" && !e.isMeta) {
      const t = textOf(e.message?.content, "text");
      if (!t) continue;
      if (opts.subagent && firstUser) {
        firstUser = false;
        flush();
        s.items.push({ at, text: `상위 에이전트 지시: ${clip(stripInjected(t), MAX_SUB_TASK)}` });
        continue;
      }
      const h = stripInjected(t);
      if (!opts.subagent && isHumanText(t) && h) { flush(); s.items.push({ at, text: `사용자: ${clip(h, MAX_PROMPT)}` }); }
    }
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b?.type === "text" && b.text?.trim()) {
          flush();
          s.items.push({ at, text: `AI: ${clip(b.text.trim(), opts.subagent ? MAX_SUB_TEXT : MAX_ASSISTANT)}` });
        } else if (b?.type === "tool_use") {
          const x = toolExcerpt(b.name, b.input);
          if (x) { if (!tools.length) toolsAt = at; tools.push(x); }
        }
      }
    }
  }
  flush();
  return s;
}

export function codexItems(raw: string, fallbackId: string): ParsedSession {
  const s: ParsedSession = { id: fallbackId, tool: "codex", items: [] };
  let tools: string[] = [], toolsAt = "";
  const flush = () => {
    if (tools.length) s.items.push({ at: toolsAt, text: `도구: ${clip(tools.join("; "), MAX_TOOLS_LINE)}` });
    tools = [];
  };
  // Codex Desktop이 Claude Code 세션을 가져온 턴(turn_id external-import-*)은 원본이 ~/.claude/projects에 있으니 뺀다
  let imported = false;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    const at = e.timestamp ?? "";
    if (e.type === "session_meta") { s.id = p.id ?? s.id; s.cwd ??= p.cwd; }
    if (e.type === "turn_context" && p.cwd) s.cwd ??= p.cwd;
    if (e.type === "event_msg" && p.type === "task_started") imported = String(p.turn_id ?? "").startsWith("external-import");
    if (e.type !== "response_item" || imported) continue;
    if (p.type === "message" && p.role === "user") {
      const t = textOf(p.content, "input_text");
      if (t && isHumanText(t)) { flush(); s.items.push({ at, text: `사용자: ${clip(stripInjected(t), MAX_PROMPT)}` }); }
    } else if (p.type === "message" && p.role === "assistant") {
      const t = textOf(p.content, "output_text")?.trim();
      if (!t || t.startsWith("[external_agent_tool_result")) continue;
      const call = /^\[external_agent_tool_call: (\w+)\]\n([\s\S]*?)\[\/external_agent_tool_call\]/.exec(t);
      if (call) {
        const f = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(call[2])?.[1];
        const x = toolExcerpt(call[1], { command: f("command"), file_path: f("file"), url: f("url"), description: f("description"), query: f("query") });
        if (x) { if (!tools.length) toolsAt = at; tools.push(x); }
        continue;
      }
      flush();
      s.items.push({ at, text: `AI: ${clip(t, MAX_ASSISTANT)}` });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      let input: any = p.input ?? p.action;
      if (typeof p.arguments === "string") { try { input = JSON.parse(p.arguments); } catch { input = { command: p.arguments }; } }
      if (typeof input === "string") input = { input };
      const x = toolExcerpt(p.name ?? "shell", input);
      if (x) { if (!tools.length) toolsAt = at; tools.push(x); }
    }
  }
  flush();
  return s;
}

// 순서를 지키며 탐욕적으로 자른다. 항목 하나가 target보다 길면 그대로 한 청크.
export function packItems(items: Item[], target = CHUNK_TARGET): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [], len = 0;
  for (const it of items) {
    const n = it.text.length + 16;
    if (cur.length && len + n > target) { out.push(cur); cur = []; len = 0; }
    cur.push(it);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const render = (items: Item[]) => items.map((i) => `[${kst(i.at)}] ${i.text}`).join("\n");

export function sessionChunks(s: ParsedSession, groupKey: string, ref = `session:${s.id}`): Chunk[] {
  const items = s.items.filter((i) => i.text.trim());
  if (!items.some((i) => i.text.startsWith("사용자:") || i.text.startsWith("상위 에이전트 지시:"))) return [];
  return packItems(items).map((part, n) => ({
    id: `s:${groupKey}:${n}`, source: "sessions" as const, ref, part: n,
    label: `${s.tool === "codex" ? "Codex" : "Claude Code"} 세션 · ${s.cwd ?? "?"}${groupKey.includes("/sub:") ? " (서브에이전트)" : ""}`,
    text: render(part), start: firstAt(part), end: lastAt(part), meta: { cwd: s.cwd, tool: s.tool },
  }));
}
const firstAt = (xs: Item[]) => xs.find((x) => x.at)?.at ?? "";
const lastAt = (xs: Item[]) => [...xs].reverse().find((x) => x.at)?.at ?? "";

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

export type ScanResult = { files: number; changed: number; skipped: number; chunks: number; newOrChanged: number };

// 세션 디렉터리 전체를 훑어 청크 레지스트리에 반영한다(mtime이 바뀐 파일만 다시 읽음).
// skipCwdPrefixes: 데몬 자신의 세션(cwd가 CY_AGENT_HOME 아래)은 뺀다
export async function scanSessions(
  store: Store, dirs: { claude: string; codex: string }, opts: { skipCwdPrefixes?: string[]; yieldEvery?: number } = {},
): Promise<ScanResult> {
  ensureChunkTables(store);
  const skip = (cwd?: string) => !!cwd && (opts.skipCwdPrefixes ?? []).some((p) => p && (IS_WIN ? winNorm(cwd).startsWith(winNorm(p)) : cwd.startsWith(p))); // Windows: 대소문자·구분자 무시
  const r: ScanResult = { files: 0, changed: 0, skipped: 0, chunks: 0, newOrChanged: 0 };
  // 서브에이전트가 부모 cwd를 모를 수 있어 부모 cwd를 기억해 둔다
  const parentCwd = new Map<string, string | undefined>();
  const subagents: string[] = [];
  for (const [tool, dir] of [["claude", dirs.claude], ["codex", dirs.codex]] as const) {
    for await (const path of walkJsonl(dir)) {
      if (path.includes("/subagents/") || path.includes(`${sep}subagents${sep}`)) { subagents.push(path); continue; }
      r.files++;
      const res = await scanFile(store, path, tool, undefined, skip, parentCwd);
      if (res === "skip") r.skipped++;
      else if (res) { r.changed++; r.newOrChanged += res; }
      if (r.files % (opts.yieldEvery ?? 20) === 0) await new Promise((ok) => setImmediate(ok));
    }
  }
  for (const path of subagents) {
    r.files++;
    // <project>/<parentSessionId>/subagents/agent-<id>.jsonl
    const parent = basename(dirname(dirname(path)));
    const res = await scanFile(store, path, "claude", parent, skip, parentCwd);
    if (res === "skip") r.skipped++;
    else if (res) { r.changed++; r.newOrChanged += res; }
    if (r.files % (opts.yieldEvery ?? 20) === 0) await new Promise((ok) => setImmediate(ok));
  }
  r.chunks = Number((store.db.prepare("SELECT count(*) n FROM kg_chunks WHERE source = 'sessions'").get() as any).n);
  return r;
}

// 반환: 새로/바뀐 청크 수, "skip"(데몬 세션), 0(그대로)
async function scanFile(
  store: Store, path: string, tool: "claude" | "codex", parent: string | undefined,
  skip: (cwd?: string) => boolean, parentCwd: Map<string, string | undefined>,
): Promise<number | "skip"> {
  let mtime: number;
  try { mtime = (await stat(path)).mtimeMs; } catch { return 0; }
  const mark = (store.db.prepare("SELECT mtime FROM kg_marks WHERE path = ?").get(path) as any)?.mtime;
  if (mark === mtime) {
    if (!parent) parentCwd.set(basename(path, ".jsonl"), undefined);
    return 0;
  }
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch { return 0; }
  const id = basename(path, ".jsonl");
  const s = tool === "codex" ? codexItems(raw, id) : claudeItems(raw, id, { subagent: !!parent });
  const setMark = () => store.db.prepare("INSERT OR REPLACE INTO kg_marks (path, mtime) VALUES (?, ?)").run(path, mtime);
  if (!parent) parentCwd.set(id, s.cwd);
  const cwd = s.cwd ?? (parent ? parentCwd.get(parent) : undefined);
  if (skip(cwd) || (parent && skip(parentCwd.get(parent)))) { setMark(); return "skip"; }
  let chunks: Chunk[];
  if (parent) {
    s.cwd = cwd;
    chunks = sessionChunks(s, `${parent}/sub:${id}`, `session:${parent}`);
  } else {
    chunks = sessionChunks(s, s.id);
  }
  const n = upsertChunks(store, chunks);
  setMark();
  return n;
}

// 같은 해시면 상태 유지, 바뀌었으면 pending으로 되돌린다. 반환: 새로/바뀐 수
export function upsertChunks(store: Store, chunks: Chunk[]): number {
  ensureChunkTables(store);
  let n = 0;
  const get = store.db.prepare("SELECT hash FROM kg_chunks WHERE id = ?");
  const put = store.db.prepare(`INSERT INTO kg_chunks (id, source, ref, part, label, text, hash, chars, start, end, link, meta, status, attempts, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    ON CONFLICT(id) DO UPDATE SET ref = excluded.ref, label = excluded.label, text = excluded.text, hash = excluded.hash, chars = excluded.chars,
      start = excluded.start, end = excluded.end, link = excluded.link, meta = excluded.meta, status = 'pending', attempts = 0, updated = excluded.updated`);
  const now = new Date().toISOString();
  for (const c of chunks) {
    const h = hashText(c.text);
    if ((get.get(c.id) as any)?.hash === h) continue;
    put.run(c.id, c.source, c.ref, c.part, c.label, c.text, h, c.text.length, c.start || now, c.end || c.start || now, c.link ?? null, JSON.stringify(c.meta), now);
    n++;
  }
  return n;
}

export function rowToChunk(r: any): ChunkRow {
  return {
    id: r.id, source: r.source, ref: r.ref, part: r.part, label: r.label, text: r.text, start: r.start, end: r.end,
    link: r.link ?? undefined, meta: JSON.parse(r.meta ?? "{}"), hash: r.hash, status: r.status,
    work: r.work == null ? undefined : !!r.work, reason: r.reason ?? undefined, attempts: r.attempts, costUsd: r.cost,
  };
}

// ── Slack: 그래프의 message 노드 → 대화/스레드/날짜(KST)별 묶음 → 청크
// sinceIso가 있으면 그 뒤에 바뀐 메시지가 속한 묶음만 다시 만든다(증분)
export function buildSlackChunks(store: Store, opts: { sinceIso?: string } = {}): { groups: number; chunks: number; newOrChanged: number } {
  ensureChunkTables(store);
  const db = store.db;
  const teamUrl = (() => {
    try { return (db.prepare("SELECT value FROM slack_meta WHERE key = 'teamUrl'").get() as any)?.value as string | undefined; } catch { return undefined; }
  })();
  type M = { id: string; channel: string; ts: string; thread?: string; author: string; name: string; text: string; at: string };
  const rows = (db.prepare(`SELECT id, props, updated FROM nodes WHERE kind = 'message' ${opts.sinceIso ? "AND updated >= ?" : ""}`)
    .all(...(opts.sinceIso ? [opts.sinceIso] : [])) as any[]);
  const parse = (r: any): M => {
    const p = JSON.parse(r.props);
    const thread = p.thread_ts && p.thread_ts !== p.ts ? p.thread_ts : (p.replyCount ? p.ts : undefined);
    return { id: r.id, channel: p.channel, ts: p.ts, thread, author: p.author, name: p.authorName ?? p.author, text: String(p.text ?? ""), at: r.updated };
  };
  const groupKey = (m: M) => (m.thread ? `${m.channel}:t${m.thread}` : `${m.channel}:d${kstDay(m.at)}`);
  let msgs: M[] = rows.map(parse);
  if (opts.sinceIso) {
    // 바뀐 묶음 전체를 다시 읽는다
    const keys = new Set(msgs.map(groupKey));
    const chans = [...new Set(msgs.map((m) => m.channel))];
    msgs = [];
    for (const ch of chans) {
      for (const r of db.prepare("SELECT id, props, updated FROM nodes WHERE kind = 'message' AND json_extract(props, '$.channel') = ?").all(ch) as any[]) {
        const m = parse(r);
        if (keys.has(groupKey(m))) msgs.push(m);
      }
    }
  }
  const groups = new Map<string, M[]>();
  for (const m of msgs) {
    if (!m.channel || !m.ts) continue;
    const k = groupKey(m);
    const g = groups.get(k) ?? [];
    g.push(m);
    groups.set(k, g);
  }
  const labelCache = new Map<string, string>();
  const chLabel = (ch: string) => {
    if (!labelCache.has(ch)) labelCache.set(ch, store.node(`channel:${ch}`)?.label ?? ch);
    return labelCache.get(ch)!;
  };
  const nameCache = new Map<string, string>();
  const userName = (id: string) => {
    if (!nameCache.has(id)) nameCache.set(id, store.node(`person:${id}`)?.label ?? id);
    return nameCache.get(id)!;
  };
  const chunks: Chunk[] = [];
  for (const [k, g] of groups) {
    g.sort((a, b) => Number(a.ts) - Number(b.ts));
    const thread = g[0].thread;
    const items: Item[] = g.map((m) => ({
      at: m.at,
      text: `${m.name}: ${m.text.replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${userName(id)}`)}`,
    }));
    const parts = packItems(items);
    let i = 0;
    parts.forEach((part, n) => {
      const first = g[i];
      i += part.length;
      chunks.push({
        id: `k:${k}:${n}`, source: "slack", ref: thread ? `message:${first.channel}:${thread}` : first.id, part: n,
        label: `Slack ${chLabel(first.channel)}${thread ? " 스레드" : ""}`, text: render(part), start: firstAt(part), end: lastAt(part),
        link: permalinkOf(teamUrl, first.channel, thread ?? first.ts),
        meta: { channel: first.channel, thread, group: k },
      });
    });
  }
  const n = upsertChunks(store, chunks);
  return { groups: groups.size, chunks: chunks.length, newOrChanged: n };
}
