// 같은 레포(같은 .git — 워크트리끼리도 공유)의 공유 참조를 바꾸는 git 호출만 짧게 줄 세운다.
//
// 수정 run·워크트리 에이전트는 동시에 여러 개 돈다(각자 워크트리). 다만 fetch · worktree add/remove · branch -D · push 처럼
// 같은 .git 의 refs·packed-refs·worktrees 목록을 건드리는 호출이 겹치면 "cannot lock ref" 류로 깨질 수 있어, 그 호출 묶음만
// 레포(git common dir)마다 하나씩 돌린다. run 전체를 잠그지 않는다 — 모델이 고치고 테스트하는 동안은 서로 막지 않는다.
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 비동기 셸(긴 테스트·네트워크 git 이 데몬을 멈추지 않게). 실패하면 stdout·stderr 를 단 예외
// verbatim: Windows 의 cmd.exe /d /s /c "…"(plat.ts winSpawnSpec) — 인자를 Node 가 다시 따옴표로 감싸지 않게
export async function shAsync(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeout = 15 * 60e3, verbatim = false): Promise<string> {
  const r = await execFileP(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
  return String(r.stdout ?? "").trim();
}

// 잠금 키: 워크트리끼리 같은 .git 을 쓰니 common dir 로(모르면 경로 그대로)
export function gitKey(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || resolve(dir);
  } catch { return resolve(dir); }
}

export class GitMutex {
  private tails = new Map<string, Promise<unknown>>();
  private active = new Map<string, number>();
  readonly peak = new Map<string, number>(); // 키마다 동시에 돈 최댓값(테스트 — 늘 1 이어야)

  async run<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
    const key = gitKey(dir);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev.catch(() => {});
    const n = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, n);
    this.peak.set(key, Math.max(this.peak.get(key) ?? 0, n));
    try { return await fn(); } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const gitMutex = new GitMutex();
export const repoGit = <T>(dir: string, fn: () => T | Promise<T>): Promise<T> => gitMutex.run(dir, fn);
