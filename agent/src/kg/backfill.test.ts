import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { loadConfig } from "../config.ts";
import { KgBackfill, type KgStatus } from "./backfill.ts";
import { kgContext, kgSearch } from "./context.ts";

const cfg = { ...loadConfig({}), models: { code: "x", general: "sonnet", light: "haiku" }, kgModel: "sonnet" };
const L = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const session = (sid: string, prompt: string, day = "10") => L([
  { type: "user", sessionId: sid, cwd: "/r/app", timestamp: `2026-09-${day}T01:00:00Z`, message: { content: prompt } },
  { type: "assistant", sessionId: sid, timestamp: `2026-09-${day}T01:01:00Z`, message: { content: [{ type: "text", text: "알겠어" }] } },
]);

function world(n: number, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "kg-bf-"));
  const dir = join(root, "claude", "-r-app");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "codex"), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `s${i}.jsonl`), session(`s${i}`, i % 4 === 3 ? "점심 뭐 먹을까" : `프로젝트 P${i} 배포 이슈 정리 ${"로그 ".repeat(1200)}`)); // 청크 하나가 2단계 한 호출을 채우게
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, `${k}.jsonl`), v);
  return { root, dir, dirs: { claude: join(root, "claude"), codex: join(root, "codex") } };
}

// 가짜 모델: 1단계는 "점심"이면 비업무, 2단계는 조각마다 프로젝트 하나 + 내가 works_on
function fakeModel(opts: { cost?: number; delayMs?: number; failTimes?: number } = {}) {
  const calls = { s1: 0, s2: 0, s2chunks: [] as string[] };
  let fails = opts.failTimes ?? 0;
  const query = ((p: { prompt: string; options: any }) => (async function* () {
    if (opts.delayMs) await new Promise((ok) => setTimeout(ok, opts.delayMs));
    if (fails > 0) { fails--; yield { type: "result", subtype: "error_during_execution", total_cost_usd: 0, usage: {} }; return; }
    const blocks = [...p.prompt.matchAll(/<chunk (?:id|n)="(\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)];
    let out: unknown;
    if (p.options.model === "haiku") {
      calls.s1++;
      out = { results: blocks.map((b) => ({ id: b[1], work: !b[2].includes("점심"), reason: b[2].includes("점심") ? "잡담" : "업무" })) };
    } else {
      calls.s2++;
      const entities: any[] = [], relations: any[] = [];
      for (const b of blocks) {
        const name = /프로젝트 (\w+)/.exec(b[2])?.[1] ?? "기타";
        calls.s2chunks.push(name);
        entities.push({ key: `e${b[1]}`, type: "project", name, aliases: [], description: `${name} 작업`, chunk: Number(b[1]) });
        entities.push({ key: `i${b[1]}`, type: "issue", name: `${name} 배포 이슈`, aliases: [], description: "배포가 막힘", status: "open", chunk: Number(b[1]) });
        relations.push({ from: "ME", rel: "works_on", to: `e${b[1]}`, chunk: Number(b[1]) });
        relations.push({ from: `i${b[1]}`, rel: "blocks", to: `e${b[1]}`, chunk: Number(b[1]) });
      }
      out = { entities, relations };
    }
    yield { type: "result", subtype: "success", structured_output: out, total_cost_usd: opts.cost ?? 0.01, usage: { input_tokens: 1000, output_tokens: 100 }, result: "" };
  })()) as any;
  return { query, calls };
}

const mk = (store: Store, w: ReturnType<typeof world>, f: ReturnType<typeof fakeModel>, extra: Record<string, unknown> = {}) =>
  new KgBackfill(cfg, store, { query: f.query, slack: false, dirs: w.dirs, skipCwdPrefixes: ["/nope"], extractCwd: join(w.root, "kg"), sampleSize: 4, ...extra });

test("status: 계약 모양", () => {
  const store = new Store(":memory:");
  const w = world(0);
  const kg = mk(store, w, fakeModel());
  const s = kg.status();
  assert.equal(s.phase, "idle");
  assert.deepEqual(s.sources, { sessions: { total: 0, done: 0 }, slack: { total: 0, done: 0 } });
  assert.deepEqual(Object.keys(s.entities).sort(), ["decision", "doc", "issue", "person", "project", "repo", "topic"]);
  assert.equal(s.costUsd, 0);
  assert.ok(!isNaN(Date.parse(s.updatedAt)));
  assert.equal(s.estimate, undefined);
});

test("estimate: 청크를 세고 샘플을 실제로 돌려 비용·시간을 외삽, 저장", async () => {
  const store = new Store(":memory:");
  const w = world(12);
  const f = fakeModel({ cost: 0.01 });
  const kg = mk(store, w, f);
  const e = await kg.estimate();
  assert.equal(e.sessions.chunks, 12);
  assert.equal(e.sessions.sampled, 4);
  assert.ok(e.sessions.workRatio > 0 && e.sessions.workRatio <= 1);
  assert.ok(e.usd > 0);
  assert.ok(e.minutes >= 0);
  const s = kg.status();
  assert.deepEqual(s.estimate, { chunks: e.chunks, usd: e.usd, minutes: e.minutes });
  assert.equal(s.phase, "idle");
  assert.ok(s.costUsd > 0, "샘플 비용도 누적");
  assert.equal(s.sources.sessions.done, 4, "샘플은 처리된 것으로");
});

test("start: 전부 처리 → done, 비업무는 걸러지고 엔티티·관계가 생긴다, SSE용 onStatus", async () => {
  const store = new Store(":memory:");
  const w = world(8);
  const f = fakeModel();
  const kg = mk(store, w, f);
  const seen: KgStatus[] = [];
  kg.onStatus((s) => seen.push(s));
  await kg.start({ budgetUsd: 100 });
  const s = kg.status();
  assert.equal(s.phase, "done");
  assert.deepEqual(s.sources.sessions, { total: 8, done: 8 });
  const filtered = Number((store.db.prepare("SELECT count(*) n FROM kg_chunks WHERE status = 'filtered'").get() as any).n);
  assert.equal(filtered, 2);
  assert.equal(s.entities.project, 6);
  assert.equal(s.entities.issue, 6);
  assert.ok(f.calls.s1 >= 1 && f.calls.s1 <= 2, "1단계는 묶어서");
  assert.ok(seen.some((x) => x.phase === "running") && seen.at(-1)!.phase === "done");
  assert.equal(store.neighbors("person:me", "works_on").length, 6);
  // 프롬프트용 요약
  const ctx = kgContext(store, { now: new Date("2026-09-12T00:00:00Z") });
  assert.match(ctx, /## 업무 지식그래프/);
  assert.match(ctx, /### 진행 중 프로젝트/);
  assert.match(ctx, /### 열린 이슈/);
  assert.ok(ctx.length < 2000);
  const q = kgContext(store, { query: "P2 배포", now: new Date("2026-09-12T00:00:00Z") });
  assert.match(q.split("\n").slice(0, 3).join("\n"), /P2/);
  const hits = kgSearch(store, "P5");
  assert.equal(hits[0].name, "P5");
  assert.ok(hits[0].related.some((r) => r.rel === "blocks" && r.dir === "in"));
});

test("예산: 넘기 전에 멈추고 paused(budget) → 재시작 후 이어서, 같은 청크를 두 번 돌리지 않는다", async () => {
  const store = new Store(":memory:");
  const w = world(10);
  const f = fakeModel({ cost: 0.02 });
  const kg = mk(store, w, f, { parallel: 1 });
  await kg.start({ budgetUsd: 0.07 });
  let s = kg.status();
  assert.equal(s.phase, "paused");
  assert.equal(s.reason, "budget");
  assert.ok(s.costUsd <= 0.07);
  assert.ok(s.sources.sessions.done < 10);
  const s2Before = [...f.calls.s2chunks];

  // 데몬 재시작 흉내: 새 인스턴스, 예산 올려서 다시
  const kg2 = mk(store, w, f, { parallel: 1 });
  assert.equal(kg2.status().phase, "paused");
  await kg2.start({ budgetUsd: 10 });
  s = kg2.status();
  assert.equal(s.phase, "done");
  assert.deepEqual(s.sources.sessions, { total: 10, done: 10 });
  const all = f.calls.s2chunks;
  assert.equal(new Set(all).size, all.length, `중복 추출 없음: ${all}`);
  assert.ok(all.length > s2Before.length);
});

test("중단 후 재개: 실행 중에 꺼지면 다음 시작 때 paused(restart), pause()는 paused(user)", async () => {
  const store = new Store(":memory:");
  const w = world(9);
  const f = fakeModel({ delayMs: 15 });
  const kg = mk(store, w, f, { parallel: 1 });
  const run = kg.start({ budgetUsd: 100 });
  await new Promise((ok) => setTimeout(ok, 40));
  kg.pause();
  await run;
  assert.equal(kg.status().phase, "paused");
  assert.equal(kg.status().reason, "user");
  assert.ok(kg.status().sources.sessions.done < 9);

  store.db.prepare("UPDATE kg_meta SET value = 'running' WHERE key = 'phase'").run(); // 실행 중에 프로세스가 죽은 상태
  const kg2 = mk(store, w, f);
  assert.equal(kg2.status().phase, "paused");
  assert.equal(kg2.status().reason, "restart");
  await kg2.start();
  assert.equal(kg2.status().phase, "done");
  assert.equal(kg2.status().sources.sessions.done, 9);
});

test("연속 실패는 청크별 재시도 후 error, 작업은 error phase로 멈춘다", async () => {
  const store = new Store(":memory:");
  const w = world(40);
  const f = fakeModel({ failTimes: 100 });
  const kg = mk(store, w, f, { parallel: 1 });
  await kg.start({ budgetUsd: 100 });
  const s = kg.status();
  assert.equal(s.phase, "error");
  assert.match(s.reason ?? "", /연속 실패/);

  // 몇 번만 실패하면 청크별 재시도로 넘어가고 끝까지 간다
  const store2 = new Store(":memory:");
  const kg2 = mk(store2, world(3), fakeModel({ failTimes: 2 }), { parallel: 1 });
  await kg2.start({ budgetUsd: 100 });
  assert.equal(kg2.status().phase, "done");
  assert.equal(kg2.status().reason, undefined);
});

test("incremental: 워터마크 이후 청크만, 백필 결과는 다시 안 돈다", async () => {
  const store = new Store(":memory:");
  const w = world(4);
  let now = Date.parse("2026-09-15T00:00:00Z");
  const f = fakeModel();
  const kg = mk(store, w, f, { now: () => now });
  await kg.start({ budgetUsd: 100 });
  assert.equal(kg.status().phase, "done");
  const s2 = f.calls.s2chunks.length;
  // 새 세션(워터마크 이후)과 아주 오래된 세션 하나
  writeFileSync(join(w.dir, "new.jsonl"), session("new", "프로젝트 NEW 시작", "20"));
  writeFileSync(join(w.dir, "old2.jsonl"), session("old2", "프로젝트 OLD 회고", "01"));
  now = Date.parse("2026-09-21T00:00:00Z");
  const r = await kg.incremental();
  assert.equal(r.chunks, 1);
  assert.deepEqual(f.calls.s2chunks.slice(s2), ["NEW"]);
  assert.equal(kg.status().phase, "done", "증분은 전체 phase를 건드리지 않는다");
  appendFileSync(join(w.dir, "new.jsonl"), L([{ type: "user", sessionId: "new", timestamp: "2026-09-21T01:00:00Z", message: { content: "프로젝트 NEW 이어서" } }]));
  const r2 = await kg.incremental();
  assert.equal(r2.chunks, 1, "바뀐 마지막 청크만");
});
