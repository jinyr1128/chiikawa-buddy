import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubSync, githubMerge, githubReply, htmlUrl } from "./github-sync.ts";
import { Inbox, setInbox, cleanAct } from "./inbox.ts";
import { slackReply } from "./slack-reply.ts";

test("GitHub 알림 → 알림함(답장 정보), 승인된 내 PR → [머지]", async () => {
  const box = new Inbox(); setInbox(box);
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1].startsWith("notifications")) return JSON.stringify([{ id: "1", updated_at: "2026-10-19T10:00:00Z", reason: "review_requested", repository: { full_name: "o/r" }, subject: { type: "PullRequest", title: "로그인 고침", url: "https://api.github.com/repos/o/r/pulls/7", latest_comment_url: null } }]);
    if (args[1].startsWith("search/issues")) return JSON.stringify({ items: [{ number: 9, title: "새 기능", repository_url: "https://api.github.com/repos/o/r", html_url: "https://github.com/o/r/pull/9" }] });
    if (args[1] === "repos/o/r/pulls/9") return JSON.stringify({ state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "abc" } });
    return "{}";
  };
  await new GithubSync(gh).tick();
  const xs = box.list();
  const review = xs.find((x) => /리뷰 요청/.test(x.title))!;
  assert.equal(review.link, "https://github.com/o/r/pull/7");
  assert.deepEqual(review.act, { reply: { kind: "github", repo: "o/r", number: 7 } });
  const merge = xs.find((x) => /머지할 수 있어요/.test(x.title))!;
  assert.deepEqual(merge.act?.merge, { repo: "o/r", number: 9 });
  setInbox(null);
});

test("머지·답장은 검증한 값으로만 gh 를 부른다", async () => {
  const seen: { args: string[]; input?: string }[] = [];
  const gh = async (args: string[], input?: string) => { seen.push({ args, input }); return JSON.stringify({ html_url: "u" }); };
  assert.deepEqual(await githubMerge({ repo: "o/r", number: 3 }, gh), { ok: true });
  assert.deepEqual(seen[0].args, ["pr", "merge", "3", "-R", "o/r", "--merge"]);
  assert.equal((await githubMerge({ repo: "-x/y", number: 3 }, gh)).ok, false);
  assert.equal((await githubReply({ repo: "o/r", number: 3, text: "  " }, gh)).ok, false);
  const r = await githubReply({ repo: "o/r", number: 3, text: "확인했어요" }, gh);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(seen.at(-1)!.input!).body, "확인했어요");
  assert.equal(htmlUrl("https://api.github.com/repos/o/r/issues/5", "o/r"), "https://github.com/o/r/issues/5");
  assert.equal(cleanAct({ reply: { kind: "slack", channel: "nope" } }), undefined);
});

test("Slack 답장: 쓰기 권한이 없으면 고치는 방법을 알려 준다", async () => {
  const f = (async () => ({ json: async () => ({ ok: false, error: "missing_scope" }) })) as any;
  const r = await slackReply({ channel: "C0123456", ts: "1790000000.123", text: "네" }, "xoxp-1", f);
  assert.equal(r.ok, false);
  assert.match(r.error!, /chat:write/);
  const ok = await slackReply({ channel: "D0123456", text: "네" }, "xoxp-1", (async () => ({ json: async () => ({ ok: true }) })) as any);
  assert.equal(ok.ok, true);
});
