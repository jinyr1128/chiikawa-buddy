import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store.ts";
import { loadConfig } from "../config.ts";
import { SlackIngester, attentionSince, callKey, formatAttention, mentions, parseToolResponse, permalinkOf } from "./slack.ts";

const ME = "UME";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const ts = (minAgo: number, n = 0) => ((NOW - minAgo * 60e3) / 1000).toFixed(0) + "." + String(n).padStart(6, "0");
const cfg = { ...loadConfig({}), models: { code: "x", general: "x", light: "haiku" } };

// ── 가짜 Slack Web API 전송: 도구 이름·응답 모양은 SlackApiTransport 이 맞춘 것
type HMsg = { ts: string; user?: string | null; text: string; thread_ts?: string; reply_count?: number };
type World = {
  users: Record<string, { name: string; bot?: boolean }>;
  convs: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string }[];
  history: Record<string, HMsg[]>;                 // 채널(C…/G…/D…) 메시지. 스레드 답글은 thread_ts != ts
  pageSize?: number;
  failOnce?: string[];                              // 이 도구는 처음 한 번 rate limit 에러
};

const enc = (n: number) => Buffer.from(JSON.stringify({ page: n })).toString("base64");
const dec = (c: unknown) => (c ? JSON.parse(Buffer.from(String(c), "base64").toString()).page : 1);

function slackWorld(w: World) {
  const fail = new Set(w.failOnce ?? []);
  const page = <T>(items: T[], cursor: unknown, size = w.pageSize ?? 50) => {
    const p = dec(cursor);
    const slice = items.slice((p - 1) * size, p * size);
    return { slice, next: p * size < items.length ? enc(p + 1) : null };
  };
  const all = () => Object.entries(w.history).flatMap(([ch, ms]) => ms.map((m) => ({ ...m, channel: ch })));
  const conv = (id: string) => w.convs.find((c) => c.id === id);
  const permalink = (ch: string, m: HMsg) =>
    `https://acme.slack.com/archives/${ch}/p${m.ts.replace(".", "")}${m.thread_ts ? `?thread_ts=${m.thread_ts}` : ""}`;
  return (tool: string, args: any): unknown => {
    if (fail.delete(tool)) return { error: "ratelimited: Slack rate limit, retry later" };
    switch (tool) {
      case "slack_whoami":
        return { team_id: "T1", user_id: ME, team: "Acme", user: "me", url: "https://acme.slack.com/", scopes: ["identify", "search:read"] };
      case "slack_list_accessible_channels": {
        const { slice, next } = page(w.convs, args.cursor, w.pageSize ?? 200);
        return {
          channels: slice.map((c) => ({ id: c.id, name: c.name ?? "", is_private: !!c.is_private || !!c.is_mpim, is_archived: false, is_member: true, is_im: !!c.is_im, is_mpim: !!c.is_mpim, user: c.user ?? null })),
          next_cursor: next,
        };
      }
      case "slack_get_users":
        return {
          users: args.user_ids.filter((id: string) => w.users[id]).map((id: string) => ({ id, name: w.users[id].name, real_name: `${w.users[id].name[0].toUpperCase()}${w.users[id].name.slice(1)}  Kim`, email: null, is_bot: !!w.users[id].bot, deleted: false, team_id: "T1" })),
          user_ids_not_found: args.user_ids.filter((id: string) => !w.users[id]),
        };
      case "slack_get_channel_info": {
        const c = conv(args.channel_id) ?? { id: args.channel_id, name: "ops" };
        return { id: c.id, name: c.name ?? "", is_private: false, is_archived: false, is_member: !!conv(args.channel_id), is_shared: false, is_im: false, is_mpim: false, user: null, topic: null, purpose: null, num_members: null };
      }
      case "slack_get_channel_history": {
        const ms = (w.history[args.channel_id] ?? [])
          .filter((m) => (!m.thread_ts || m.thread_ts === m.ts) && Number(m.ts) > Number(args.oldest ?? 0))
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        const { slice, next } = page(ms, args.cursor);
        return {
          messages: slice.map((m) => ({ user: m.user ?? null, user_name: m.user ? `${w.users[m.user]?.name ?? m.user} [Team]` : null, text: m.text, ts: m.ts, thread_ts: m.thread_ts ?? null, reply_count: m.reply_count ?? null, permalink: null, blocks: null, attachments: null, files: null })),
          next_cursor: next, enrichment: null,
        };
      }
      case "slack_get_thread_replies": {
        const ms = (w.history[args.channel_id] ?? []).filter((m) => m.ts === args.thread_ts || m.thread_ts === args.thread_ts)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
        return { messages: ms.map((m) => ({ user: m.user ?? null, user_name: null, text: m.text, ts: m.ts, thread_ts: m.thread_ts ?? m.ts, reply_count: null, permalink: null, blocks: null, attachments: null, files: null })), next_cursor: null, enrichment: null };
      }
      case "slack_search_messages": {
        const after = /after:(\S+)/.exec(args.query)?.[1];
        const from = after ? (Date.parse(after) + 864e5) / 1000 : 0;
        let ms = all().filter((m) => Number(m.ts) >= from);
        if (args.query.startsWith("is:dm")) ms = ms.filter((m) => conv(m.channel)?.is_im || conv(m.channel)?.is_mpim);
        else if (args.query.startsWith("from:")) ms = ms.filter((m) => m.user === ME);
        else ms = ms.filter((m) => mentions(m.text, ME));
        ms.sort((a, b) => Number(b.ts) - Number(a.ts));
        const { slice, next } = page(ms, args.cursor, w.pageSize ?? args.count);
        return { matches: slice.map((m) => ({ channel_id: m.channel, user_id: m.user ?? null, ts: m.ts, text: m.text, permalink: permalink(m.channel, m) })), total: ms.length, next_cursor: next };
      }
    }
    throw new Error("unexpected " + tool);
  };
}

function fakeDirect(world: (tool: string, args: any) => unknown) {
  const calls: { tool: string; args: any }[] = [];
  let runs = 0;
  const direct = {
    call: async (tool: string, args: any) => {
      runs++;
      calls.push({ tool, args });
      return world(tool, args);
    },
  };
  return { direct, calls, runs: () => runs };
}

const TMP = join(tmpdir(), "cy-slack-test");
const deps = (d: any, extra: Record<string, unknown> = {}) => ({ direct: d, now: () => NOW, cwd: TMP, ...extra });

const baseWorld = (): World => ({
  users: { UA: { name: "alice" }, UB: { name: "bob" }, [ME]: { name: "me" }, UBOT: { name: "ci", bot: true } },
  convs: [
    { id: "C1", name: "dev" },
    { id: "C2", name: "random" },
    { id: "D1", is_im: true, user: "UA" },
    { id: "G1", is_mpim: true, name: "mpdm-alice--bob--me-1" },
  ],
  history: {
    D1: [
      { ts: ts(30), user: "UA", text: "점심 뭐 먹어?" },
      { ts: ts(10), user: "UA", text: "?" },
      { ts: ts(60 * 24 * 5), user: "UA", text: "아주 옛날" }, // 3일 백필 밖
    ],
    G1: [{ ts: ts(15), user: "UB", text: "회의 언제?" }],
    C1: [
      { ts: ts(40), user: "UB", text: "<@UME> 리뷰 부탁" },
      { ts: ts(35), user: "UBOT", text: "build ok" },
      { ts: ts(34), user: "UBOT", text: "<@UME> 장애" },
      { ts: ts(33), user: null, text: "\n" }, // 작성자 없는 시스템 메시지
      { ts: ts(50), user: ME, text: "배포 이슈 정리", reply_count: 2, thread_ts: ts(50) },
      { ts: ts(45), user: "UA", text: "확인할게요", thread_ts: ts(50) },
      { ts: ts(42), user: "UB", text: "저도요", thread_ts: ts(50) },
    ],
    C2: [],
  },
});

test("mentions / permalink / parseToolResponse / callKey", () => {
  assert.ok(mentions("hi <@UME> look", ME));
  assert.ok(mentions("hi <@UME|me>", ME));
  assert.ok(!mentions("hi <@UMEX>", ME));
  assert.equal(permalinkOf("https://a.slack.com/", "C1", "1.000200", "1.000100"),
    "https://a.slack.com/archives/C1/p1000200?thread_ts=1.000100&cid=C1");
  assert.deepEqual(parseToolResponse('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolResponse([{ type: "text", text: '{"a":2}' }]), { a: 2 });
  assert.deepEqual(parseToolResponse({ content: [{ type: "text", text: '{"a":3}' }] }), { a: 3 });
  assert.ok(parseToolResponse("Error: boom").error);
  assert.equal(callKey("t", { b: 1, a: null, c: { y: 2, x: 1 } }), callKey("t", { c: { x: 1, y: 2 }, b: 1 }));
});

test("첫 수집: DM·그룹 DM은 검색으로, 채널은 history로, 이름·라벨·그래프·봇 노이즈·스레드", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  const f = fakeDirect(slackWorld(w));
  const ing = new SlackIngester(cfg, store, deps(f.direct));
  const r = await ing.run();

  assert.equal(r.errors, 0);
  assert.equal(r.truncated, false);
  assert.equal(r.costUsd, 0);
  // D1 2 + G1 1 + C1(멘션 1 + 봇 멘션 1 + 내 부모 1 + 답글 2) = 8
  assert.equal(r.messages, 8);
  assert.equal(r.mentions, 2);
  assert.equal(r.threads, 1);
  const tools = f.calls.map((c) => c.tool);
  assert.equal(tools.filter((t) => t === "slack_whoami").length, 1);
  assert.ok(tools.includes("slack_list_accessible_channels"));
  // DM은 history로 안 부른다(검색으로 받음), 채널은 부른다
  const hist = f.calls.filter((c) => c.tool === "slack_get_channel_history").map((c) => c.args.channel_id).sort();
  assert.deepEqual(hist, ["C1", "C2"]);
  assert.equal(tools.at(-1), "slack_get_users", "이름 조회는 맨 끝에 한 번에");

  assert.equal(store.node("channel:D1")?.label, "DM with Alice  Kim".replace(/\s+/g, " "));
  assert.equal(store.node("channel:G1")?.label, "Group DM: alice, bob, me");
  assert.equal(store.node("channel:C1")?.label, "#dev");
  assert.equal(store.node("person:UA")?.label, "Alice Kim");
  assert.equal(store.node(`person:${ME}`)?.props.isMe, true);

  const mid = `message:C1:${ts(40)}`;
  const m = store.node(mid)!;
  assert.equal(m.props.mentionsMe, true);
  assert.equal(m.props.isDM, false);
  assert.deepEqual(store.neighbors(mid, "from"), ["person:UB"]);
  assert.deepEqual(store.neighbors(mid, "in"), ["channel:C1"]);
  assert.equal(store.node(`message:C1:${ts(35)}`), undefined, "bot noise skipped");
  assert.ok(store.node(`message:C1:${ts(34)}`), "bot mentioning me kept");
  assert.equal(store.node(`message:C1:${ts(33)}`), undefined, "authorless skipped");
  assert.equal(store.node(`message:D1:${ts(60 * 24 * 5)}`), undefined, "outside backfill");
  assert.equal(store.node(`message:D1:${ts(30)}`)?.props.isDM, true);
  assert.equal(store.node(`message:G1:${ts(15)}`)?.props.isDM, true);
  // 내가 쓴 부모의 스레드 답글
  assert.deepEqual(store.neighbors(`message:C1:${ts(45)}`, "replyTo"), [`message:C1:${ts(50)}`]);
  assert.equal(store.node(`message:C1:${ts(50)}`)?.props.fromMe, true);
});

test("증분: 두 번째 사이클은 커서 이후만, whoami·채널 목록은 다시 안 부르고 새 것만 센다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  const f = fakeDirect(slackWorld(w));
  const ing = new SlackIngester(cfg, store, deps(f.direct));
  await ing.run();
  const before = f.calls.length;

  w.history.D1.push({ ts: ts(2), user: "UA", text: "아직?" });
  w.history.C1.push({ ts: ts(3), user: "UB", text: "그냥 잡담" });
  w.history.C1.push({ ts: ts(1), user: "UB", text: "스레드 답", thread_ts: ts(50) });
  const r2 = await ing.run();
  assert.equal(r2.messages, 3);
  const second = f.calls.slice(before);
  assert.ok(!second.some((c) => c.tool === "slack_whoami"), "whoami cached");
  assert.ok(!second.some((c) => c.tool === "slack_list_accessible_channels"), "channel list cached (TTL)");
  const h = second.find((c) => c.tool === "slack_get_channel_history" && c.args.channel_id === "C1")!;
  assert.equal(h.args.oldest, ts(33), "C1 cursor = newest top-level ts");
  assert.ok(!second.some((c) => c.tool === "slack_get_channel_history" && c.args.channel_id === "C2"), "quiet channel backs off");
  assert.ok(second.some((c) => c.tool === "slack_get_thread_replies"), "tracked thread polled");
  assert.ok(!second.some((c) => c.tool === "slack_get_users"), "names cached");
  assert.deepEqual(store.neighbors(`message:C1:${ts(1)}`, "replyTo"), [`message:C1:${ts(50)}`]);

  const r3 = await ing.run();
  assert.equal(r3.messages, 0);
});

test("멘션 검색: 멤버 아닌 채널의 스레드 멘션을 잡고, 채널 이름을 조회하고, 스레드를 추적한다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  const pt = ts(100);
  w.history.C9 = [
    { ts: pt, user: "UB", text: "parent", thread_ts: pt, reply_count: 1 },
    { ts: ts(20), user: "UB", text: "<@UME> 확인 부탁", thread_ts: pt },
  ];
  const f = fakeDirect(slackWorld(w));
  const r = await new SlackIngester(cfg, store, deps(f.direct)).run();
  const m = store.node(`message:C9:${ts(20)}`)!;
  assert.equal(m.props.mentionsMe, true);
  assert.equal(m.props.thread_ts, pt);
  assert.equal(store.node("channel:C9")?.label, "#ops");
  assert.ok(f.calls.some((c) => c.tool === "slack_get_channel_info" && c.args.channel_id === "C9"));
  assert.ok(f.calls.some((c) => c.tool === "slack_get_thread_replies" && c.args.channel_id === "C9" && c.args.thread_ts === pt));
  assert.ok(store.node(`message:C9:${pt}`), "parent fetched via replies");
  assert.ok(r.threads >= 2);
});


test("레이트 리밋 에러는 세고 다시 부른다, 호출 상한이면 truncated", async () => {
  const store = new Store(":memory:");
  const w = { ...baseWorld(), failOnce: ["slack_get_channel_history"] };
  const f = fakeDirect(slackWorld(w));
  const r = await new SlackIngester(cfg, store, deps(f.direct)).run();
  assert.equal(r.rateLimited, 1);
  assert.equal(r.errors, 0);
  assert.ok(store.node(`message:C1:${ts(40)}`) && store.node(`message:C1:${ts(40)}`));

  const g = fakeDirect(slackWorld(baseWorld()));
  const r2 = await new SlackIngester(cfg, new Store(":memory:"), deps(g.direct, { maxCalls: 4 })).run();
  assert.equal(r2.truncated, true);
  assert.ok(g.calls.filter((c) => c.tool !== "slack_get_users" && c.tool !== "slack_get_channel_info").length <= 4);
});

test("DM 검색 페이지네이션: 시간 역순 결과에서 커서보다 오래된 게 나오면 멈춘다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  w.pageSize = 2;
  w.history.D1 = Array.from({ length: 7 }, (_, i) => ({ ts: ts(100 - i * 10), user: "UA", text: `m${i}` }));
  const f = fakeDirect(slackWorld(w));
  const ing = new SlackIngester(cfg, store, deps(f.direct));
  await ing.run();
  assert.equal(store.db.prepare("SELECT count(*) n FROM nodes WHERE id LIKE 'message:D1:%'").get()!.n, 7);
  const before = f.calls.length;
  w.history.D1.push({ ts: ts(1), user: "UA", text: "new" });
  const r = await ing.run();
  assert.equal(r.messages, 1);
  const dmSearches = f.calls.slice(before).filter((c) => c.tool === "slack_search_messages" && c.args.query.startsWith("is:dm"));
  assert.ok(dmSearches.length <= 6, `stopped early (${dmSearches.length})`);
});

test("attentionSince: 답 안 한 DM·멘션만, DM은 대화 단위로 묶고 내가 뒤에 답했으면 뺀다", async () => {
  const store = new Store(":memory:");
  const p = ts(50);
  const w: World = {
    users: { UA: { name: "alice" }, UB: { name: "bob" }, [ME]: { name: "me" } },
    convs: [
      { id: "D1", is_im: true, user: "UA" },
      { id: "D2", is_im: true, user: "UB" },
      { id: "C1", name: "dev" },
    ],
    history: {
      D1: [{ ts: ts(30), user: "UA", text: "질문1" }, { ts: ts(20), user: "UA", text: "질문2" }],
      D2: [{ ts: ts(30), user: "UB", text: "됐어?" }, { ts: ts(25), user: ME, text: "응" }],
      C1: [
        { ts: ts(40), user: "UB", text: "<@UME> 리뷰" },                                      // 미응답
        { ts: p, user: "UA", text: "<@UME> 이거", reply_count: 1, thread_ts: p },             // 스레드로 답함
        { ts: ts(45), user: ME, text: "ok", thread_ts: p },
        { ts: ts(35), user: "UB", text: "그냥 잡담" },                                        // 멘션 아님
      ],
    },
  };
  await new SlackIngester(cfg, store, deps(fakeDirect(slackWorld(w)).direct)).run();
  const items = attentionSince(store, new Date(NOW - 864e5).toISOString());
  assert.deepEqual(items.map((i) => i.channel).sort(), ["C1", "D1"]);
  const dm = items.find((i) => i.channel === "D1")!;
  assert.equal(dm.count, 2);
  assert.equal(dm.text, "질문2");
  assert.equal(dm.authorName, "Alice Kim");
  assert.equal(dm.channelLabel, "DM with Alice Kim");
  const men = items.find((i) => i.channel === "C1")!;
  assert.equal(men.mentionsMe, true);
  assert.equal(men.permalink, `https://acme.slack.com/archives/C1/p${ts(40).replace(".", "")}`);
  assert.match(formatAttention(items), /DM with Alice Kim · Alice Kim: 질문2 \(\+1\)/);
  assert.equal(formatAttention([]), "(답 안 한 Slack DM·멘션 없음)");
});

test("동시 실행 방지: 돌고 있으면 바로 0을 돌려준다", async () => {
  const f = fakeDirect(slackWorld(baseWorld()));
  const ing = new SlackIngester(cfg, new Store(":memory:"), deps(f.direct));
  const [a, b] = await Promise.all([ing.run(), ing.run()]);
  assert.ok(a.messages > 0);
  assert.equal(b.messages, 0);
});
