// 읽기 전용 GitHub 도구: 로그인된 gh CLI 로 PR·이슈·CI 를 본다. 채팅·브리핑·할 일 팝오버에 SDK 인프로세스 MCP 서버(gh)로 붙는다.
// 안전: 쓰기 명령은 아예 없다. argv 는 고정 틀 + 엄격히 검증한 값만(셸 없음, '-'로 시작하는 값 거부). 비동기 execFile(이벤트 루프 안 막음)·타임아웃·출력 상한.
import { execFile } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "./config.ts";

export const GH_SERVER = "gh";
export const GH_TOOL_NAMES = ["pr_view", "pr_diff", "pr_list", "search_prs", "search_issues", "issue_view", "repo_find", "run_list", "run_view"] as const;
export const GH_HINT = "- GitHub PR·이슈·CI는 gh 도구로 직접 확인한다(읽기 전용). 레포 이름만 알면 repo_find로 owner를 찾는다. 답에는 PR·이슈 링크(url)를 단다.";

export const GH_TIMEOUT_MS = 20_000;
export const GH_MAX_OUT = 30_000; // 모델에 돌려줄 글자 수 상한
const RAW_MAX_BUFFER = 8 * 1024 * 1024; // gh 원출력 상한(넘으면 잘라서 씀)

// ── 검증 ─────────────────────────────────────────────
export class GhInputError extends Error {}
const bad = (why: string): never => { throw new GhInputError(why); };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NAME_RE = /^[\w.-]+$/;
const LOGIN_RE = /^(@me|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;
const BRANCH_RE = /^[\w./-]+$/;
export const QUERY_MAX = 256;

export function vRepo(v: unknown): string {
  if (typeof v !== "string" || !REPO_RE.test(v) || v.startsWith("-") || v.includes("..")) bad(`repo 는 owner/name 형식이어야 함: ${String(v).slice(0, 80)}`);
  return v as string;
}
export function vName(v: unknown): string {
  if (typeof v !== "string" || !NAME_RE.test(v) || v.startsWith("-") || v.length > 100) bad(`레포 이름이 이상함: ${String(v).slice(0, 80)}`);
  return v as string;
}
export function vNum(v: unknown, what = "number"): string {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) bad(`${what} 는 양의 정수여야 함`);
  return String(n);
}
export function vLimit(v: unknown, def = 20, max = 50): string {
  if (v === undefined || v === null) return String(def);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) bad("limit 는 1 이상 정수");
  return String(Math.min(v as number, max));
}
export function vLogin(v: unknown): string {
  if (typeof v !== "string" || !LOGIN_RE.test(v)) bad(`author 가 이상함: ${String(v).slice(0, 40)}`);
  return v as string;
}
export function vBranch(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 200 || v.startsWith("-") || !BRANCH_RE.test(v) || v.includes("..")) bad(`branch 가 이상함: ${String(v).slice(0, 80)}`);
  return v as string;
}
export function vState(v: unknown, allowed: readonly string[]): string {
  if (typeof v !== "string" || !allowed.includes(v)) bad(`state 는 ${allowed.join("|")} 중 하나`);
  return v as string;
}
// 검색어: 길이 상한, 제어문자 없음, 공백으로 나눈 낱말 하나하나가 '-'로 시작하면 거부.
// 예외: GitHub 제외 한정자(-label:bug)는 '--' 뒤에 놓여 gh 가 플래그로 읽지 않으므로 '-이름:값' 꼴만 허용.
export function vQueryTokens(v: unknown): string[] {
  if (typeof v !== "string") return bad("query 는 문자열");
  const q = (v as string).trim();
  if (!q) bad("query 가 비었음");
  if (q.length > QUERY_MAX) bad(`query 는 ${QUERY_MAX}자 이하`);
  if (/[\u0000-\u001f\u007f]/.test(q)) bad("query 에 제어문자");
  const toks = q.split(/\s+/);
  for (const t of toks) {
    if (t.startsWith("--")) bad(`query 에 플래그 불가: ${t}`);
    if (t.startsWith("-") && !/^-[A-Za-z][\w-]*:[^\s-][^\s]*$/.test(t)) bad(`query 에 플래그 불가: ${t}`);
  }
  return toks;
}

// ── argv 틀(전부 읽기 전용) ─────────────────────────
const PR_VIEW_FIELDS = "number,title,state,url,author,body,createdAt,mergedAt,mergedBy,baseRefName,headRefName,additions,deletions,changedFiles,files,reviews,comments,labels";
const PR_LIST_FIELDS = "number,title,state,url,author,createdAt,updatedAt,mergedAt,headRefName,baseRefName,isDraft";
const SEARCH_FIELDS = "number,title,state,url,repository,author,createdAt,updatedAt,closedAt,isDraft,labels,commentsCount";
const ISSUE_FIELDS = "number,title,state,url,author,body,createdAt,closedAt,labels,assignees,comments";
const RUN_LIST_FIELDS = "databaseId,displayTitle,status,conclusion,workflowName,headBranch,headSha,event,createdAt,updatedAt,url";
const RUN_VIEW_FIELDS = "databaseId,displayTitle,status,conclusion,workflowName,headBranch,headSha,event,createdAt,updatedAt,url,jobs";
const REPO_FIELDS = "nameWithOwner,url,description,isArchived,pushedAt";

export const argv = {
  prView: (a: { repo: unknown; number: unknown }) => ["pr", "view", vNum(a.number), "-R", vRepo(a.repo), "--json", PR_VIEW_FIELDS],
  prDiff: (a: { repo: unknown; number: unknown }) => ["pr", "diff", vNum(a.number), "-R", vRepo(a.repo), "--color", "never"],
  prList: (a: { repo: unknown; state?: unknown; author?: unknown; search?: unknown; limit?: unknown }) => [
    "pr", "list", "-R", vRepo(a.repo),
    "--state", a.state === undefined ? "open" : vState(a.state, ["open", "closed", "merged", "all"]),
    ...(a.author !== undefined ? ["--author", vLogin(a.author)] : []),
    ...(a.search !== undefined ? [`--search=${vQueryTokens(a.search).join(" ")}`] : []),
    "--limit", vLimit(a.limit), "--json", PR_LIST_FIELDS,
  ],
  // '--' 뒤는 gh 가 플래그로 읽지 않는다(검색 낱말만)
  searchPrs: (a: { query: unknown; limit?: unknown }) => ["search", "prs", "--limit", vLimit(a.limit), "--json", SEARCH_FIELDS, "--", ...vQueryTokens(a.query)],
  searchIssues: (a: { query: unknown; limit?: unknown }) => ["search", "issues", "--limit", vLimit(a.limit), "--json", SEARCH_FIELDS, "--", ...vQueryTokens(a.query)],
  issueView: (a: { repo: unknown; number: unknown }) => ["issue", "view", vNum(a.number), "-R", vRepo(a.repo), "--json", ISSUE_FIELDS],
  runList: (a: { repo: unknown; branch?: unknown; limit?: unknown }) => [
    "run", "list", "-R", vRepo(a.repo), ...(a.branch !== undefined ? ["--branch", vBranch(a.branch)] : []), "--limit", vLimit(a.limit, 10, 30), "--json", RUN_LIST_FIELDS,
  ],
  runView: (a: { repo: unknown; id: unknown }) => ["run", "view", vNum(a.id, "id"), "-R", vRepo(a.repo), "--json", RUN_VIEW_FIELDS],
  repoView: (repo: string) => ["repo", "view", vRepo(repo), "--json", REPO_FIELDS],
  userOrgs: () => ["api", "user/orgs", "--paginate", "--jq", ".[].login"],
  userLogin: () => ["api", "user", "--jq", ".login"],
  repoSearch: (name: string) => ["search", "repos", "--limit", "20", "--json", "fullName,url,description,isArchived", "--", vName(name), "in:name"],
  authStatus: () => ["auth", "status"],
};

// 고정 틀 밖 argv 는 실행하지 않는다(마지막 방어선): 첫 두 낱말이 허용 목록에 있어야 한다
const READ_COMMANDS = new Set(["pr view", "pr diff", "pr list", "search prs", "search issues", "search repos", "issue view", "run list", "run view", "repo view", "api user/orgs", "api user", "auth status"]);
export function isAllowedArgv(args: string[]): boolean {
  return READ_COMMANDS.has(`${args[0]} ${args[1]}`) && args.every((a) => typeof a === "string" && !/[\u0000]/.test(a));
}

// ── 실행 ─────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

export function capOutput(s: string, max = GH_MAX_OUT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(출력이 길어 ${s.length - max}자 잘림 — 전체는 링크로)`;
}

// JSON 은 통째로 자르면 깨지니 긴 문자열·긴 배열을 먼저 줄인다
export function shrinkJson(v: unknown, strMax = 4000, arrMax = 60): unknown {
  if (typeof v === "string") return v.length > strMax ? `${v.slice(0, strMax)}…(${v.length - strMax}자 잘림)` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, arrMax).map((x) => shrinkJson(x, strMax, arrMax));
    if (v.length > arrMax) out.push(`…(${v.length - arrMax}개 더)`);
    return out;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrinkJson(x, strMax, arrMax)]));
  return v;
}

export type GhOpts = { bin?: string; timeoutMs?: number; maxOut?: number };
export type GhResult = { ok: boolean; out: string; err?: string };

export function runGh(args: string[], o: GhOpts = {}): Promise<GhResult> {
  if (!isAllowedArgv(args)) return Promise.resolve({ ok: false, out: "", err: `허용되지 않은 gh 명령: ${args.slice(0, 2).join(" ")}` });
  return new Promise((resolve) => {
    execFile(o.bin ?? "gh", args, {
      timeout: o.timeoutMs ?? GH_TIMEOUT_MS,
      maxBuffer: RAW_MAX_BUFFER,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0", GH_FORCE_TTY: "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", PAGER: "cat" },
    }, (e, stdout, stderr) => {
      const out = stripAnsi(String(stdout ?? ""));
      if (!e) return resolve({ ok: true, out });
      const code = (e as any).code;
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: true, out }); // 너무 길면 앞부분만
      const why = (e as any).killed || (e as any).signal === "SIGTERM" ? `시간 초과(${Math.round((o.timeoutMs ?? GH_TIMEOUT_MS) / 1000)}초)` : stripAnsi(String(stderr ?? "")).trim() || String(e.message);
      resolve({ ok: false, out, err: why.slice(0, 1000) });
    });
  });
}

// gh 가 로그인돼 있는지(비동기). 데몬 시작 때 한 번
let probed: boolean | undefined;
let probing: Promise<boolean> | undefined;
export function probeGh(o: GhOpts = {}): Promise<boolean> {
  probing ??= runGh(argv.authStatus(), { ...o, timeoutMs: 10_000 }).then((r) => (probed = r.ok)).catch(() => (probed = false));
  return probing;
}
export function _resetGhProbe(v?: boolean) { probed = v; probing = v === undefined ? undefined : Promise.resolve(v); }

// 켜짐 여부: 설정이 정하면 그대로, 아니면 시작 때 gh auth status 결과(아직 모르면 꺼짐)
export function ghEnabled(cfg: Pick<Config, "github">): boolean {
  const e = cfg.github?.enabled;
  return e === undefined ? probed === true : e;
}

// ── 도구 ─────────────────────────────────────────────
type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function runJson(args: string[], o: GhOpts): Promise<Text> {
  const r = await runGh(args, o);
  if (!r.ok) return text(`gh 실패: ${r.err}`, true);
  let body = r.out.trim();
  try { body = JSON.stringify(shrinkJson(JSON.parse(body)), null, 1); } catch {}
  return text(capOutput(body, o.maxOut));
}

// 레포 이름 → owner/name. 내 계정·소속 org 마다 gh repo view(병렬), 없으면 gh search repos. 결과는 기억한다
const orgCache = new Map<string, Promise<string[]>>();
const repoCache = new Map<string, { at: number; v: unknown }>();
const REPO_TTL = 6 * 3600e3;
export function _clearGhCache() { orgCache.clear(); repoCache.clear(); }

async function owners(o: GhOpts): Promise<string[]> {
  const key = o.bin ?? "gh";
  if (!orgCache.has(key)) {
    const p = Promise.all([runGh(argv.userLogin(), o), runGh(argv.userOrgs(), o)]).then(([me, orgs]) => {
      const list = [...(me.ok ? me.out.split("\n") : []), ...(orgs.ok ? orgs.out.split("\n") : [])].map((s) => s.trim()).filter((s) => NAME_RE.test(s));
      if (!list.length) orgCache.delete(key); // 실패는 기억하지 않는다
      return [...new Set(list)];
    });
    orgCache.set(key, p);
  }
  return orgCache.get(key)!;
}

export async function repoFind(name: unknown, o: GhOpts = {}): Promise<{ name: string; matches: unknown[]; searched: string[] }> {
  const n = typeof name === "string" && name.includes("/") ? vRepo(name) : vName(name);
  const hit = repoCache.get(`${o.bin ?? "gh"}|${n.toLowerCase()}`);
  if (hit && Date.now() - hit.at < REPO_TTL) return hit.v as any;
  const base = n.includes("/") ? n.split("/")[1] : n;
  const own = n.includes("/") ? [n.split("/")[0]] : await owners(o);
  const views = await Promise.all(own.map(async (ow) => {
    const r = await runGh(argv.repoView(`${ow}/${base}`), o);
    if (!r.ok) return undefined;
    try { return JSON.parse(r.out); } catch { return undefined; }
  }));
  let matches: unknown[] = views.filter(Boolean);
  if (!matches.length) {
    const r = await runGh(argv.repoSearch(base), o);
    try {
      const all = r.ok ? (JSON.parse(r.out) as { fullName: string }[]) : [];
      matches = all.filter((x) => x.fullName?.split("/")[1]?.toLowerCase() === base.toLowerCase());
      if (!matches.length) matches = all.slice(0, 10);
    } catch {}
  }
  const v = { name: n, matches, searched: own };
  if (matches.length) repoCache.set(`${o.bin ?? "gh"}|${n.toLowerCase()}`, { at: Date.now(), v });
  return v;
}

// 각 도구의 실행 함수(테스트·라이브 점검에서 직접 부른다)
export function ghHandlers(o: GhOpts = {}) {
  const guard = async (fn: () => Promise<Text>): Promise<Text> => {
    try { return await fn(); } catch (e: any) { return text(e instanceof GhInputError ? `입력 거부: ${e.message}` : `gh 도구 오류: ${String(e?.message ?? e)}`, true); }
  };
  return {
    pr_view: (a: { repo: string; number: number }) => guard(() => runJson(argv.prView(a), o)),
    pr_diff: (a: { repo: string; number: number }) => guard(async () => {
      const r = await runGh(argv.prDiff(a), o);
      return r.ok ? text(capOutput(r.out, o.maxOut)) : text(`gh 실패: ${r.err}`, true);
    }),
    pr_list: (a: { repo: string; state?: string; author?: string; search?: string; limit?: number }) => guard(() => runJson(argv.prList(a), o)),
    search_prs: (a: { query: string; limit?: number }) => guard(() => runJson(argv.searchPrs(a), o)),
    search_issues: (a: { query: string; limit?: number }) => guard(() => runJson(argv.searchIssues(a), o)),
    issue_view: (a: { repo: string; number: number }) => guard(() => runJson(argv.issueView(a), o)),
    repo_find: (a: { name: string }) => guard(async () => {
      const r = await repoFind(a.name, o);
      return text(capOutput(JSON.stringify(r, null, 1), o.maxOut), !r.matches.length);
    }),
    run_list: (a: { repo: string; branch?: string; limit?: number }) => guard(() => runJson(argv.runList(a), o)),
    run_view: (a: { repo: string; id: number }) => guard(() => runJson(argv.runView(a), o)),
  };
}

const RO = { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } };
const repo = z.string().describe("owner/name (예: octo-org/infra-manifests). owner 를 모르면 repo_find 먼저");
const num = z.number().int().positive();
const limit = z.number().int().min(1).max(50).optional();

// 쿼리마다 새로 만든다(MCP 서버 인스턴스는 한 연결에만 붙는다)
export function ghMcpServer(cfg: Pick<Config, "github">) {
  const h = ghHandlers({ bin: cfg.github?.bin });
  return createSdkMcpServer({
    name: GH_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions: "읽기 전용 GitHub(gh CLI). 쓰기 명령은 없다.",
    tools: [
      tool("pr_view", "PR 하나의 제목·상태(merged 여부)·작성자·본문·변경 파일·리뷰·댓글·링크", { repo, number: num }, h.pr_view, RO),
      tool("pr_diff", "PR diff(길면 잘림)", { repo, number: num }, h.pr_diff, RO),
      tool("pr_list", "레포의 PR 목록", { repo, state: z.enum(["open", "closed", "merged", "all"]).optional(), author: z.string().optional().describe("GitHub 로그인 또는 @me"), search: z.string().optional().describe("GitHub 검색 한정자(예: 'label:bug')"), limit }, h.pr_list, RO),
      tool("search_prs", "GitHub 전체 PR 검색. GitHub 검색 문법(예: 'org:octo-org is:open author:@me 키워드', 'repo:o/n 1817')", { query: z.string(), limit }, h.search_prs, RO),
      tool("search_issues", "GitHub 전체 이슈 검색(검색 문법 같음)", { query: z.string(), limit }, h.search_issues, RO),
      tool("issue_view", "이슈 하나의 제목·상태·본문·댓글·링크", { repo, number: num }, h.issue_view, RO),
      tool("repo_find", "레포 이름만 알 때 owner/name 찾기(내 계정·소속 org)", { name: z.string() }, h.repo_find, RO),
      tool("run_list", "GitHub Actions 실행 목록(CI 상태)", { repo, branch: z.string().optional(), limit }, h.run_list, RO),
      tool("run_view", "GitHub Actions 실행 하나(잡·결론)", { repo, id: num }, h.run_view, RO),
    ],
  });
}
