import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSlack } from "./crawl.ts";

// 사이클 결과를 순서대로 내주는 가짜 깊은 백필
function fakeDeep(cycles: { calls: number; messages?: number; rateLimited?: number; errors?: number; done?: boolean }[], floor = "1600000000.000000", floorAfter = 0) {
  let i = 0, floorCalls = 0;
  const prog = () => ({ convs: { total: 2, done: i }, threads: { total: 0, done: 0 }, searches: { total: 2, done: 2 }, messages: 0, listed: true, done: !!cycles[i - 1]?.done });
  return {
    get floorCalls() { return floorCalls; },
    get cycles() { return i; },
    deep: {
      progress: prog,
      pending: () => ({ convs: cycles.length - i, threads: 0, searches: 0 }),
      ensureFloor: async () => {
        floorCalls++;
        return floorCalls > floorAfter ? { floor, calls: 3, costUsd: 0.001, errors: 0, rateLimited: 0 } : { floor: undefined, calls: 2, costUsd: 0.001, errors: 0, rateLimited: 1 };
      },
      cycle: async () => {
        const c = cycles[i++] ?? { calls: 0, errors: 1 };
        return { conversations: c.errors && !c.calls ? 0 : 1, messages: c.messages ?? 0, threads: c.errors && !c.calls ? 0 : 1, mentions: 0, calls: c.calls, rateLimited: c.rateLimited ?? 0, errors: c.errors ?? 0, truncated: false, turns: 1, costUsd: 0.002, ms: 1, done: !!c.done };
      },
    } as any,
  };
}

test("kg crawl: floor를 먼저 찾고 끝날 때까지 사이클, 합계·비용, 레이트리밋이면 쉬는 시간을 늘린다", async () => {
  const f = fakeDeep([{ calls: 10, messages: 5 }, { calls: 8, rateLimited: 2 }, { calls: 4, messages: 1, done: true }]);
  const sleeps: number[] = [];
  const seen: number[] = [];
  const t = await crawlSlack(f.deep, { cycleDelayMs: 100, rateLimitDelayMs: 1000, sleep: async (ms) => { sleeps.push(ms); }, onCycle: (x) => seen.push(x.cycles) });
  assert.equal(f.floorCalls, 1);
  assert.equal(t.done, true);
  assert.equal(t.cycles, 3);
  assert.equal(t.calls, 3 + 22);
  assert.equal(t.messages, 6);
  assert.equal(t.rateLimited, 2);
  assert.equal(t.costUsd, 0.007);
  assert.equal(t.floor, "1600000000.000000");
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(sleeps, [100, 1000]);
});

test("kg crawl: 호출 없이 오류만 나는 사이클이 이어지면 멈춘다, 중지 요청도", async () => {
  const f = fakeDeep([]);
  const t = await crawlSlack(f.deep, { maxFails: 3, sleep: async () => {} });
  assert.equal(t.stopped, "failing");
  assert.equal(t.cycles, 3);

  let stop = false;
  const g = fakeDeep([{ calls: 1 }, { calls: 1 }, { calls: 1, done: true }]);
  const u = await crawlSlack(g.deep, { sleep: async () => {}, onCycle: () => { stop = true; }, shouldStop: () => stop });
  assert.equal(u.stopped, "user");
  assert.equal(u.cycles, 1);
});

test("kg crawl: floor를 못 찾으면(레이트리밋) 기다렸다 다시 — 찾기 전엔 사이클을 안 돈다, 레이트리밋이 계속이면 멈춘다", async () => {
  const f = fakeDeep([{ calls: 2, done: true }], "1600000000.000000", 2);
  const sleeps: number[] = [];
  const t = await crawlSlack(f.deep, { rateLimitDelayMs: 1000, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(f.floorCalls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(t.rateLimited, 2);
  assert.equal(t.done, true);

  const g = fakeDeep(Array.from({ length: 20 }, () => ({ calls: 4, rateLimited: 1 })));
  const u = await crawlSlack(g.deep, { maxRateLimitStreak: 4, sleep: async () => {} });
  assert.equal(u.stopped, "rateLimited");
  assert.equal(u.cycles, 4);
});

test("kg crawl --workers: 워커 N개가 동시에 사이클, 합계는 하나로, 한 워커가 멈추면 모두 멈춘다", async () => {
  const shards: (number | undefined)[] = [];
  let inflight = 0, peak = 0, n = 0;
  const deep = {
    progress: () => ({ convs: { total: 6, done: n }, threads: { total: 0, done: 0 }, searches: { total: 2, done: 2 }, messages: 0, listed: true, done: n >= 6 }),
    pending: () => ({ convs: 6 - n, threads: 0, searches: 0 }),
    ensureFloor: async () => ({ floor: "1", calls: 0, costUsd: 0, errors: 0, rateLimited: 0 }),
    cycle: async (shard?: { i: number; n: number }) => {
      shards.push(shard?.i);
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((ok) => setTimeout(ok, 5));
      inflight--; n++;
      return { conversations: 1, messages: 2, threads: 0, mentions: 0, calls: 3, rateLimited: 0, errors: 0, truncated: false, turns: 1, costUsd: 0.001, ms: 1, done: n >= 6 };
    },
  } as any;
  const t = await crawlSlack(deep, { workers: 3, sleep: async () => {} });
  assert.equal(t.done, true);
  assert.equal(t.workers, 3);
  assert.equal(peak, 3, "동시에 돈다");
  assert.deepEqual(new Set(shards), new Set([0, 1, 2]));
  assert.equal(t.calls, 3 * t.cycles);

  // 레이트리밋만 계속 → 한 워커가 멈추면 다른 워커도 멈춘다(관문 대기 시간만큼 잔다)
  const gate = { until: 0 } as any;
  const rl = { ...deep, progress: () => ({ ...deep.progress(), done: false }), pending: () => ({ convs: 1, threads: 0, searches: 0 }),
    cycle: async () => ({ conversations: 0, messages: 0, threads: 0, mentions: 0, calls: 1, rateLimited: 1, errors: 0, truncated: false, turns: 1, costUsd: 0, ms: 1, done: false }) };
  const u = await crawlSlack(rl, { workers: 2, gate, maxRateLimitStreak: 3, sleep: async () => {} });
  assert.equal(u.stopped, "rateLimited");
  assert.ok(u.cycles <= 6);
});
