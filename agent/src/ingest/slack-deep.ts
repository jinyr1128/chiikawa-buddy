// Slack 전체 이력 "깊은 백필" — 지식그래프 1회 구축용. 전송·기록은 ingest/slack.ts(SlackRun)를 그대로 쓰고 호출 계획만 다르다.
//
// - 대화별 커서가 시간을 거꾸로 걷는다: history(latest=지금까지 본 가장 오래된 ts). 사이클마다 대화 몇 개 × 몇 페이지만.
//   상태는 slack_deep 테이블에 있어서 데몬이 재시작돼도 이어 간다. 상한 없음 — done이 될 때까지 사이클을 돌리면 된다.
// - DM·그룹 DM: 처음부터 끝까지 전부. 스레드도 전부.
// - 내가 멤버인 채널: 내 Slack 활동 시작일(floor) 이후만. 내가 쓴/나를 멘션한 부모의 스레드는 답글까지.
// - 내가 쓴 메시지(from:<@me>)·나를 멘션한 메시지: 7일 창을 거꾸로 걸으며 전부 → 그 스레드도 전부(멤버가 아닌 채널 포함).
// - 레이트리밋 친화: 한 턴에 batchSize개만 병렬, 사이클 사이 쉬는 건 호출 쪽(KgBackfill)이 정한다. 레이트리밋 응답은 SlackRun이 한 번 재시도.
import type { Config } from "../config.ts";
import type { Store } from "../store.ts";
import { SlackIngester, SlackRun, isPermanentSlackError, mentions, type SlackIngestCounts, type SlackIngestDeps } from "./slack.ts";

const DEEP = `
CREATE TABLE IF NOT EXISTS slack_deep (key TEXT PRIMARY KEY, latest TEXT, done INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
  msgs INTEGER NOT NULL DEFAULT 0, empty INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slack_deep_threads (channel TEXT NOT NULL, thread_ts TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel, thread_ts));
`;
const MINE = "__deep_mine__";
const MENTIONS = "__deep_mentions__";
const DAY_S = 86400;
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const daySec = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
// 병렬 워커 몫 나누기: 같은 키는 늘 같은 워커(대화·스레드가 두 워커에 겹치지 않는다)
export type Shard = { i: number; n: number };
export function shardOf(key: string, n: number): number {
  let h = 2166136261;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 16777619);
  return (h >>> 0) % n;
}
const mine = (shard: Shard | undefined, key: string) => !shard || shard.n <= 1 || shardOf(key, shard.n) === shard.i;
const minTs = (a: string | undefined, b: string) => (a === undefined || Number(b) < Number(a) ? b : a);

export type SlackDeepDeps = SlackIngestDeps & {
  since?: string;           // 채널 이력 하한(ISO). 없으면 내 활동 시작일(조사로 찾은 값)
  convsPerCycle?: number;   // 사이클당 history를 걷는 대화 수 (기본 8)
  pagesPerConv?: number;    // 대화당 사이클당 페이지 (기본 4, 페이지당 100개)
  threadsPerCycle?: number; // 사이클당 스레드 replies 호출 (기본 24)
  windowDays?: number;      // 검색 창 폭 (기본 7)
  emptyWindowsStop?: number; // floor를 모를 때 연속으로 빈 창이 이만큼이면 끝 (기본 8)
  channelProbes?: number;   // 조사(survey) 때 메시지 수를 세 볼 채널 수 (기본 40, 나머지는 외삽)
  channelHistory?: boolean; // false면 멤버 채널 이력은 건너뛴다(DM·내 글·멘션과 그 스레드만). 기본 true
};

export type DeepProgress = {
  convs: { total: number; done: number };
  threads: { total: number; done: number };
  searches: { total: number; done: number };
  messages: number;  // 깊은 백필로 받은 메시지 수(중복 포함 근사)
  listed: boolean;   // 대화 목록을 한 번이라도 받았는지
  done: boolean;
};

export type SlackSurvey = {
  me?: string;
  floor?: string;                                   // 내 Slack 활동 시작(ISO, 주 단위 근사)
  convs: { im: number; mpim: number; private: number; public: number };
  totals: { dm: number; mine: number; mentions: number; channels: number; channelsProbed: number; channelsTotal: number };
  sample: { messages: number; avgChars: number; threadsPerMine: number };
  estMessages: number;
  estThreads: number;
  estCalls: number;
  calls: number;
  turns: number;
  costUsd: number;
  ms: number;
};

export class SlackDeepBackfill {
  cfg: Config;
  store: Store;
  ing: SlackIngester;
  opts: Required<Pick<SlackDeepDeps, "convsPerCycle" | "pagesPerConv" | "threadsPerCycle" | "windowDays" | "emptyWindowsStop" | "channelProbes" | "channelHistory">> & { since?: string };

  constructor(cfg: Config, store: Store, deps: SlackDeepDeps = {}) {
    this.cfg = cfg;
    this.store = store;
    // 깊은 백필은 사이클당 호출을 넉넉히, 한 턴 병렬은 조금 적게(레이트리밋)
    // Slack 429 에 순하게: 묶음은 작게, 간격은 넉넉히, 검색은 묶음당 1개
    this.ing = new SlackIngester(cfg, store, { maxCalls: 60, batchSize: 3, paceMs: 4000, searchPerBatch: 1, ...deps });
    this.opts = {
      since: deps.since,
      convsPerCycle: deps.convsPerCycle ?? 8,
      pagesPerConv: deps.pagesPerConv ?? 4,
      threadsPerCycle: deps.threadsPerCycle ?? 24,
      windowDays: deps.windowDays ?? 7,
      emptyWindowsStop: deps.emptyWindowsStop ?? 8,
      channelProbes: deps.channelProbes ?? 40,
      channelHistory: deps.channelHistory ?? true,
    };
    store.db.exec(DEEP);
  }

  // 이 워커 몫에 남은 일(대화·스레드·검색)
  pending(shard?: Shard): { convs: number; threads: number; searches: number } {
    const convs = (this.store.db.prepare(`SELECT c.id FROM slack_convs c LEFT JOIN slack_deep d ON d.key = c.id
      WHERE coalesce(d.done, 0) = 0 AND c.next_sync != '9999' ${this.convFilter()}`).all() as any[]).filter((r) => mine(shard, r.id)).length;
    const threads = (this.store.db.prepare("SELECT channel, thread_ts FROM slack_deep_threads WHERE done = 0").all() as any[])
      .filter((r) => mine(shard, `${r.channel}:${r.thread_ts}`)).length;
    const searches = !shard || shard.i === 0 ? [MINE, MENTIONS].filter((k) => !this.state(k)?.done).length : 0;
    return { convs, threads, searches };
  }

  // 채널 이력 하한(초 단위 ts 문자열)
  floorTs(): string | undefined {
    if (this.opts.since) return (Date.parse(this.opts.since) / 1000).toFixed(6);
    return this.ing.meta("deep_floor");
  }

  state(key: string): { latest?: string; done: boolean; pages: number; msgs: number; empty: number } | undefined {
    const r = this.store.db.prepare("SELECT * FROM slack_deep WHERE key = ?").get(key) as any;
    return r ? { latest: r.latest ?? undefined, done: !!r.done, pages: r.pages, msgs: r.msgs, empty: r.empty } : undefined;
  }
  setState(key: string, s: { latest?: string; done: boolean; pages: number; msgs: number; empty?: number }) {
    this.store.db.prepare(`INSERT OR REPLACE INTO slack_deep (key, latest, done, pages, msgs, empty, updated) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(key, s.latest ?? null, s.done ? 1 : 0, s.pages, s.msgs, s.empty ?? 0, new Date(this.ing.deps.now()).toISOString());
  }
  addThread(channel: string, ts: string) {
    this.store.db.prepare("INSERT OR IGNORE INTO slack_deep_threads (channel, thread_ts) VALUES (?, ?)").run(channel, ts);
  }

  progress(): DeepProgress {
    const one = (sql: string) => Number((this.store.db.prepare(sql).get() as any)?.n ?? 0);
    const only = this.convFilter();
    const convTotal = one(`SELECT count(*) n FROM slack_convs c WHERE c.next_sync != '9999' ${only}`);
    const convDone = one(`SELECT count(*) n FROM slack_convs c JOIN slack_deep d ON d.key = c.id WHERE d.done = 1 AND c.next_sync != '9999' ${only}`);
    const thTotal = one("SELECT count(*) n FROM slack_deep_threads");
    const thDone = one("SELECT count(*) n FROM slack_deep_threads WHERE done = 1");
    const sDone = [MINE, MENTIONS].filter((k) => this.state(k)?.done).length;
    const messages = one("SELECT coalesce(sum(msgs), 0) n FROM slack_deep");
    const listed = !!this.ing.meta("channelsListedAt");
    return {
      convs: { total: convTotal, done: convDone }, threads: { total: thTotal, done: thDone },
      searches: { total: 2, done: sDone }, messages, listed,
      done: listed && convDone >= convTotal && thDone >= thTotal && sDone === 2,
    };
  }

  convFilter(): string {
    return this.opts.channelHistory ? "" : "AND c.type IN ('im', 'mpim')";
  }

  // 한 사이클. 끝났으면 done=true. 레이트리밋·오류가 있어도 받은 만큼은 기록하고 상태를 전진시킨다.
  // shard: 병렬 워커면 자기 몫만 — 대화·스레드는 키 해시로 나누고, 목록·검색 스윕은 워커 0만
  async cycle(shard?: Shard): Promise<SlackIngestCounts & { done: boolean }> {
    const counts: SlackIngestCounts = { conversations: 0, messages: 0, threads: 0, mentions: 0, calls: 0, rateLimited: 0, errors: 0, truncated: false, turns: 0, costUsd: 0, ms: 0 };
    const t0 = this.ing.deps.now();
    const r = new SlackDeepRun(this.ing, counts, this, shard);
    await r.drive();
    r.commit();
    return { ...r.counts, ms: this.ing.deps.now() - t0, done: this.progress().done };
  }

  // 견적용 조사: 대화 목록, 내 활동 시작일(이분 탐색), 검색 total로 메시지 수, 대화 몇 개 샘플 1페이지(그래프에 기록).
  async survey(opts: { sampleConvs?: number } = {}): Promise<SlackSurvey> {
    const counts: SlackIngestCounts = { conversations: 0, messages: 0, threads: 0, mentions: 0, calls: 0, rateLimited: 0, errors: 0, truncated: false, turns: 0, costUsd: 0, ms: 0 };
    const t0 = this.ing.deps.now();
    // 이분 탐색은 순차라 턴이 많다 — 이 실행만 상한을 넉넉히
    const ing = new SlackIngester(this.cfg, this.store, { ...this.ing.deps, direct: this.ing.direct, maxCalls: this.opts.channelProbes + 80 });
    const r = new SlackSurveyRun(ing, counts, this, opts.sampleConvs ?? 6);
    await r.drive();
    r.commit();
    return r.result(this.ing.deps.now() - t0);
  }

  // 채널 이력 하한(내 첫 활동 주)만 찾는다 — 견적 없이 크롤만 돌릴 때. 이미 알면 호출 없음.
  async ensureFloor(): Promise<{ floor?: string; calls: number; costUsd: number; errors: number; rateLimited: number }> {
    const known = this.floorTs();
    if (known) return { floor: known, calls: 0, costUsd: 0, errors: 0, rateLimited: 0 };
    const counts: SlackIngestCounts = { conversations: 0, messages: 0, threads: 0, mentions: 0, calls: 0, rateLimited: 0, errors: 0, truncated: false, turns: 0, costUsd: 0, ms: 0 };
    const r = new SlackFloorRun(this.ing, counts, this);
    await r.drive();
    r.commit();
    return { floor: this.floorTs(), calls: counts.calls, costUsd: counts.costUsd, errors: counts.errors, rateLimited: counts.rateLimited };
  }
}

// ── 깊은 백필 사이클
class SlackDeepRun extends SlackRun {
  deep: SlackDeepBackfill;
  shard?: Shard;

  constructor(ing: SlackIngester, counts: SlackIngestCounts, deep: SlackDeepBackfill, shard?: Shard) {
    super(ing, counts);
    this.deep = deep;
    this.shard = shard;
    this.stopOnRateLimit = true;
    const lead = !shard || shard.i === 0;
    this.stages = [
      () => { if (lead) this.discover(); },
      () => this.deepHistories(),
      () => this.deepSearches(),
      () => this.deepThreads(),
      () => this.resolveNames(),
    ];
  }

  private deepHistories() {
    const rows = this.store.db.prepare(`SELECT c.id, c.type FROM slack_convs c LEFT JOIN slack_deep d ON d.key = c.id
      WHERE coalesce(d.done, 0) = 0 AND c.next_sync != '9999' ${this.deep.convFilter()}
      ORDER BY CASE c.type WHEN 'im' THEN 0 WHEN 'mpim' THEN 1 WHEN 'private' THEN 2 ELSE 3 END, c.id`)
      .all().filter((r: any) => mine(this.shard, r.id)).slice(0, this.deep.opts.convsPerCycle) as any[];
    for (const r of rows) {
      const st = this.deep.state(r.id);
      this.deepHistory(r.id, r.type === "im" || r.type === "mpim", 1, st?.latest, st?.pages ?? 0, st?.msgs ?? 0);
    }
  }

  private deepHistory(channel: string, isDM: boolean, page: number, latest: string | undefined, pages: number, msgs: number) {
    const floor = isDM ? undefined : this.deep.floorTs();
    this.push("slack_get_channel_history", {
      channel_id: channel, limit: 100, include_user_names: true,
      ...(latest ? { latest } : {}), ...(floor ? { oldest: floor } : {}),
    }, (d) => {
      let oldest = latest, n = 0;
      for (const m of d?.messages ?? []) {
        if (!m?.ts) continue;
        n++;
        oldest = minTs(oldest, m.ts);
        this.collect(channel, this.fromApi(channel, m));
        if (m.reply_count > 0 && (isDM || (this.me && (m.user === this.me || mentions(m.text, this.me))))) this.deep.addThread(channel, m.ts);
      }
      const done = !n || !d?.next_cursor || (oldest === latest);
      const s = { latest: oldest, done, pages: pages + 1, msgs: msgs + n };
      this.effects.push(() => this.deep.setState(channel, s));
      if (done) this.counts.conversations++;
      else if (page < this.deep.opts.pagesPerConv) this.deepHistory(channel, isDM, page + 1, oldest, s.pages, s.msgs);
    }, page > 1, (err) => {
      // 없는/안 보이는 대화는 끝난 걸로(안 그러면 영영 done이 안 된다)
      if (isPermanentSlackError(err)) this.effects.push(() => this.deep.setState(channel, { latest, done: true, pages, msgs }));
    });
  }

  private deepSearches() {
    if (this.shard && this.shard.i !== 0) return; // 검색 스윕은 워커 0만(중복 방지)
    if (!this.me) { this.counts.errors++; return; }
    this.sweep(MINE, `from:<@${this.me}>`);
    this.sweep(MENTIONS, `<@${this.me}>`);
  }

  // 창 [start, end] (UTC 날짜, 양끝 포함)을 끝까지 넘겨 본 뒤에만 다음 창으로. 중간에 끊기면 다음 사이클에 같은 창부터.
  private sweep(key: string, q: string) {
    const st = this.deep.state(key);
    if (st?.done) return;
    const end = st?.latest ?? day(this.ing.deps.now() / 1000);
    const start = day(daySec(end) - (this.deep.opts.windowDays - 1) * DAY_S);
    const query = `${q} after:${day(daySec(start) - DAY_S)} before:${day(daySec(end) + DAY_S)}`;
    let found = 0;
    const page = (cursor: string | undefined, n: number) => this.push("slack_search_messages", { query, count: 50, ...(cursor ? { cursor } : {}) }, (d) => {
      for (const m of d?.matches ?? []) {
        if (!m?.ts || !m.channel_id) continue;
        found++;
        this.fromSearch(m, false);
        const th = /[?&]thread_ts=([\d.]+)/.exec(m.permalink ?? "")?.[1];
        if (th) this.deep.addThread(m.channel_id, th);
      }
      if (d?.next_cursor && n < 40) { page(d.next_cursor, n + 1); return; }
      const empty = found ? 0 : (st?.empty ?? 0) + 1;
      const floor = this.deep.floorTs();
      const nextEnd = day(daySec(start) - DAY_S);
      const done = floor ? daySec(start) <= Number(floor) : empty >= this.deep.opts.emptyWindowsStop;
      const s = { latest: nextEnd, done, pages: (st?.pages ?? 0) + n, msgs: (st?.msgs ?? 0) + found, empty };
      this.effects.push(() => this.deep.setState(key, s));
    }, n > 1);
    page(undefined, 1);
  }

  private deepThreads() {
    const rows = (this.store.db.prepare("SELECT channel, thread_ts FROM slack_deep_threads WHERE done = 0 ORDER BY thread_ts DESC").all() as any[])
      .filter((r) => mine(this.shard, `${r.channel}:${r.thread_ts}`)).slice(0, this.deep.opts.threadsPerCycle);
    for (const r of rows) this.deepReplies(r.channel, r.thread_ts);
  }

  private deepReplies(channel: string, threadTs: string, cursor?: string, pages = 1) {
    this.push("slack_get_thread_replies", { channel_id: channel, thread_ts: threadTs, limit: 200, include_user_names: true, ...(cursor ? { cursor } : {}) }, (d) => {
      for (const m of d?.messages ?? []) if (m?.ts) this.collect(channel, this.fromApi(channel, m));
      if (d?.next_cursor && pages < 10) { this.deepReplies(channel, threadTs, d.next_cursor, pages + 1); return; }
      this.counts.threads++;
      this.effects.push(() => this.store.db.prepare("UPDATE slack_deep_threads SET done = 1 WHERE channel = ? AND thread_ts = ?").run(channel, threadTs));
    }, pages > 1, (err) => {
      if (isPermanentSlackError(err)) this.effects.push(() => this.store.db.prepare("UPDATE slack_deep_threads SET done = 1 WHERE channel = ? AND thread_ts = ?").run(channel, threadTs));
    });
  }
}

// ── 견적 조사
class SlackSurveyRun extends SlackRun {
  deep: SlackDeepBackfill;
  sampleConvs: number;
  floorS?: number;
  totals = { dm: 0, mine: 0, mentions: 0, channels: 0, channelsProbed: 0 };
  mineSample: { ts: string; thread?: string }[] = [];
  sampleMsgs: { chars: number }[] = [];

  constructor(ing: SlackIngester, counts: SlackIngestCounts, deep: SlackDeepBackfill, sampleConvs: number) {
    super(ing, counts);
    this.deep = deep;
    this.sampleConvs = sampleConvs;
    // 목록은 견적 때 항상 새로
    this.stages = [
      () => { this.discover(); if (!this.listing) { this.listing = true; this.listChannels(); } },
      () => this.findFloor(),
      () => this.probe(),
      () => this.resolveNames(),
    ];
  }

  // from:<@me> before:D 의 total>0 인지로 내 첫 활동 주를 찾는다(순차 이분 탐색, ~10회)
  protected findFloor() {
    if (!this.me) { this.counts.errors++; return; }
    const known = this.deep.floorTs();
    if (known) { this.floorS = Number(known); return; }
    let lo = daySec("2015-01-01"), hi = daySec(day(this.ing.deps.now() / 1000)) + DAY_S;
    const step = () => {
      if (hi - lo <= 7 * DAY_S) {
        this.floorS = lo;
        this.ing.setMeta("deep_floor", lo.toFixed(6));
        return;
      }
      const mid = lo + Math.floor((hi - lo) / DAY_S / 2) * DAY_S;
      this.push("slack_search_messages", { query: `from:<@${this.me}> before:${day(mid)}`, count: 1 }, (d) => {
        if (Number(d?.total ?? 0) > 0) hi = mid; else lo = mid;
        step();
      });
    };
    step();
  }

  private probe() {
    if (!this.me) return;
    const after = this.floorS ? ` after:${day(this.floorS - DAY_S)}` : "";
    const total = (q: string, set: (n: number) => void, count = 1, onPage?: (d: any) => void) =>
      this.push("slack_search_messages", { query: q, count }, (d) => { set(Number(d?.total ?? 0)); onPage?.(d); });
    total("is:dm", (n) => (this.totals.dm = n));
    total(`from:<@${this.me}>${after}`, (n) => (this.totals.mine = n), 50, (d) => {
      for (const m of d?.matches ?? []) this.mineSample.push({ ts: m.ts, thread: /[?&]thread_ts=([\d.]+)/.exec(m.permalink ?? "")?.[1] });
    });
    total(`<@${this.me}>${after}`, (n) => (this.totals.mentions = n));
    const chans = this.store.db.prepare("SELECT id FROM slack_convs WHERE type IN ('public', 'private') AND next_sync != '9999' ORDER BY id")
      .all() as any[];
    // 고르게 뽑아 세 본다
    const stride = Math.max(1, chans.length / this.deep.opts.channelProbes);
    for (let i = 0; i < chans.length && this.totals.channelsProbed < this.deep.opts.channelProbes; i += stride) {
      const id = chans[Math.floor(i)].id;
      this.totals.channelsProbed++;
      total(`in:<#${id}>${after}`, (n) => (this.totals.channels += n));
    }
    // 샘플: DM 반, 채널 반 — 1페이지씩 받아 그래프에 기록(견적 샘플 청크 재료)
    const ims = this.store.db.prepare("SELECT id FROM slack_convs WHERE type IN ('im', 'mpim') ORDER BY id").all() as any[];
    const pick = <T>(xs: T[], k: number) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / k)) === 0).slice(0, k);
    const half = Math.ceil(this.sampleConvs / 2);
    for (const c of [...pick(ims, half), ...pick(chans, this.sampleConvs - half)]) {
      const isDM = ims.includes(c);
      this.push("slack_get_channel_history", {
        channel_id: c.id, limit: 100, include_user_names: true, ...(!isDM && this.floorS ? { oldest: this.floorS.toFixed(6) } : {}),
      }, (d) => {
        for (const m of d?.messages ?? []) {
          if (!m?.ts) continue;
          this.sampleMsgs.push({ chars: String(m.text ?? "").length });
          this.collect(c.id, this.fromApi(c.id, m));
        }
      });
    }
  }

  result(ms: number): SlackSurvey {
    const db = this.store.db;
    const cnt = (t: string) => Number((db.prepare("SELECT count(*) n FROM slack_convs WHERE type = ? AND next_sync != '9999'").get(t) as any).n);
    const convs = { im: cnt("im"), mpim: cnt("mpim"), private: cnt("private"), public: cnt("public") };
    const channelsTotal = convs.private + convs.public;
    const t = this.totals;
    const channels = t.channelsProbed ? Math.round(t.channels * (channelsTotal / t.channelsProbed)) : 0;
    const threadsPerMine = this.mineSample.length ? new Set(this.mineSample.filter((m) => m.thread).map((m) => m.thread)).size / this.mineSample.length : 0;
    // 메시지: DM(전부) + 채널(floor 이후) + 내가 쓴 것 중 멤버 아닌 곳(근사로 무시) — 스레드 답글은 검색 total에 이미 포함
    const estMessages = t.dm + (this.deep.opts.channelHistory ? channels : Math.round(t.mine * 0.6 + t.mentions));
    const estThreads = Math.round(t.mine * threadsPerMine + t.mentions * 0.3);
    const convCount = convs.im + convs.mpim + channelsTotal;
    const estCalls = convCount + Math.ceil(estMessages / 100) + Math.ceil((t.mine + t.mentions) / 50) + estThreads +
      (this.floorS ? Math.ceil((this.ing.deps.now() / 1000 - this.floorS) / (7 * DAY_S)) * 2 : 0);
    const chars = this.sampleMsgs.reduce((a, m) => a + m.chars, 0);
    return {
      me: this.me, floor: this.floorS ? new Date(this.floorS * 1000).toISOString() : undefined, convs,
      totals: { ...t, channels, channelsTotal },
      sample: { messages: this.sampleMsgs.length, avgChars: this.sampleMsgs.length ? Math.round(chars / this.sampleMsgs.length) : 0, threadsPerMine: Math.round(threadsPerMine * 100) / 100 },
      estMessages, estThreads, estCalls, calls: this.counts.calls, turns: this.counts.turns, costUsd: this.counts.costUsd, ms,
    };
  }
}

// ── floor만 찾기(내 id → 이분 탐색)
class SlackFloorRun extends SlackSurveyRun {
  constructor(ing: SlackIngester, counts: SlackIngestCounts, deep: SlackDeepBackfill) {
    super(ing, counts, deep, 0);
    this.stopOnRateLimit = true;
    this.stages = [() => this.discover(), () => this.findFloor()];
  }
}
