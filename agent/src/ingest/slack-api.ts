// Slack "api" 모드 전송: 내 Slack 앱의 사용자 토큰(xoxp-…)으로 Web API 를 직접 부른다. 모델 중계 없음, 결정적.
//
// SlackRun(ingest/slack.ts)은 읽기 도구 이름·인자로 호출을 계획한다. 여기서 그걸 Web API 로 옮기고
// 응답을 같은 모양으로 맞춰 돌려준다 — 커서·스레드 추적·멘션·"답했음" 판정 로직은 그대로 같이 쓴다.
//
//   slack_whoami                   → auth.test                 { user_id, url }
//   slack_list_accessible_channels → users.conversations       { channels, next_cursor }
//   slack_get_channel_history      → conversations.history     { messages, next_cursor }
//   slack_get_thread_replies       → conversations.replies     { messages, next_cursor }
//   slack_search_messages          → search.messages           { matches:[{ts, channel_id, user_id, text, permalink}], next_cursor(=다음 page), total }
//   slack_get_users                → users.info × n            { users }
//   slack_get_channel_info         → conversations.info        { …channel }
//
// 필요한 사용자 스코프(읽기만): channels:history groups:history im:history mpim:history
//   channels:read groups:read im:read mpim:read users:read search:read — ops/slack-user-manifest.yaml
// 레이트리밋: 재시도는 SlackRun/RateGate 가 하도록 WebClient 는 바로 실패시킨다(rejectRateLimitedCalls) → "ratelimited retry after N"
import { WebClient } from "@slack/web-api";

// WebClient 에서 우리가 쓰는 부분만(테스트는 가짜를 넣는다)
export type SlackWebLike = { apiCall(method: string, options?: Record<string, unknown>): Promise<any> };

export type SlackDirect = { call(tool: string, args: Record<string, unknown>): Promise<any> };

export function slackWebClient(token: string): SlackWebLike {
  return new WebClient(token, { rejectRateLimitedCalls: true, retryConfig: { retries: 1 } }) as unknown as SlackWebLike;
}

const READ_METHODS = new Set(["auth.test", "users.conversations", "conversations.history", "conversations.replies", "search.messages", "users.info", "conversations.info"]);

// 오류를 SlackRun 이 읽는 문자열로(레이트리밋은 isRateLimit/retryAfterMs 가 알아보게)
export function slackErrorText(e: any): string {
  if (e?.code === "slack_webapi_rate_limited_error" || e?.data?.error === "ratelimited") return `ratelimited retry after ${Number(e?.retryAfter ?? 60)}`;
  return String(e?.data?.error ?? e?.message ?? e ?? "error").slice(0, 200);
}

const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export class SlackApiTransport implements SlackDirect {
  web: SlackWebLike;
  calls = 0;
  constructor(web: SlackWebLike) { this.web = web; }

  private async api(method: string, options: Record<string, unknown>): Promise<any> {
    if (!READ_METHODS.has(method)) throw new Error(`읽기 전용: ${method} 불가`); // 쓰기 메서드는 부를 길이 없다
    this.calls++;
    return this.web.apiCall(method, options);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    try {
      return await this.dispatch(tool, args);
    } catch (e) {
      return { error: slackErrorText(e) };
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<any> {
    const cursor = s(a.cursor);
    switch (tool) {
      case "slack_whoami": {
        const r = await this.api("auth.test", {});
        return { user_id: r.user_id, url: r.url, team_id: r.team_id };
      }
      case "slack_list_accessible_channels": {
        const types = Array.isArray(a.conversation_types) ? (a.conversation_types as string[]).join(",") : "im,mpim,private_channel,public_channel";
        const r = await this.api("users.conversations", { types, limit: n(a.limit, 200), exclude_archived: true, ...(cursor ? { cursor } : {}) });
        return { channels: r.channels ?? [], next_cursor: s(r.response_metadata?.next_cursor) };
      }
      case "slack_get_channel_history": {
        const r = await this.api("conversations.history", {
          channel: a.channel_id, limit: n(a.limit, 100),
          ...(s(a.oldest) ? { oldest: a.oldest } : {}), ...(s(a.latest) ? { latest: a.latest } : {}),
          ...(a.inclusive != null ? { inclusive: !!a.inclusive } : {}), ...(cursor ? { cursor } : {}),
        });
        return { messages: r.messages ?? [], next_cursor: r.has_more ? s(r.response_metadata?.next_cursor) : undefined };
      }
      case "slack_get_thread_replies": {
        const r = await this.api("conversations.replies", { channel: a.channel_id, ts: a.thread_ts, limit: n(a.limit, 200), ...(cursor ? { cursor } : {}) });
        return { messages: r.messages ?? [], next_cursor: r.has_more ? s(r.response_metadata?.next_cursor) : undefined };
      }
      case "slack_search_messages": {
        // search.messages 는 page 번호로 넘긴다 — 커서 자리에 다음 page 를 넣어 돌려준다. 시간 역순
        const page = cursor ? n(cursor, 1) : 1;
        const r = await this.api("search.messages", { query: a.query, count: Math.min(n(a.count, 20), 100), page, sort: "timestamp", sort_dir: "desc" });
        const m = r.messages ?? {};
        const pages = n(m.paging?.pages ?? m.pagination?.page_count, 1);
        return {
          matches: (m.matches ?? []).map((x: any) => ({
            ts: x.ts, channel_id: x.channel?.id ?? x.channel_id, user_id: x.user ?? undefined, text: x.text ?? "", permalink: x.permalink,
          })),
          total: Number(m.total ?? m.paging?.total ?? 0),
          next_cursor: page < pages ? String(page + 1) : undefined,
        };
      }
      case "slack_get_users": {
        const ids = (Array.isArray(a.user_ids) ? a.user_ids : []).filter((x): x is string => typeof x === "string").slice(0, 100);
        const users: any[] = [];
        for (const id of ids) {
          try {
            const r = await this.api("users.info", { user: id });
            if (r.user) users.push({ id: r.user.id, name: r.user.name, real_name: r.user.real_name || r.user.profile?.real_name || r.user.profile?.display_name, is_bot: !!r.user.is_bot });
          } catch (e: any) {
            const t = slackErrorText(e);
            if (/ratelimited/.test(t)) throw e; // 레이트리밋은 호출 전체를 다시
          }
        }
        return { users };
      }
      case "slack_get_channel_info": {
        const r = await this.api("conversations.info", { channel: a.channel_id });
        return { ...(r.channel ?? {}) };
      }
      default:
        return { error: `api 모드에서 지원하지 않는 호출: ${tool}` };
    }
  }
}
