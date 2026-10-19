import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSlack, disconnectSlack, slackInfo } from "./connections-overview.ts";

const res = (ok: boolean, scopes: string, extra: object = {}) => (async () => ({ json: async () => ({ ok, team: "goorm", user: "me", ...extra }), headers: { get: () => scopes } })) as any;

test("Slack 앱 안에서 연결: 열쇠 모양 확인 → auth.test → config 에 저장(다른 칸은 그대로), 답장 권한 여부", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "cs-")), "config.json");
  writeFileSync(p, JSON.stringify({ character: "x", connectors: { mail: { mode: "imap" } } }));
  assert.equal((await connectSlack(p, { token: "xoxb-123" }, res(true, ""))).ok, false);
  const r = await connectSlack(p, { token: "xoxp-1234567890-abcdefghijklmnop" }, res(true, "im:history,chat:write"));
  assert.equal(r.ok, true);
  assert.equal(r.canReply, true);
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(cfg.character, "x");
  assert.equal(cfg.connectors.mail.mode, "imap");
  assert.equal(cfg.connectors.slack.userToken, "xoxp-1234567890-abcdefghijklmnop");
  assert.equal((await slackInfo("xoxp-other-token-aaaaaaaaaaaaaaa", res(true, "im:history"))).canReply, false);
  assert.equal((await connectSlack(p, { token: "xoxp-1234567890-zzzzzzzzzzzzzzzz" }, res(false, "", { error: "invalid_auth" }))).ok, false);
  disconnectSlack(p);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).connectors.slack, undefined);
});
