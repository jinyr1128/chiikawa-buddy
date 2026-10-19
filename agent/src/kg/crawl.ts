// Slack 깊은 백필만 끝까지 — 추출(모델 1·2단계) 없이 Web API 수집만. `node src/cli.ts kg crawl [--no-channels] [--workers N]`
// 상태는 slack_deep 테이블에 있어서 끊겨도 다시 돌리면 이어 간다. 출력은 개수만(메시지 본문 없음).
//
// 병렬: 워커 N개가 각자 SDK 세션으로 사이클을 돈다. 대화·스레드는 키 해시로 나눠 겹치지 않고, 목록·검색 스윕은 워커 0만.
// 호출 간격·레이트리밋 대기는 RateGate 하나를 같이 쓴다(누가 429를 받으면 모두 retry_after까지 멈춤).
// 기록은 같은 Store — node:sqlite는 동기라 commit()이 서로 끼어들지 않는다.
import type { DeepProgress, SlackDeepBackfill } from "../ingest/slack-deep.ts";
import type { RateGate } from "../ingest/slack.ts";

export type CrawlTotals = {
  cycles: number; calls: number; messages: number; conversations: number; threads: number;
  rateLimited: number; errors: number; costUsd: number; ms: number;
  done: boolean; stopped?: string; floor?: string; workers: number; progress: DeepProgress;
};

export type CrawlOpts = {
  workers?: number;          // 병렬 워커 수(기본 1)
  gate?: RateGate;           // 워커들이 같이 쓰는 관문(SlackDeepBackfill에 넣은 것과 같은 것). 있으면 레이트리밋 대기는 관문이 정한다
  cycleDelayMs?: number;     // 사이클 사이 쉬는 시간
  idleMs?: number;           // 자기 몫이 비었을 때 다시 볼 때까지(다른 워커가 스레드를 보탤 수 있다)
  rateLimitDelayMs?: number; // 관문이 없을 때 레이트리밋 뒤 최소 대기, 연속이면 두 배씩(최대 5분)
  maxFails?: number;         // 받은 것 없이 오류만 난 사이클이 연속 이만큼이면 멈춘다
  maxRateLimitStreak?: number; // 연속으로 레이트리밋만 받으면 멈춘다(기본 12)
  maxCycles?: number;        // 전체 사이클 상한(테스트용)
  onCycle?: (t: CrawlTotals, worker: number) => void;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export async function crawlSlack(deep: SlackDeepBackfill, opts: CrawlOpts = {}): Promise<CrawlTotals> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const base = opts.cycleDelayMs ?? 1500;
  const idle = opts.idleMs ?? 5000;
  const maxFails = opts.maxFails ?? 8;
  const rlBase = opts.rateLimitDelayMs ?? 65000;
  const maxStreak = opts.maxRateLimitStreak ?? 12;
  const workers = Math.max(1, Math.floor(opts.workers ?? 1));
  const gate = opts.gate;
  const t0 = now();
  const t: CrawlTotals = { cycles: 0, calls: 0, messages: 0, conversations: 0, threads: 0, rateLimited: 0, errors: 0, costUsd: 0, ms: 0, done: false, workers, progress: deep.progress() };
  let stopped: string | undefined;
  const finish = () => { t.ms = now() - t0; t.progress = deep.progress(); t.done = t.progress.done; if (stopped) t.stopped = stopped; return t; };
  const halt = () => {
    if (!stopped && opts.shouldStop?.()) stopped = "user";
    if (!stopped && opts.maxCycles !== undefined && t.cycles >= opts.maxCycles) stopped = "maxCycles";
    return !!stopped;
  };

  // 중지 요청이면 바로 깨는 잠
  const nap = async (ms: number) => { for (let left = ms; left > 0 && !halt(); left -= 5000) await sleep(Math.min(left, 5000)); };
  // 레이트리밋 뒤 대기. false면 너무 오래 이어져서 멈춤
  const backoff = () => {
    let rlDelay = rlBase, streak = 0;
    return async (rateLimited: number): Promise<boolean> => {
      if (!rateLimited) { streak = 0; rlDelay = rlBase; await sleep(base); return true; }
      if (++streak >= maxStreak) return false;
      if (gate) await nap(Math.max(0, gate.until - now()) + base);
      else { await nap(rlDelay); rlDelay = Math.min(rlDelay * 2, 300000); }
      return true;
    };
  };

  // 채널 이력 하한(내 첫 활동 주)을 먼저 — 모르면 채널을 처음까지 걷게 되므로 찾을 때까지 사이클을 안 돈다
  {
    const wait = backoff();
    let fails = 0;
    while (!t.floor) {
      if (halt()) return finish();
      const f = await deep.ensureFloor();
      t.calls += f.calls; t.costUsd = r5(t.costUsd + f.costUsd); t.errors += f.errors; t.rateLimited += f.rateLimited; t.floor = f.floor;
      if (t.floor) break;
      if (!f.rateLimited && ++fails >= maxFails) { stopped = "noFloor"; return finish(); }
      opts.onCycle?.(t, 0);
      if (!(await wait(f.rateLimited))) { stopped = "rateLimited"; return finish(); }
    }
  }

  const worker = async (i: number) => {
    const shard = workers > 1 ? { i, n: workers } : undefined;
    const wait = backoff();
    let fails = 0;
    for (;;) {
      if (halt() || deep.progress().done) return;
      if (shard) {
        const p = deep.pending(shard);
        if (!p.convs && !p.threads && !p.searches) { await sleep(idle); continue; }
      }
      const r = await deep.cycle(shard);
      t.cycles++;
      t.calls += r.calls; t.messages += r.messages; t.conversations += r.conversations; t.threads += r.threads;
      t.rateLimited += r.rateLimited; t.errors += r.errors; t.costUsd = r5(t.costUsd + r.costUsd);
      t.ms = now() - t0; t.progress = deep.progress();
      opts.onCycle?.(t, i);
      if (r.done) return;
      // 레이트리밋 아닌 오류만 있는 사이클(받은 게 없음)이 이어지면 멈춘다
      fails = r.errors && !r.rateLimited && !r.messages && !r.conversations && !r.threads ? fails + 1 : 0;
      if (fails >= maxFails) { stopped ??= "failing"; return; }
      if (!(await wait(r.rateLimited))) { stopped ??= "rateLimited"; return; }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  return finish();
}
