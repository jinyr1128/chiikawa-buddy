// 같은 레포를 고치는 대화끼리만 줄 세우는 잠금(레포 작업 폴더 하나 = 잠금 하나).
//
// 대화(채팅·캐릭터 대화·할 일 팝오버·Slack DM)는 스레드가 다르면 동시에 돈다. 다만 두 답이 같은 레포 작업 폴더에서
// 동시에 파일을 고치면 서로의 변경이 섞이니, 처음 **쓰는** 도구 호출(Edit·Write·쓰기 셸)에서 그 레포를 잡는다 —
// 권한 브로커 PreToolUse 훅(permissions.ts)이 잡고, 이미 다른 답이 잡았으면 풀릴 때까지 그 호출을 멈춰 둔다.
// 잡은 답(run)이 끝나면 brain.ts ask 가 푼다(그 run 이 잡은 것 전부). 읽기만 하는 답·레포 없는 답(~/.cy-agent/brain)은 안 잡는다.
//
// 주인(owner) = run id(한 번의 ask). 같은 run 안의 포그라운드 서브에이전트도 같은 훅·같은 run 이라 다시 잡아도 바로 통과(재진입).
// 서로를 기다리는 원(A 가 X 를 잡고 Y 를 기다리는데 B 가 Y 를 잡고 X 를 기다림)이 생기면 기다리지 않고 그냥 지나간다(멈춰 버리지 않게).
import { basename } from "node:path";

export type LockOwner = { key: string; threadId?: string };
// 기다리는 것 하나: 누가(owner) 어느 레포(repo)를 누구(holder) 때문에, 언제부터
export type LockWait = { owner: LockOwner; repo: string; holder: LockOwner; since: string };

export const repoName = (repo: string) => basename(repo) || repo;

export class RepoLocks {
  private held = new Map<string, LockOwner>(); // repo → 잡은 주인
  private waiting: (LockWait & { done: (ok: boolean) => void })[] = [];
  private listeners = new Set<() => void>();

  // 잡거나(true) 기다렸다 잡는다. 멈추면(signal) false. 이미 잡았거나 기다림 원이면 바로 true
  acquire(repo: string, owner: LockOwner, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const h = this.held.get(repo);
    if (!h) { this.held.set(repo, owner); this.changed(); return Promise.resolve(true); }
    if (h.key === owner.key || this.cycle(h.key, owner.key)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const w = { owner, repo, holder: h, since: new Date().toISOString(), done: (ok: boolean) => { signal?.removeEventListener("abort", onAbort); resolve(ok); } };
      const onAbort = () => {
        if (!this.waiting.includes(w)) return;
        this.waiting = this.waiting.filter((x) => x !== w);
        w.done(false);
        this.changed();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(w);
      this.changed();
    });
  }

  // key 가 잡은 레포를 모두 풀고(다음 기다리던 것에 넘긴다), key 가 기다리던 것도 거둔다
  release(key: string): void {
    let touched = false;
    for (const w of this.waiting.filter((x) => x.owner.key === key)) { this.waiting = this.waiting.filter((x) => x !== w); w.done(false); touched = true; }
    for (const [repo, h] of [...this.held]) {
      if (h.key !== key) continue;
      this.held.delete(repo);
      touched = true;
      const next = this.waiting.find((x) => x.repo === repo);
      if (next) {
        this.waiting = this.waiting.filter((x) => x !== next);
        this.held.set(repo, next.owner);
        for (const x of this.waiting) if (x.repo === repo) x.holder = next.owner; // 이제 새 주인을 기다린다
        next.done(true);
      }
    }
    if (touched) this.changed();
  }

  holder(repo: string): LockOwner | undefined { return this.held.get(repo); }
  // 기다리는 것들(먼저 줄 선 순)
  waits(): LockWait[] { return this.waiting.map(({ done: _d, ...w }) => ({ ...w })); }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // holderKey 가 (몇 단계를 거쳐) me 가 잡은 레포를 기다리나
  private cycle(holderKey: string, me: string): boolean {
    const seen = new Set<string>();
    let cur = holderKey;
    while (!seen.has(cur)) {
      seen.add(cur);
      const w = this.waiting.find((x) => x.owner.key === cur);
      if (!w) return false;
      const h = this.held.get(w.repo);
      if (!h) return false;
      if (h.key === me) return true;
      cur = h.key;
    }
    return false;
  }
  private changed() { for (const fn of this.listeners) { try { fn(); } catch {} } }
}

// 데몬 하나에 하나(브로커 훅이 잡고 brain.ts ask 가 run 끝에 푼다)
export const repoLocks = new RepoLocks();
