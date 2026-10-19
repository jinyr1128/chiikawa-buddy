import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store.ts";
import { loadConfig } from "../config.ts";
import { SlackDeepBackfill, shardOf } from "./slack-deep.ts";
import { RateGate, SlackIngester, retryAfterMs } from "./slack.ts";

const ME = "UME";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 864e5;
const ts = (daysAgo: number, n = 0) => ((NOW - daysAgo * DAY) / 1000 + n).toFixed(0) + ".000100";
const cfg = { ...loadConfig({}), models: { code: "x", general: "x", light: "haiku" } };

type M = { ts: string; user: string; text: string; thread_ts?: string; reply_count?: number };
type W = { convs: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; user?: string }[]; history: Record<string, M[]>; users: Record<string, string>; rateLimitEvery?: number };

// 페이지 커서는 base64 {page}. history는 latest(미포함)·oldest(미포함) 필터, 최신순
function slackWorld(w: W) {
  let n = 0;
  const enc = (p: number) => Buffer.from(JSON.stringify({ page: p })).toString("base64");
  const dec = (c: unknown) => (c ? JSON.parse(Buffer.from(String(c), "base64").toString()).page : 1);
  const page = <T>(xs: T[], cursor: unknown, size: number) => {
    const p = dec(cursor);
    return { slice: xs.slice((p - 1) * size, p * size), next: p * size < xs.length ? enc(p + 1) : null };
  };
  const all = () => Object.entries(w.history).flatMap(([ch, ms]) => ms.map((m) => ({ ...m, channel: ch })));
  const isDM = (ch: string) => !!w.convs.find((c) => c.id === ch && (c.is_im || c.is_mpim));
  return (tool: string, args: any): unknown => {
    if (w.rateLimitEvery && ++n % w.rateLimitEvery === 0) return { error: "ratelimited" };
    switch (tool) {
      case "slack_whoami": return { user_id: ME, url: "https://acme.slack.com/" };
      case "slack_list_accessible_channels":
        return { channels: w.convs.map((c) => ({ id: c.id, name: c.name ?? "", is_im: !!c.is_im, is_mpim: !!c.is_mpim, is_private: false, is_archived: false, user: c.user ?? null })), next_cursor: null };
      case "slack_get_users": return { users: args.user_ids.filter((id: string) => w.users[id]).map((id: string) => ({ id, name: w.users[id], real_name: w.users[id] })) };
      case "slack_get_channel_info": return { id: args.channel_id, name: "ext", is_member: false };
      case "slack_get_channel_history": {
        const ms = (w.history[args.channel_id] ?? []).filter((m) => (!m.thread_ts || m.thread_ts === m.ts)
          && (!args.latest || Number(m.ts) < Number(args.latest)) && (!args.oldest || Number(m.ts) > Number(args.oldest)))
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        const { slice } = page(ms, undefined, args.limit);
        return { messages: slice.map((m) => ({ ...m, user_name: w.users[m.user] })), next_cursor: ms.length > args.limit ? "more" : null };
      }
      case "slack_get_thread_replies": {
        const ms = (w.history[args.channel_id] ?? []).filter((m) => m.ts === args.thread_ts || m.thread_ts === args.thread_ts).sort((a, b) => Number(a.ts) - Number(b.ts));
        return { messages: ms, next_cursor: null };
      }
      case "slack_search_messages": {
        const after = /after:(\S+)/.exec(args.query)?.[1], before = /before:(\S+)/.exec(args.query)?.[1];
        let ms = all().filter((m) => (!after || Number(m.ts) >= Date.parse(after) / 1000 + 86400) && (!before || Number(m.ts) < Date.parse(before) / 1000));
        if (args.query.startsWith("from:")) ms = ms.filter((m) => m.user === ME);
        else if (args.query.startsWith("is:dm")) ms = ms.filter((m) => isDM(m.channel));
        else if (args.query.startsWith("in:")) { const ch = /in:<#(\w+)>/.exec(args.query)![1]; ms = ms.filter((m) => m.channel === ch); }
        else ms = ms.filter((m) => m.text.includes(`<@${ME}>`));
        ms.sort((a, b) => Number(b.ts) - Number(a.ts));
        const { slice, next } = page(ms, args.cursor, args.count ?? 20);
        return {
          matches: slice.map((m) => ({ channel_id: m.channel, user_id: m.user, ts: m.ts, text: m.text,
            permalink: `https://acme.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}${m.thread_ts ? `?thread_ts=${m.thread_ts}` : ""}` })),
          total: ms.length, next_cursor: next,
        };
      }
    }
    throw new Error("unexpected " + tool);
  };
}

function relay(world: (tool: string, args: any) => unknown) {
  const calls: { tool: string; args: any }[] = [];
  const direct = {
    call: async (tool: string, args: any) => {
      calls.push({ tool, args });
      const out: any = world(tool, args);
      if (out?.__fail) return { error: out.__fail };
      return out;
    },
  };
  return { query: direct, direct, calls };
}

const TMP = join(tmpdir(), "cy-slack-deep-test");

// DM 250개(100일에 걸쳐) + 채널 60개(가입 전 20개 포함) + 내 답글이 달린 남의 채널 스레드 + 오래된 멘션
function bigWorld(): W {
  const d1: M[] = Array.from({ length: 250 }, (_, i) => ({ ts: ts(i * 0.4, i), user: i % 2 ? ME : "UA", text: `dm ${i}` }));
  d1.push({ ts: ts(80), user: "UA", text: "옛 스레드 부모", reply_count: 1 }, { ts: ts(80, 50), user: ME, text: "옛 스레드 답", thread_ts: ts(80) });
  const c1: M[] = Array.from({ length: 60 }, (_, i) => ({ ts: ts(i, 7), user: "UB", text: `chan ${i}` }));
  const c9: M[] = [
    { ts: ts(30), user: "UB", text: "남의 스레드", reply_count: 2 },
    { ts: ts(30, 10), user: ME, text: "내 답글", thread_ts: ts(30) },
    { ts: ts(30, 20), user: "UB", text: "그 뒤 답글", thread_ts: ts(30) },
    { ts: ts(70), user: "UB", text: `<@${ME}> 옛 멘션` },
  ];
  return {
    users: { UA: "Alice", UB: "Bob", [ME]: "Me" },
    convs: [{ id: "D1", is_im: true, user: "UA" }, { id: "C1", name: "dev" }],
    history: { D1: d1, C1: c1, C9: c9 },
  };
}

test("깊은 백필: 상한 없이 끝까지, 거꾸로 걷는 커서, 스레드·멘션·내 글, 채널은 floor 이후만, 재시작 후 이어서", async () => {
  const store = new Store(":memory:");
  const w = bigWorld();
  const f = relay(slackWorld(w));
  const opts = { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), convsPerCycle: 2, pagesPerConv: 1, threadsPerCycle: 2, maxCalls: 12, windowDays: 14 };
  const deep = new SlackDeepBackfill(cfg, store, opts);
  const first = await deep.cycle();
  assert.equal(first.done, false);
  assert.ok(first.truncated || !first.done);
  const p1 = deep.progress();
  assert.equal(p1.convs.total, 2);

  // 재시작 흉내: 새 인스턴스로 끝까지
  const deep2 = new SlackDeepBackfill(cfg, store, opts);
  let cycles = 1;
  while (!(await deep2.cycle()).done) { if (++cycles > 60) assert.fail("끝나지 않음"); }
  const p = deep2.progress();
  assert.ok(p.done);
  assert.deepEqual(p.convs, { total: 2, done: 2 });
  assert.equal(p.searches.done, 2);

  const has = (ch: string, t: string) => !!store.node(`message:${ch}:${t}`);
  // DM은 백필 상한(3일) 없이 100일 전까지 전부
  for (let i = 0; i < 250; i++) assert.ok(has("D1", ts(i * 0.4, i)), `dm ${i}`);
  assert.ok(has("D1", ts(80, 50)), "DM 스레드 답글");
  // 채널은 floor(40일) 이후만
  assert.ok(has("C1", ts(39, 7)));
  assert.ok(!has("C1", ts(45, 7)), "가입 전 채널 이력은 안 받는다");
  // 내가 답한 남의 채널 스레드는 통째로, 옛 멘션도
  assert.ok(has("C9", ts(30)) && has("C9", ts(30, 10)) && has("C9", ts(30, 20)));
  assert.ok(!has("C9", ts(70)), "floor 이전 멘션은 검색 창 밖");
  // 같은 history 호출을 두 번 하지 않았다(커서 전진)
  const hist = f.calls.filter((c) => c.tool === "slack_get_channel_history").map((c) => JSON.stringify(c.args));
  assert.equal(new Set(hist).size, hist.length);
  assert.ok(f.calls.every((c) => c.args.channel_id !== "C9" || c.tool !== "slack_get_channel_history"), "멤버 아닌 채널 history는 안 부른다");
  // 끝난 뒤 사이클은 할 일이 거의 없다
  const before = f.calls.length;
  await deep2.cycle();
  assert.ok(f.calls.length - before <= 1);
});

test("레이트리밋이 섞여도 결국 끝까지(재시도·다음 사이클)", async () => {
  const store = new Store(":memory:");
  const w = { ...bigWorld(), rateLimitEvery: 5 };
  const f = relay(slackWorld(w));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), windowDays: 30 });
  let n = 0;
  let rl = 0;
  for (;;) { const r = await deep.cycle(); rl += r.rateLimited; if (r.done) break; if (++n > 80) assert.fail("끝나지 않음"); }
  assert.ok(rl > 0);
  assert.equal((store.db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'message' AND id LIKE 'message:D1:%'").get() as any).n, 252);
});

test("survey: floor 이분 탐색, 검색 total로 메시지 수, 샘플 페이지는 그래프에", async () => {
  const store = new Store(":memory:");
  const w = bigWorld();
  const f = relay(slackWorld(w));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0 });
  const s = await deep.survey({ sampleConvs: 2 });
  assert.equal(s.me, ME);
  // 내 첫 글은 ~99.6일 전 → floor는 그 주
  const firstMine = (NOW - 99.6 * DAY);
  assert.ok(Date.parse(s.floor!) <= firstMine && Date.parse(s.floor!) > firstMine - 8 * DAY, String(s.floor));
  assert.deepEqual(s.convs, { im: 1, mpim: 0, private: 0, public: 1 });
  assert.equal(s.totals.dm, 252);
  assert.ok(s.totals.channels >= 60);
  assert.ok(s.sample.messages > 0);
  assert.ok(s.estCalls > 0 && s.estMessages >= 252);
  assert.ok(Number((store.db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'message'").get() as any).n) > 0);
  assert.ok(deep.floorTs(), "floor 저장");
});

test("channelHistory: false면 멤버 채널 이력은 건너뛰고 DM·내 스레드·멘션만", async () => {
  const store = new Store(":memory:");
  const f = relay(slackWorld(bigWorld()));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), channelHistory: false, windowDays: 30 });
  let n = 0;
  while (!(await deep.cycle()).done) if (++n > 40) assert.fail("끝나지 않음");
  assert.deepEqual(deep.progress().convs, { total: 1, done: 1 });
  assert.ok(!f.calls.some((c) => c.tool === "slack_get_channel_history" && c.args.channel_id === "C1"));
  assert.ok(store.node(`message:C9:${ts(30, 20)}`), "내가 답한 스레드는 받는다");
  assert.ok(store.node(`message:D1:${ts(99, 0)}`) || store.node(`message:D1:${ts(0, 0)}`));
});

test("ensureFloor: 견적 없이 floor만 이분 탐색으로 찾고 저장, 다시 부르면 호출 없음", async () => {
  const store = new Store(":memory:");
  const f = relay(slackWorld(bigWorld()));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0 });
  const r = await deep.ensureFloor();
  const firstMine = NOW - 99.6 * DAY;
  assert.ok(Number(r.floor) * 1000 <= firstMine && Number(r.floor) * 1000 > firstMine - 8 * DAY, String(r.floor));
  assert.ok(f.calls.every((c) => c.tool === "slack_whoami" || c.tool === "slack_search_messages" || c.tool === "slack_list_accessible_channels"));
  const again = await deep.ensureFloor();
  assert.equal(again.calls, 0);
  assert.equal(again.floor, r.floor);
});

test("한국어 429 문구도 레이트리밋 — 깊은 백필은 그 실행의 나머지 호출을 버리고 상태는 그대로", async () => {
  const store = new Store(":memory:");
  const base = slackWorld(bigWorld());
  let limited = true;
  const f = relay((tool, args) => (limited && tool === "slack_get_channel_history"
    ? { error: "Slack이(가) 호출 한도 초과(429)로 잠시 보호 모드입니다. 약 60초 후에 다시 시도하세요." } : base(tool, args)));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), batchSize: 1 });
  const r = await deep.cycle();
  assert.equal(r.rateLimited, 1);
  assert.equal(r.errors, 0);
  assert.ok(r.truncated);
  const histCalls = f.calls.filter((c) => c.tool === "slack_get_channel_history").length;
  assert.equal(histCalls, 1, "첫 429 뒤로는 더 부르지 않는다");
  assert.equal(deep.progress().convs.done, 0);
  limited = false;
  let n = 0;
  while (!(await deep.cycle()).done) if (++n > 60) assert.fail("끝나지 않음");
});

// 대화 여러 개 — 워커 몫 나누기 확인용
function manyWorld(): W {
  const w = bigWorld();
  for (let k = 0; k < 12; k++) {
    const id = `D${10 + k}`;
    w.convs.push({ id, is_im: true, user: "UA" });
    w.history[id] = Array.from({ length: 30 }, (_, i) => ({ ts: ts(i, 100 + k), user: i % 3 ? "UA" : ME, text: `m ${k}/${i}`, ...(i === 5 ? { reply_count: 1 } : {}) }));
    w.history[id].push({ ts: ts(5, 300 + k), user: ME, text: "r", thread_ts: ts(5, 100 + k) });
  }
  return w;
}

test("병렬 샤드: 대화·스레드는 워커끼리 겹치지 않고, 검색 스윕은 워커 0만, 합치면 단일 워커와 같은 결과", async () => {
  const opts = { now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), windowDays: 30, convsPerCycle: 3, threadsPerCycle: 4 };
  // 단일 워커 기준
  const one = new Store(":memory:");
  const f1 = relay(slackWorld(manyWorld()));
  const d1 = new SlackDeepBackfill(cfg, one, { ...opts, direct: f1.direct });
  let k = 0;
  while (!(await d1.cycle()).done) if (++k > 80) assert.fail("단일 끝나지 않음");

  const store = new Store(":memory:");
  const f = relay(slackWorld(manyWorld()));
  const deep = new SlackDeepBackfill(cfg, store, { ...opts, direct: f.direct });
  const N = 3;
  const owner = new Map<string, number>();
  const searchesBy = new Set<number>();
  for (let round = 0; round < 80 && !deep.progress().done; round++) {
    for (let i = 0; i < N; i++) {
      const before = f.calls.length;
      await deep.cycle({ i, n: N });
      for (const c of f.calls.slice(before)) {
        if (c.tool === "slack_search_messages") searchesBy.add(i);
        const key = c.tool === "slack_get_channel_history" ? c.args.channel_id : c.tool === "slack_get_thread_replies" ? `${c.args.channel_id}:${c.args.thread_ts}` : undefined;
        if (!key) continue;
        assert.equal(shardOf(key, N), i, `${key}는 워커 ${shardOf(key, N)} 몫`);
        if (owner.has(key)) assert.equal(owner.get(key), i, "두 워커가 같은 대화/스레드를 걷지 않는다");
        owner.set(key, i);
      }
    }
  }
  assert.ok(deep.progress().done);
  assert.deepEqual([...searchesBy], [0], "검색 스윕은 워커 0만");
  assert.ok(new Set(owner.values()).size > 1, "일이 실제로 나뉜다");
  const msgs = (s: Store) => (s.db.prepare("SELECT id FROM nodes WHERE kind = 'message' ORDER BY id").all() as any[]).map((r) => r.id);
  assert.deepEqual(msgs(store), msgs(one));
  assert.deepEqual(deep.pending({ i: 1, n: N }), { convs: 0, threads: 0, searches: 0 });
});

test("RateGate: 전체 호출 간격을 지키고, 누가 레이트리밋을 받으면 모두 retry_after까지 멈춘다", async () => {
  let clock = 0;
  const g = new RateGate(1000, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const at: number[] = [];
  await g.acquire(1); at.push(clock);
  await g.acquire(2); at.push(clock);
  await g.acquire(1); at.push(clock);
  assert.deepEqual(at, [0, 1000, 3000]);
  g.trip(retryAfterMs("Slack이(가) 호출 한도 초과(429)로 잠시 보호 모드입니다. 약 7초 후에 다시 시도하세요."));
  await g.acquire(1);
  assert.equal(clock, 3000 + 9000, "retry_after 7초 + 여유 2초");
  assert.equal(g.trips, 1);
  assert.equal(retryAfterMs("ratelimited"), 62000);
});

test("관문이 있으면 429 받은 호출은 버리지 않고 retry_after 뒤 다시 — 같은 관문을 쓰는 다른 워커도 기다린다", async () => {
  const store = new Store(":memory:");
  const base = slackWorld(manyWorld());
  let first = true;
  const f = relay((tool, args) => {
    if (first && tool === "slack_get_channel_history") { first = false; return { error: "Slack이(가) 호출 한도 초과(429)로 잠시 보호 모드입니다. 약 3초 후에 다시 시도하세요." }; }
    return base(tool, args);
  });
  let clock = 0;
  const slept: number[] = [];
  const gate = new RateGate(0, { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, since: new Date(NOW - 40 * DAY).toISOString(), windowDays: 30, gate, batchSize: 2 });
  const r = await deep.cycle({ i: 0, n: 2 });
  assert.equal(r.rateLimited, 1);
  assert.equal(gate.trips, 1);
  assert.ok(slept.includes(5000), "모두 retry_after(3초+2초)까지 기다림");
  const hist = f.calls.filter((c) => c.tool === "slack_get_channel_history").map((c) => JSON.stringify(c.args));
  assert.ok(hist.length > new Set(hist).size, "같은 호출을 다시 했다");
  assert.ok(r.conversations > 0, "실행을 접지 않고 이어 갔다");
  // 다른 워커도 같은 관문 — 막혀 있으면 기다린 뒤 시작
  gate.trip(4000);
  const before = clock;
  await deep.cycle({ i: 1, n: 2 });
  assert.ok(clock - before >= 4000);
});

test("RateGate: 성공 없이 이어지는 레이트리밋은 대기를 두 배씩(상한), 같은 보호 구간의 429는 한 번, close()면 바로 풀린다", async () => {
  let clock = 0;
  const g = new RateGate(0, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  g.maxWaitMs = 5000;
  g.trip(1000); g.trip(1000); // 같은 구간 — 한 번
  assert.equal(g.until, 1000);
  await g.acquire(); g.trip(1000);
  assert.equal(g.until - clock, 2000);
  await g.acquire(); g.trip(1000);
  assert.equal(g.until - clock, 4000);
  await g.acquire(); g.trip(1000);
  assert.equal(g.until - clock, 5000, "상한");
  g.ok();
  await g.acquire(); g.trip(1000);
  assert.equal(g.until - clock, 1000, "성공하면 처음부터");
  g.trip(0); g.close();
  const t = clock;
  await g.acquire();
  assert.equal(clock, t, "닫힌 관문은 기다리지 않는다");
  assert.equal(g.closed, true);
});

test("다시 불러도 소용없는 오류(없는 대화·스레드)는 끝난 걸로 — isError(PostToolUseFailure)로 와도, 그래야 백필이 끝난다", async () => {
  const store = new Store(":memory:");
  const w = manyWorld();
  w.convs.push({ id: "DGONE", is_im: true, user: "USLACKBOT" });
  const base = slackWorld(w);
  const f = relay((tool, args) => {
    if (tool === "slack_get_thread_replies" && args.channel_id === "D10") return { __fail: '{"error": "SLACK_CHANNEL_NOT_FOUND", "details": {"slack_error": "channel_not_found"}}' };
    if (tool === "slack_get_channel_history" && args.channel_id === "DGONE") return { error: "SLACK_CHANNEL_NOT_FOUND", message: "Slack channel was not found" };
    return base(tool, args);
  });
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), windowDays: 30 });
  let n = 0, errors = 0;
  for (;;) { const r = await deep.cycle(); errors += r.errors; if (r.done) break; if (++n > 60) assert.fail("끝나지 않음"); }
  assert.ok(errors >= 2);
  const th = store.db.prepare("SELECT done FROM slack_deep_threads WHERE channel = 'D10'").all() as any[];
  assert.ok(th.length && th.every((r) => r.done === 1));
  assert.equal(deep.state("DGONE")?.done, true);
  const tries = f.calls.filter((c) => c.tool === "slack_get_thread_replies" && c.args.channel_id === "D10").length;
  assert.ok(tries <= 2, "한 번 실패로 끝(같은 실행 재시도 빼고)");
});

test("프로세스 간 쿨다운: 429를 DB에 남기면 관문 없는 정기 수집(데몬)은 건너뛰고, 관문은 그때까지 기다린다", async () => {
  const store = new Store(":memory:");
  const base = slackWorld(manyWorld());
  let limited = true;
  const f = relay((tool, args) => (limited && tool === "slack_get_channel_history"
    ? { error: "Slack이(가) 호출 한도 초과(429)로 잠시 보호 모드입니다. 약 30초 후에 다시 시도하세요." } : base(tool, args)));
  const deep = new SlackDeepBackfill(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, paceMs: 0, since: new Date(NOW - 40 * DAY).toISOString(), sharedCooldown: true });
  const t0 = Date.now();
  await deep.cycle();
  const until = deep.ing.cooldownUntil();
  assert.ok(until >= t0 + 32000 && until <= Date.now() + 32000, "retry_after + 여유가 DB에");

  // 데몬 정기 수집(같은 DB, 관문 없음)은 호출 없이 건너뛴다
  limited = false;
  const before = f.calls.length;
  const r = await new SlackIngester(cfg, store, { direct: f.direct, now: () => NOW, cwd: TMP, sharedCooldown: true }).run();
  assert.equal(f.calls.length, before);
  assert.equal(r.calls, 0);

  // 관문은 쿨다운까지 기다린다(가짜 시계를 실제 시각 기준으로)
  let clock = Date.now();
  const g = new RateGate(0, { now: () => clock, sleep: async (ms) => { clock += ms; }, external: () => deep.ing.cooldownUntil() });
  await g.acquire();
  assert.ok(clock >= until);
});
