// GitHub 연동(로그인된 gh CLI): 3분마다
//  · 알림(나를 부름·리뷰 요청·내 PR/이슈에 새 댓글·배정 등, participating) → 알림함 「GitHub」 + [답장](PR·이슈 댓글)
//  · 내 열린 PR 중 승인돼 머지할 수 있는 것 → 알림함 「머지할 수 있어요」 + [머지]
// 쓰기는 사용자가 카드에서 직접 누른 것만: 댓글 달기(gh api …/comments) · 머지(gh pr merge). argv 는 고정 틀 + 검증한 값만(셸 없음).
import { execFile } from "node:child_process";
import { notify } from "./inbox.ts";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const okRepo = (r: unknown): r is string => typeof r === "string" && REPO_RE.test(r) && !r.startsWith("-") && !r.includes("..");
export const okNum = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

type Gh = (args: string[], input?: string) => Promise<string>;
export const runGh: Gh = (args, input) => new Promise((resolve, reject) => {
  const p = execFile("gh", args, { timeout: 30e3, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, out, errOut) => {
    if (err) reject(new Error(String(errOut || err.message).trim().split("\n").slice(-2).join(" ").slice(0, 300)));
    else resolve(String(out));
  });
  if (input !== undefined) { p.stdin?.write(input); p.stdin?.end(); }
});

const REASON: Record<string, string> = {
  review_requested: "리뷰 요청", mention: "나를 불렀어요", team_mention: "팀을 불렀어요", author: "내 글에 새 소식", comment: "새 댓글",
  assign: "나에게 배정", state_change: "상태 바뀜", ci_activity: "CI 결과", approval_requested: "승인 요청", security_alert: "보안 알림",
};
// api.github.com/repos/o/r/pulls/12 → github.com/o/r/pull/12 (issues 는 그대로)
export function htmlUrl(api: string | null | undefined, repo: string): string {
  const m = /repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/?#]+)/.exec(String(api ?? ""));
  if (!m) return `https://github.com/${repo}`;
  return `https://github.com/${m[1]}/${m[2] === "pulls" ? "pull" : m[2] === "commits" ? "commit" : m[2]}/${m[3]}`;
}
const numberOf = (api: string | null | undefined): number | undefined => {
  const m = /\/(?:pulls|issues)\/(\d+)/.exec(String(api ?? ""));
  return m ? Number(m[1]) : undefined;
};

export type GithubAct = { merge?: { repo: string; number: number }; reply?: { kind: "github"; repo: string; number: number } };

export class GithubSync {
  private gh: Gh;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(gh: Gh = runGh) { this.gh = gh; }

  schedule(everyMs = 3 * 60e3): () => void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    return () => { if (this.timer) clearInterval(this.timer); };
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const notes = JSON.parse(await this.gh(["api", "notifications?participating=true&per_page=50"]));
      for (const n of Array.isArray(notes) ? notes : []) {
        const repo = String(n?.repository?.full_name ?? "");
        if (!okRepo(repo)) continue;
        const sub = n.subject ?? {};
        const num = numberOf(sub.url);
        let body = "";
        if (sub.latest_comment_url && /\/comments\//.test(sub.latest_comment_url)) {
          try {
            const c = JSON.parse(await this.gh(["api", String(sub.latest_comment_url).replace("https://api.github.com/", "")]));
            body = `${c?.user?.login ?? ""}: ${String(c?.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
          } catch { /* 댓글을 못 읽어도 알림은 */ }
        }
        const isPr = sub.type === "PullRequest";
        const act: GithubAct = num && (isPr || sub.type === "Issue") ? { reply: { kind: "github", repo, number: num } } : {};
        notify({
          source: "github", key: `gh:${n.id}:${n.updated_at}`, account: repo,
          title: `${REASON[n.reason] ?? n.reason ?? "알림"} · ${sub.title ?? ""}`, body, link: htmlUrl(sub.url, repo), at: n.updated_at, act,
        });
      }
      // 내 열린 PR 중 승인된 것 → 머지할 수 있으면 [머지]
      const q = encodeURIComponent("is:pr is:open author:@me review:approved archived:false");
      const found = JSON.parse(await this.gh(["api", `search/issues?q=${q}&per_page=20`]));
      for (const it of found?.items ?? []) {
        const repo = String(it.repository_url ?? "").replace("https://api.github.com/repos/", "");
        if (!okRepo(repo) || !okNum(it.number)) continue;
        let pr: any;
        try { pr = JSON.parse(await this.gh(["api", `repos/${repo}/pulls/${it.number}`])); } catch { continue; }
        if (pr?.state !== "open" || pr?.draft || pr?.mergeable !== true || !["clean", "unstable", "has_hooks"].includes(pr?.mergeable_state)) continue;
        notify({
          source: "github", key: `gh-merge:${repo}#${it.number}:${pr.head?.sha ?? ""}`, account: repo,
          title: `머지할 수 있어요 · ${it.title}`, body: `#${it.number} 승인됨 · ${pr.mergeable_state === "clean" ? "검사 통과" : "검사 일부 진행 중"}`,
          link: it.html_url, act: { merge: { repo, number: it.number }, reply: { kind: "github", repo, number: it.number } },
        });
      }
    } catch (e: any) {
      console.warn("[github]", e?.message ?? e);
    } finally { this.running = false; }
  }
}

// ---- 카드 버튼(사용자가 직접 누른 것만) ----
export async function githubMerge(b: unknown, gh: Gh = runGh): Promise<{ ok: boolean; error?: string }> {
  const { repo, number, method } = (b ?? {}) as { repo?: unknown; number?: unknown; method?: unknown };
  if (!okRepo(repo) || !okNum(number)) return { ok: false, error: "레포·번호가 이상해요" };
  const how = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  try { await gh(["pr", "merge", String(number), "-R", repo, how]); return { ok: true }; }
  catch (e: any) { return { ok: false, error: `머지하지 못했어요: ${e?.message ?? e}` }; }
}
export async function githubReply(b: unknown, gh: Gh = runGh): Promise<{ ok: boolean; error?: string; url?: string }> {
  const { repo, number, text } = (b ?? {}) as { repo?: unknown; number?: unknown; text?: unknown };
  if (!okRepo(repo) || !okNum(number)) return { ok: false, error: "레포·번호가 이상해요" };
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || body.length > 10000) return { ok: false, error: "답장 내용을 적어 주세요" };
  try {
    const r = JSON.parse(await gh(["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "--input", "-"], JSON.stringify({ body })));
    return { ok: true, url: r?.html_url };
  } catch (e: any) { return { ok: false, error: `답장을 못 보냈어요: ${e?.message ?? e}` }; }
}
