// repoRoots 아래 git 레포에서 "내" 커밋을 모은다(오늘 KST + 최근 5개). 실패한 레포는 조용히 건너뛴다.
import { execFile } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME_DIR, type Config } from "./config.ts";

export type Commit = { sha: string; subject: string; time: string };
export type RepoActivity = { path: string; name: string; branch?: string; commitsToday: Commit[]; recentCommits: Commit[] };

const SKIP = new Set(["node_modules", ".git"]);
const FMT = "%H%x1f%ae%x1f%an%x1f%cI%x1f%s";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) =>
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 4 << 20 }, (e, out) => (e ? fail(e) : ok(String(out)))));
}

// 오늘 0시(이 맥의 시간대)를 ISO 로. 이름은 예전 그대로(예전엔 KST 고정)
export function kstMidnight(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

// 깊이 2까지 .git 이 있는 디렉터리. 데몬 워크트리·node_modules·숨김 폴더는 건너뛴다.
export function findRepos(roots: string[], depth = 2): string[] {
  const skipPrefix = join(HOME_DIR, "worktrees");
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (dir.startsWith(skipPrefix)) return;
    if (existsSync(join(dir, ".git"))) out.push(dir);
    if (d >= depth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), d + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

type Who = { emails: Set<string>; names: Set<string> };

function parseLog(raw: string, who: Who): Commit[] {
  const out: Commit[] = [];
  for (const line of raw.split("\n")) {
    const [sha, email, name, time, subject] = line.split("\x1f");
    if (!sha || subject === undefined) continue;
    if (!who.emails.has(email.toLowerCase()) && !who.names.has(name)) continue;
    out.push({ sha: sha.slice(0, 7), subject, time: new Date(time).toISOString() });
  }
  return out;
}

export async function repoActivity(repo: string, base: Who, now = new Date()): Promise<RepoActivity | undefined> {
  try {
    const midnight = kstMidnight(now);
    const local = (await git(repo, ["config", "user.email"]).catch(() => "")).trim().toLowerCase();
    const who: Who = { emails: new Set([...base.emails, ...(local ? [local] : [])]), names: base.names };
    // -F: 패턴을 고정 문자열로(이메일의 . + 를 정규식으로 보지 않게). 정확한 일치는 parseLog에서 다시 거른다.
    const authors = ["-F", ...[...who.emails, ...who.names].map((a) => `--author=${a}`)];
    const [branch, today, recent] = await Promise.all([
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => undefined),
      // --since는 그보다 오래된 커밋을 만나면 탐색을 멈춘다(리베이스 등으로 날짜가 뒤섞이면 누락) — 하루 여유를 두고 아래에서 정확히 거른다
      git(repo, ["log", "--all", `--since=${new Date(Date.parse(midnight) - 864e5).toISOString()}`, ...authors, `--format=${FMT}`]),
      git(repo, ["log", "--all", "-n", "20", ...authors, `--format=${FMT}`]),
    ]);
    const since = Date.parse(midnight);
    const newestFirst = (x: Commit, y: Commit) => y.time.localeCompare(x.time);
    return {
      path: repo, name: basename(repo), branch: branch && branch !== "HEAD" ? branch : undefined,
      commitsToday: parseLog(today, who).filter((c) => Date.parse(c.time) >= since).sort(newestFirst),
      recentCommits: parseLog(recent, who).sort(newestFirst).slice(0, 5),
    };
  } catch {
    return undefined; // 커밋 없는 레포·깨진 레포
  }
}

let cache: { key: string; at: number; value: Promise<RepoActivity[]> } | undefined;

// 레포 전체 활동. 60초 캐시(패널이 자주 다시 불러도 git을 매번 돌리지 않게)
export function gitActivity(cfg: Pick<Config, "repoRoots" | "gitAuthor">, opts: { now?: Date; ttlMs?: number } = {}): Promise<RepoActivity[]> {
  const { now = new Date(), ttlMs = 60e3 } = opts;
  const key = JSON.stringify([cfg.repoRoots, cfg.gitAuthor, kstMidnight(now)]);
  if (cache && cache.key === key && Date.now() - cache.at < ttlMs) return cache.value;
  const who: Who = {
    emails: new Set([cfg.gitAuthor.email.toLowerCase()]),
    names: new Set([cfg.gitAuthor.name]),
  };
  const value = Promise.all(findRepos(cfg.repoRoots).map((r) => repoActivity(r, who, now)))
    .then((xs) => xs.filter((x): x is RepoActivity => !!x))
    .catch(() => []);
  cache = { key, at: Date.now(), value };
  return value;
}

export function clearGitCache() {
  cache = undefined;
}
