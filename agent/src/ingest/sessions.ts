// Claude Code / Codex 세션 JSONL → 지식그래프(session · project · file 노드).
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { Store } from "../store.ts";
import { IS_WIN, winNorm } from "../plat.ts";

export type SessionDigest = {
  id: string;
  tool: "claude" | "codex";
  cwd?: string;
  branch?: string;
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  lastAssistant?: string;
  started?: string;
  ended?: string;
  turns: number;
  files: string[];
};

const clip = (s: string | undefined, n: number) =>
  s === undefined ? undefined : s.length > n ? s.slice(0, n - 1) + "…" : s;

// 사람이 친 프롬프트만 — 하네스가 주입한 태그/지시문은 뺀다
function isHumanText(s: string): boolean {
  const t = s.trimStart();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("# AGENTS.md") && !t.startsWith("Caveat:");
}

function textOf(content: unknown, kind: "text" | "input_text" | "output_text"): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((b: any) => b?.type === kind && typeof b.text === "string").map((b: any) => b.text);
  return parts.length ? parts.join("\n") : undefined;
}

const linesOf = (raw: string | Iterable<string>) => (typeof raw === "string" ? raw.split("\n") : raw);

// JSONL 을 1MB 씩 읽어 한 줄씩 낸다. 통째로 읽지 않는다: 앱(Electron)의 Node 는 2GB 넘는 파일을
// readFileSync(…, "utf8") 하면 오류 대신 프로세스째 죽는다(PartitionAlloc OOM, SIGTRAP).
// 문자열로 만들 수 없을 만큼 긴 줄은 건너뛴다.
export function* readLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let parts: Buffer[] = [];
    let n: number;
    const flush = function* () {
      if (!parts.length) return;
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      try { yield line.toString("utf8"); } catch { /* 너무 긴 줄 */ }
    };
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      let start = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, start)) {
        parts.push(Buffer.from(buf.subarray(start, i)));
        yield* flush();
        start = i + 1;
      }
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)));
    }
    yield* flush();
  } finally {
    closeSync(fd);
  }
}

export function parseClaudeSession(raw: string | Iterable<string>, fallbackId: string): SessionDigest | undefined {
  const d: SessionDigest = { id: fallbackId, tool: "claude", turns: 0, files: [] };
  const files = new Set<string>();
  for (const line of linesOf(raw)) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId) d.id = e.sessionId;
    if (e.cwd) d.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== "HEAD") d.branch = e.gitBranch;
    if (e.timestamp) { d.started ??= e.timestamp; d.ended = e.timestamp; }
    if (e.type === "ai-title" && e.aiTitle) d.title ??= e.aiTitle;
    if (e.type === "custom-title" && e.customTitle) d.title = e.customTitle;
    if (e.type === "user" && !e.isMeta) {
      const t = textOf(e.message?.content, "text");
      if (t && isHumanText(t)) { d.firstPrompt ??= t; d.lastPrompt = t; d.turns++; }
    }
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b?.type === "text" && b.text?.trim()) d.lastAssistant = b.text;
        if (b?.type === "tool_use" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name)) {
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof p === "string") files.add(p);
        }
      }
    }
  }
  if (!d.turns) return undefined;
  d.files = [...files];
  return d;
}

export function parseCodexSession(raw: string | Iterable<string>, fallbackId: string): SessionDigest | undefined {
  const d: SessionDigest = { id: fallbackId, tool: "codex", turns: 0, files: [] };
  for (const line of linesOf(raw)) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) { d.started ??= e.timestamp; d.ended = e.timestamp; }
    const p = e.payload ?? {};
    if (e.type === "session_meta") { d.id = p.id ?? d.id; d.cwd = p.cwd ?? d.cwd; d.branch = p.git?.branch ?? d.branch; }
    if (e.type === "turn_context" && p.cwd) d.cwd = p.cwd;
    if (e.type === "response_item" && p.type === "message") {
      if (p.role === "user") {
        const t = textOf(p.content, "input_text");
        if (t && isHumanText(t)) { d.firstPrompt ??= t; d.lastPrompt = t; d.turns++; }
      } else if (p.role === "assistant") {
        const t = textOf(p.content, "output_text");
        if (t?.trim()) d.lastAssistant = t;
      }
    }
  }
  return d.turns ? d : undefined;
}

export function recordSession(store: Store, s: SessionDigest) {
  const sid = `session:${s.id}`;
  store.upsertNode(sid, "session", s.title ?? clip(s.firstPrompt, 60) ?? s.id, {
    tool: s.tool, cwd: s.cwd, branch: s.branch, started: s.started, turns: s.turns,
    firstPrompt: clip(s.firstPrompt, 400), lastPrompt: clip(s.lastPrompt, 400),
    lastAssistant: clip(s.lastAssistant, 600), files: s.files.slice(0, 30),
  }, s.ended);
  if (s.cwd) {
    const pid = `project:${s.cwd}`;
    store.upsertNode(pid, "project", basename(s.cwd), { path: s.cwd }, s.ended);
    store.link(sid, "in", pid);
  }
  for (const f of s.files) {
    const fid = `file:${f}`;
    store.upsertNode(fid, "file", basename(f), { path: f }, s.ended);
    store.link(sid, "edited", fid);
  }
}

function* walkJsonl(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

// 시사(cy-agent) 데이터 폴더 안에서 돈 세션인가 — 이 설치(skipCwdPrefix)뿐 아니라 같은 맥의 다른 설치
// (~/.cy-agent, ~/.cy-agent-xxx 등)의 두뇌 대화·자동수정 세션도 내 작업 기록이 아니다
export function isCyAgentCwd(cwd: string | undefined, skipCwdPrefix?: string, home = homedir()): boolean {
  if (!cwd) return false;
  // Windows: 드라이브 글자·대소문자·구분자가 섞여 기록될 수 있다(c:\ · C:/)
  const starts = (p: string) => (IS_WIN ? winNorm(cwd).startsWith(winNorm(p)) : cwd.startsWith(p));
  if (skipCwdPrefix && starts(skipCwdPrefix)) return true;
  return starts(join(home, ".cy-agent"));
}

// 바뀐 파일만 다시 읽는다(mtime 기준). 반환: 새로 반영한 세션 수
// skipCwdPrefix: 데몬 자신이 돌린 세션(브리핑·자동수정)은 기록에서 뺀다(같은 맥의 다른 시사 설치 폴더도 — isCyAgentCwd)
export function ingestSessions(
  store: Store, dirs: { claude: string; codex: string }, opts: { sinceMs?: number; skipCwdPrefix?: string } = {},
): number {
  const { sinceMs = 14 * 864e5, skipCwdPrefix } = opts;
  let n = 0;
  const cutoff = Date.now() - sinceMs;
  for (const [tool, dir] of [["claude", dirs.claude], ["codex", dirs.codex]] as const) {
    for (const path of walkJsonl(dir)) {
      if (path.includes("/subagents/") || path.includes(`${sep}subagents${sep}`)) continue; // 서브에이전트 트랜스크립트는 부모 세션에 포함
      let mtime: number;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      if (mtime < cutoff || store.markOf(path) === mtime) continue;
      const id = basename(path, ".jsonl");
      let s: SessionDigest | undefined;
      try { s = tool === "claude" ? parseClaudeSession(readLines(path), id) : parseCodexSession(readLines(path), id); } catch { continue; }
      if (s && !isCyAgentCwd(s.cwd, skipCwdPrefix)) { recordSession(store, s); n++; }
      store.setMark(path, mtime);
    }
  }
  return n;
}
