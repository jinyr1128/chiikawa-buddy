// 수동 실행: node src/cli.ts ingest | brief | sessions [--all] | kg crawl [--no-channels] [--workers N] [--rate N] | kg estimate | kg start [--budget N] [--no-crawl] [--parallel N] | kg status | kg sample [N] | kg context [질문] | kg refine [--budget N] [--dry-run] [--parallel N] | kg refine-inc [--budget N]
import { loadConfig, HOME_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { ingestSessions } from "./ingest/sessions.ts";
import { think, BRIEFING_TASK } from "./brain.ts";
import { KgBackfill } from "./kg/backfill.ts";
import { kgContext } from "./kg/context.ts";
import { SlackDeepBackfill } from "./ingest/slack-deep.ts";
import { RateGate } from "./ingest/slack.ts";
import { crawlSlack } from "./kg/crawl.ts";
import { refineAll, refineIncremental, type RefineReport } from "./kg/refine.ts";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
// 데몬도 같은 DB에 쓴다(WAL) — 잠금이면 기다린다
store.db.exec("PRAGMA busy_timeout = 5000;");
const [cmd, sub, ...rest] = process.argv.slice(2);

if (cmd === "kg") {
  await kg(sub, rest);
} else if (cmd === "sessions") {
  // --all: 14일 컷오프 없이 로컬 세션 전부(모델 호출 없음)
  const all = [sub, ...rest].includes("--all");
  const t0 = Date.now();
  const n = ingestSessions(store, { claude: cfg.claudeProjectsDir, codex: cfg.codexSessionsDir }, { skipCwdPrefix: HOME_DIR, ...(all ? { sinceMs: Infinity } : {}) });
  console.log(`세션 ${n}개 반영${all ? " (전체)" : ""} · ${Date.now() - t0}ms`);
} else {
  const n = ingestSessions(store, { claude: cfg.claudeProjectsDir, codex: cfg.codexSessionsDir }, { skipCwdPrefix: HOME_DIR });
  console.log(`세션 ${n}개 반영`);
  if (cmd === "brief") {
    const t = await think(cfg, store, BRIEFING_TASK, (s) => console.log("  →", s));
    console.log(JSON.stringify(t, null, 2));
  }
}

async function crawl(args: string[]) {
  const flag = (name: string, def: number) => { const i = args.indexOf(name); const v = i >= 0 ? Number(args[i + 1]) : NaN; return v > 0 ? v : def; };
  const workers = Math.floor(flag("--workers", 4));
  const ratePerMin = flag("--rate", 60); // 전체(워커 합) 분당 호출 상한
  // 워커들이 같이 쓰는 관문: 호출 간격 + 429면 모두 retry_after까지 멈춤
  const gate = new RateGate(60000 / ratePerMin, { external: () => deep.ing.cooldownUntil() });
  // 단독 크롤은 사이클을 크게(묶음이 꽉 차도록) — 속도 상한은 관문이 정한다
  const deep = new SlackDeepBackfill(cfg, store, { channelHistory: !args.includes("--no-channels"), convsPerCycle: 24, threadsPerCycle: 48, maxCalls: 120, gate });
  if (!deep.ing.transport) { console.error("Slack 수집이 꺼져 있어요 — connectors.slack 을 api(사용자 토큰)로 설정하세요 (docs/connect/slack.md)"); process.exitCode = 1; return; }
  let stop = false;
  process.once("SIGINT", () => { console.error("멈추는 중… (받은 것까지 저장)"); stop = true; gate.close(); });
  const p0 = deep.progress();
  console.error(`워커 ${workers} · 분당 ${ratePerMin}회 상한`);
  console.error(`시작 · 대화 ${p0.convs.done}/${p0.convs.total} · 스레드 ${p0.threads.done}/${p0.threads.total} · 검색 ${p0.searches.done}/2`);
  const t = await crawlSlack(deep, {
    workers, gate,
    shouldStop: () => stop,
    onCycle: (x, w) => {
      const p = x.progress;
      console.error(`[${x.cycles} w${w}] 대화 ${p.convs.done}/${p.convs.total} · 스레드 ${p.threads.done}/${p.threads.total} · 검색 ${p.searches.done}/2 · ` +
        `메시지 +${x.messages} · 호출 ${x.calls} (${Math.round(x.calls / Math.max(1, x.ms / 60000))}/분) · 레이트리밋 ${x.rateLimited} · 오류 ${x.errors} · $${x.costUsd} · ${Math.round(x.ms / 1000)}s`);
    },
  });
  const one = (sql: string) => Number((store.db.prepare(sql).get() as any)?.n ?? 0);
  console.log(JSON.stringify({
    done: t.done, stopped: t.stopped, floor: t.floor, workers: t.workers, gateTrips: gate.trips, callsPerMin: Math.round(t.calls / Math.max(1, t.ms / 60000) * 10) / 10, cycles: t.cycles, calls: t.calls, rateLimited: t.rateLimited, errors: t.errors,
    newMessages: t.messages, conversationsFinished: t.conversations, threadsFetched: t.threads, costUsd: t.costUsd, durationSec: Math.round(t.ms / 1000),
    progress: t.progress,
    graph: {
      messages: one("SELECT count(*) n FROM nodes WHERE kind = 'message'"),
      channels: one("SELECT count(*) n FROM nodes WHERE kind = 'channel'"),
      people: one("SELECT count(*) n FROM nodes WHERE kind = 'person'"),
      threads: one("SELECT count(*) n FROM slack_deep_threads"),
    },
  }, null, 2));
  if (t.stopped === "failing") process.exitCode = 1;
}

// 지식그래프 다듬기(Sonnet): 합치기 → 이슈 상태 → 프로젝트 요약. --dry-run은 계획과 샘플로 잰 비용 견적만
async function refine(sub: string, args: string[]) {
  const num = (name: string) => { const i = args.indexOf(name); const v = i >= 0 ? Number(args[i + 1]) : NaN; return v > 0 ? v : undefined; };
  const parallel = num("--parallel");
  let stop = false;
  const deps = { parallel: parallel ? Math.floor(parallel) : 3, log: (s: string) => console.error(`[refine] ${s}`), shouldStop: () => stop };
  process.once("SIGINT", () => { console.error("멈추는 중… (진행 중인 호출이 끝나면 저장)"); stop = true; });
  const r: RefineReport = sub === "refine-inc"
    ? await refineIncremental(cfg, store, { budgetUsd: num("--budget") ?? 0.5, deps })
    : await refineAll(cfg, store, { budgetUsd: num("--budget") ?? 10, dryRun: args.includes("--dry-run"), deps });
  console.log(JSON.stringify(r, null, 2));
}

async function kg(sub: string | undefined, args: string[]) {
  if (sub === "crawl") return crawl(args);
  if (sub === "refine" || sub === "refine-inc") return refine(sub, args);
  // --no-crawl: Slack 깊은 백필을 건너뛰고 이미 모은 메시지만 쓴다
  // --parallel N: 동시 모델 호출 수(기본 3)
  const ci = args.indexOf("--parallel");
  const parallel = ci >= 0 && Number(args[ci + 1]) > 0 ? Math.floor(Number(args[ci + 1])) : undefined;
  const kg = new KgBackfill(cfg, store, { ...(args.includes("--no-crawl") ? { noSlackCrawl: true } : {}), ...(parallel ? { parallel } : {}) });
  let last = "";
  kg.onStatus((s) => {
    const line = `[${s.phase}] ${s.step ?? ""} 세션 ${s.sources.sessions.done}/${s.sources.sessions.total} · Slack ${s.sources.slack.done}/${s.sources.slack.total} · $${s.costUsd}`;
    if (line !== last) { console.error(line); last = line; }
  });
  switch (sub) {
    case "estimate": {
      const e = await kg.estimate();
      console.log(JSON.stringify(e, null, 2));
      break;
    }
    case "start": {
      const i = args.indexOf("--budget");
      const budgetUsd = i >= 0 ? Number(args[i + 1]) : undefined;
      process.once("SIGINT", () => { console.error("멈추는 중… (진행 중인 호출이 끝나면 저장)"); kg.pause(); });
      await kg.start(budgetUsd ? { budgetUsd } : {});
      console.log(JSON.stringify(kg.status(), null, 2));
      break;
    }
    case "status":
      console.log(JSON.stringify(kg.status(), null, 2));
      break;
    case "sample": {
      const r = await kg.sample(Number(args[0] ?? 10));
      for (const c of r.chunks) console.log(`- ${c.id} [${c.status}${c.work === false ? `: ${c.reason}` : ""}] ${c.label} (${c.text.length}자, $${c.costUsd.toFixed(4)})`);
      console.log(`\n엔티티 ${r.merged.length}개`);
      for (const e of r.merged) console.log(`  ${e.kind.padEnd(8)} ${e.name}  (${e.id})`);
      console.log(`관계 ${r.relations.length}개`);
      for (const x of r.relations) console.log(`  ${x.src} -${x.rel}-> ${x.dst}`);
      console.log(`\n비용 $${r.costUsd}`);
      break;
    }
    case "context":
      console.log(kgContext(store, { query: args.join(" ") || undefined }));
      break;
    default:
      console.log("사용법: node src/cli.ts kg crawl [--no-channels] | estimate | start [--budget N] [--no-crawl] [--parallel N] | status | sample [N] | context [질문] | refine [--budget N] [--dry-run] [--parallel N] | refine-inc [--budget N]");
  }
}
