// Slack api 모드(사용자 토큰 Web API): 가짜 WebClient 로 실제 수집 흐름(증분 커서·스레드·멘션·답했음)을 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { loadConfig } from "../config.ts";
import { resolveConnectors } from "../connectors.ts";
import { SlackIngester, attentionSince, mentions } from "./slack.ts";
import { SlackApiTransport, slackErrorText, type SlackWebLike } from "./slack-api.ts";

const ME = "UME";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const ts = (minAgo: number, n = 0) => ((NOW - minAgo * 60e3) / 1000).toFixed(0) + "." + String(n).padStart(6, "0");
const cfg = { ...loadConfig({}), models: { code: "x", general: "x", light: "haiku" } };

type M = { ts: string; user?: string; text: string; thread_ts?: string; reply_count?: number; bot_id?: string };
type World = {
  users: Record<string, { name: string; bot?: boolean }>;
  convs: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string }[];
  history: Record<string, M[]>;
  failOnce?: Record<string, any>; // 메서드 → 던질 오류(한 번)
  pageSize?: number;
};

// Web API 응답 모양(api.slack.com/methods) 그대로의 가짜
function fakeWeb(w: World) {
  const methods: string[] = [];
  const all = () => Object.entries(w.history).flatMap(([ch, ms]) => ms.map((m) => ({ ...m, channel: ch })));
  const conv = (id: string) => w.convs.find((c) => c.id === id);
  const web: SlackWebLike = {
    async apiCall(method, a: any = {}) {
      methods.push(method);
      const f = w.failOnce?.[method];
      if (f) { delete w.failOnce![method]; throw f; }
      switch (method) {
        case "auth.test": return { ok: true, user_id: ME, url: "https://acme.slack.com/", team_id: "T1" };
        case "users.conversations": return { ok: true, channels: w.convs.map((c) => ({ ...c, is_archived: false })), response_metadata: { next_cursor: "" } };
        case "conversations.history": {
          const ms = (w.history[a.channel] ?? []).filter((m) => (!m.thread_ts || m.thread_ts === m.ts) && Number(m.ts) > Number(a.oldest ?? 0))
            .sort((x, y) => Number(y.ts) - Number(x.ts));
          return { ok: true, messages: ms.map((m) => ({ type: "message", ...m })), has_more: false };
        }
        case "conversations.replies": {
          const ms = (w.history[a.channel] ?? []).filter((m) => m.ts === a.ts || m.thread_ts === a.ts).sort((x, y) => Number(x.ts) - Number(y.ts));
          return { ok: true, messages: ms.map((m) => ({ type: "message", thread_ts: a.ts, ...m })), has_more: false };
        }
        case "search.messages": {
          const after = /after:(\S+)/.exec(a.query)?.[1];
          const from = after ? (Date.parse(after) + 864e5) / 1000 : 0;
          let ms = all().filter((m) => Number(m.ts) >= from);
          if (a.query.startsWith("is:dm")) ms = ms.filter((m) => conv(m.channel)?.is_im || conv(m.channel)?.is_mpim);
          else if (a.query.startsWith("from:")) ms = ms.filter((m) => m.user === ME);
          else ms = ms.filter((m) => mentions(m.text, ME));
          ms.sort((x, y) => Number(y.ts) - Number(x.ts));
          const size = w.pageSize ?? a.count, pages = Math.max(1, Math.ceil(ms.length / size));
          const slice = ms.slice((a.page - 1) * size, a.page * size);
          return {
            ok: true, query: a.query,
            messages: {
              total: ms.length, paging: { count: size, total: ms.length, page: a.page, pages },
              matches: slice.map((m) => ({
                type: "message", ts: m.ts, user: m.user, text: m.text, channel: { id: m.channel, is_im: !!conv(m.channel)?.is_im },
                permalink: `https://acme.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}${m.thread_ts ? `?thread_ts=${m.thread_ts}` : ""}`,
              })),
            },
          };
        }
        case "users.info": {
          const u = w.users[a.user];
          if (!u) throw Object.assign(new Error("An API error occurred: user_not_found"), { code: "slack_webapi_platform_error", data: { ok: false, error: "user_not_found" } });
          return { ok: true, user: { id: a.user, name: u.name, real_name: `${u.name[0].toUpperCase()}${u.name.slice(1)} Kim`, is_bot: !!u.bot } };
        }
        case "conversations.info": return { ok: true, channel: { id: a.channel, name: conv(a.channel)?.name ?? "ops", is_member: !!conv(a.channel) } };
      }
      throw new Error("unexpected " + method);
    },
  };
  return { web, methods };
}

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
      { ts: ts(60 * 24 * 5), user: "UA", text: "아주 옛날" },
    ],
    G1: [{ ts: ts(15), user: "UB", text: "회의 언제?" }],
    C1: [
      { ts: ts(40), user: "UB", text: "<@UME> 리뷰 부탁" },
      { ts: ts(35), user: "UBOT", bot_id: "B1", text: "build ok" },
      { ts: ts(34), user: "UBOT", bot_id: "B1", text: "<@UME> 장애" },
      { ts: ts(50), user: ME, text: "배포 이슈 정리", reply_count: 2, thread_ts: ts(50) },
      { ts: ts(45), user: "UA", text: "확인할게요", thread_ts: ts(50) },
      { ts: ts(42), user: "UB", text: "저도요", thread_ts: ts(50) },
    ],
    C2: [],
  },
});

const READ_ONLY = new Set(["auth.test", "users.conversations", "conversations.history", "conversations.replies", "search.messages", "users.info", "conversations.info"]);
const mk = (store: Store, w: World) => {
  const f = fakeWeb(w);
  const ing = new SlackIngester(cfg, store, { direct: new SlackApiTransport(f.web), now: () => NOW });
  return { ing, methods: f.methods };
};

test("api 모드 첫 수집: 모델 없이 Web API 로 DM·멘션·채널·스레드, 읽기 메서드만", async () => {
  const store = new Store(":memory:");
  const { ing, methods } = mk(store, baseWorld());
  assert.equal(ing.transport, "api");
  const r = await ing.run();
  assert.equal(r.errors, 0);
  assert.equal(r.costUsd, 0);
  assert.equal(r.turns, 0, "모델 턴 없음");
  assert.equal(r.messages, 8); // D1 2 + G1 1 + C1(멘션 1 + 봇 멘션 1 + 내 부모 1 + 답글 2)
  assert.equal(r.mentions, 2);
  assert.equal(r.threads, 1);
  assert.ok(methods.every((m) => READ_ONLY.has(m)), `읽기 메서드만: ${[...new Set(methods)]}`);
  assert.equal(methods.filter((m) => m === "auth.test").length, 1);
  assert.equal(store.node("channel:D1")?.label, "DM with Alice Kim");
  assert.equal(store.node("channel:G1")?.label, "Group DM: alice, bob, me");
  assert.equal(store.node(`message:C1:${ts(35)}`), undefined, "봇 잡음은 버림");
  assert.ok(store.node(`message:C1:${ts(34)}`), "나를 멘션한 봇은 남김");
  assert.deepEqual(store.neighbors(`message:C1:${ts(45)}`, "replyTo"), [`message:C1:${ts(50)}`]);
  assert.equal(store.node(`person:${ME}`)?.props.isMe, true);
});

test("api 모드 증분: 커서 이후만, whoami·채널 목록·이름은 다시 안 부른다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  const { ing, methods } = mk(store, w);
  await ing.run();
  const before = methods.length;
  w.history.D1.push({ ts: ts(2), user: "UA", text: "아직?" });
  w.history.C1.push({ ts: ts(3), user: "UB", text: "그냥 잡담" });
  w.history.C1.push({ ts: ts(1), user: "UB", text: "스레드 답", thread_ts: ts(50) });
  const r2 = await ing.run();
  assert.equal(r2.messages, 3);
  const second = methods.slice(before);
  assert.ok(!second.includes("auth.test"));
  assert.ok(!second.includes("users.conversations"));
  assert.ok(!second.includes("users.info"));
  assert.ok(second.includes("conversations.replies"), "추적 스레드");
  assert.equal((await ing.run()).messages, 0);
});

test("api 모드 '이미 답함': 내가 뒤에 답한 DM·스레드는 답 안 한 목록에서 빠진다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  const { ing } = mk(store, w);
  await ing.run();
  const since = new Date(NOW - 24 * 3600e3).toISOString();
  const before = attentionSince(store, since);
  assert.ok(before.some((i) => i.channel === "D1"), "D1 답 안 함");
  assert.ok(before.some((i) => i.channel === "C1" && i.mentionsMe));
  w.history.D1.push({ ts: ts(1), user: ME, text: "짜장면!" });
  await ing.run();
  const after = attentionSince(store, since);
  assert.ok(!after.some((i) => i.channel === "D1"), "답했으니 빠짐");
  assert.ok(after.every((i) => !i.permalink || i.permalink.startsWith("https://acme.slack.com/archives/")));
});

test("api 모드 레이트리밋: 이번 사이클은 접고(truncated) 다음 사이클에 이어 간다", async () => {
  const store = new Store(":memory:");
  const w = baseWorld();
  w.failOnce = { "conversations.history": Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 3 }) };
  const { ing } = mk(store, w);
  const r = await ing.run();
  assert.equal(r.rateLimited, 1);
  assert.equal(r.truncated, true);
  const r2 = await ing.run();
  assert.equal(r2.rateLimited, 0);
  assert.ok(store.node(`message:C1:${ts(40)}`), "다음 사이클에 채널을 마저 읽음");
});

test("어댑터: search.messages page ↔ 커서, 오류 문자열, 지원 안 하는 호출", async () => {
  const w = baseWorld();
  w.pageSize = 2;
  const t = new SlackApiTransport(fakeWeb(w).web);
  const p1 = await t.call("slack_search_messages", { query: "is:dm after:2026-10-01", count: 50 });
  assert.equal(p1.matches.length, 2);
  assert.equal(p1.next_cursor, "2");
  assert.equal(p1.matches[0].channel_id, "D1");
  const p2 = await t.call("slack_search_messages", { query: "is:dm after:2026-10-01", count: 50, cursor: "2" });
  assert.equal(p2.next_cursor, undefined);
  assert.match((await t.call("slack_post_message", {})).error, /지원하지 않는/);
  assert.equal(slackErrorText({ data: { error: "missing_scope" } }), "missing_scope");
  assert.match(slackErrorText({ code: "slack_webapi_rate_limited_error", retryAfter: 7 }), /ratelimited retry after 7/);
  const users = await t.call("slack_get_users", { user_ids: ["UA", "UNOPE"] });
  assert.deepEqual(users.users.map((u: any) => u.id), ["UA"], "없는 사람은 건너뜀");
});

test("커넥터로 전송 고르기: api(토큰)·mcp/off(수집 안 함)", async () => {
  const store = new Store(":memory:");
  const withConn = (connectors: any) => ({ ...cfg, connectors: resolveConnectors({}, { connectors }) });
  assert.equal(new SlackIngester(withConn({ slack: { mode: "api", userToken: "xoxp-1" } }), store).transport, "api");
  assert.equal(new SlackIngester(withConn({ slack: { mode: "api" } }), store).transport, null, "토큰 없으면 끔");
  assert.equal(new SlackIngester(withConn({ slack: "gateway" }), store).transport, null);
  assert.equal(new SlackIngester(withConn({ slack: { mode: "mcp", preset: "slack-mcp-server" } }), store).transport, null);
  const off = new SlackIngester(withConn({ slack: "off" }), store);
  assert.equal(off.transport, null);
  const r = await off.run();
  assert.equal(r.calls, 0);
  assert.equal(r.messages, 0);
});
