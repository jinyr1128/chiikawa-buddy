// Slack 바로 답장: 알림 카드의 [답장]에서 쓴 글을 그 대화(스레드)에 내 이름으로 보낸다(chat.postMessage, 사용자 토큰).
// Slack 앱에 쓰기 권한(chat:write 사용자 스코프)이 있어야 한다 — 없으면 고치는 방법을 알려 준다.
const CH_RE = /^[CDG][A-Z0-9]{6,20}$/;
const TS_RE = /^\d{9,11}\.\d{1,7}$/;
export async function slackReply(b: unknown, token: string | undefined, f: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  const { channel, ts, text } = (b ?? {}) as { channel?: unknown; ts?: unknown; text?: unknown };
  if (!token) return { ok: false, error: "Slack 이 연결돼 있지 않아요." };
  if (typeof channel !== "string" || !CH_RE.test(channel) || (ts !== undefined && (typeof ts !== "string" || !TS_RE.test(ts)))) return { ok: false, error: "대화방 정보가 이상해요." };
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || body.length > 4000) return { ok: false, error: "답장 내용을 적어 주세요." };
  try {
    const r = await f("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text: body, ...(ts ? { thread_ts: ts } : {}) }),
      signal: AbortSignal.timeout(15e3),
    });
    const j: any = await r.json();
    if (j.ok) return { ok: true };
    if (j.error === "missing_scope" || j.error === "not_allowed_token_type") return { ok: false, error: "Slack 앱에 쓰기 권한이 없어요. api.slack.com/apps → 치이카와 비서 → OAuth & Permissions → User Token Scopes 에 chat:write 를 추가하고 Reinstall 한 뒤, 새 User OAuth Token 을 다시 넣어 주세요." };
    return { ok: false, error: `Slack 이 거절했어요: ${j.error}` };
  } catch (e: any) { return { ok: false, error: `보내지 못했어요: ${e?.message ?? e}` }; }
}
