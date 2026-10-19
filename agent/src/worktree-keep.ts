// 끝난 수정 run 의 워크트리 정리: 커밋 안 된 변경·푸시 안 된 커밋이 있으면 지우지 않고 남긴다(실패·정지·턴 한도 — 작업이 날아가지 않게).
// 남기면 run 기록에 system 줄(worktree = 그 경로)을 남겨 세션 창이 경로를 보여 준다
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { RunHandle } from "./runs.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60e3 }).trim();

// 남길 이유(없으면 null). 확인이 안 되면(깨진 워크트리 등) 안전하게 남긴다
export function worktreeLeftovers(wt: string): { dirty: number; unpushed: number } | null {
  if (!wt || !existsSync(wt)) return null;
  try {
    const dirty = git(wt, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    const unpushed = Number(git(wt, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) || 0;
    return dirty || unpushed ? { dirty, unpushed } : null;
  } catch {
    return { dirty: -1, unpushed: -1 };
  }
}

// 지울지 정한다: 푸시까지 끝났으면 지우고, 아니면 남은 게 있을 때 남긴다. 남겼으면 true(그땐 로컬 브랜치도 지우면 안 된다)
export function cleanupWorktree(repo: string, wt: string, o: { run?: Pick<RunHandle, "log">; shipped: boolean }): boolean {
  if (!wt) return false;
  const left = o.shipped ? null : worktreeLeftovers(wt);
  if (left) {
    const why = left.dirty < 0 ? "상태를 확인하지 못해서"
      : `${[left.dirty ? `커밋 안 된 변경 ${left.dirty}개` : "", left.unpushed ? `푸시 안 된 커밋 ${left.unpushed}개` : ""].filter(Boolean).join(" · ")}가 있어서`;
    o.run?.log({ type: "system", text: `📁 ${why} 워크트리를 지우지 않고 남겨 뒀어요: ${wt}`, worktree: wt });
    return true;
  }
  try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: "ignore" }); } catch {}
  return false;
}
