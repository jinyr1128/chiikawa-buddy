import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGitCache, findRepos, gitActivity, kstMidnight } from "./git.ts";

const ME = { name: "DemoUser", email: "me@users.noreply.github.com" };

export function commit(repo: string, msg: string, who: { name: string; email: string }, date: string) {
  writeFileSync(join(repo, "f.txt"), `${msg}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", msg], {
    cwd: repo,
    env: {
      ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    },
  });
}

export function initRepo(dir: string, localEmail?: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  if (localEmail) execFileSync("git", ["config", "user.email", localEmail], { cwd: dir });
}

test("kstMidnight: 이 맥의 시간대 기준 오늘 0시(시험은 TZ=Asia/Seoul)", () => {
  const at = (iso: string) => Date.parse(kstMidnight(new Date(iso)));
  assert.equal(at("2026-10-08T16:30:00Z"), Date.parse("2026-10-09T00:00:00+09:00")); // KST 10/9 01:30
  assert.equal(at("2026-10-08T14:59:00Z"), Date.parse("2026-10-08T00:00:00+09:00"));
});

test("git: 깊이 2 스캔, 내 커밋만(이메일·이름·로컬 user.email), 오늘 KST 기준", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cy-git-")));
  const a = join(root, "a"), b = join(root, "group", "b");
  initRepo(a);
  initRepo(b, "local@mac.local");
  initRepo(join(root, "group", "deep", "c")); // 깊이 3 — 무시
  initRepo(join(root, "node_modules", "x"));
  mkdirSync(join(root, "broken", ".git"), { recursive: true }); // 깨진 레포 — 건너뜀

  const now = new Date("2026-10-08T05:00:00Z"); // KST 14:00
  commit(a, "어제 내 커밋", ME, "2026-10-07T10:00:00+09:00");
  commit(a, "오늘 남의 커밋", { name: "Other", email: "o@x.com" }, "2026-10-08T09:00:00+09:00");
  commit(a, "feat: 오늘 내 커밋", { name: "Someone", email: ME.email }, "2026-10-08T10:00:00+09:00");
  commit(a, "자정 직전", { name: "DemoUser", email: "z@z.z" }, "2026-10-07T23:59:00+09:00");
  commit(b, "로컬 이메일 커밋", { name: "김지우", email: "local@mac.local" }, "2026-10-08T00:30:00+09:00");

  assert.deepEqual(findRepos([root]).sort(), [a, join(root, "broken"), b].sort());
  clearGitCache();
  const acts = await gitActivity({ repoRoots: [root], gitAuthor: ME }, { now });
  const byName = Object.fromEntries(acts.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ["a", "b"]);
  assert.deepEqual(byName.a.commitsToday.map((c) => c.subject), ["feat: 오늘 내 커밋"]);
  assert.deepEqual(byName.a.recentCommits.map((c) => c.subject), ["feat: 오늘 내 커밋", "자정 직전", "어제 내 커밋"]);
  assert.equal(byName.a.branch, "main");
  assert.match(byName.a.commitsToday[0].sha, /^[0-9a-f]{7}$/);
  assert.equal(byName.a.commitsToday[0].time, "2026-10-08T01:00:00.000Z");
  assert.equal(byName.b.commitsToday.length, 1);

  // 캐시: 새 커밋이 생겨도 60초 안에는 같은 결과
  commit(a, "또 오늘", ME, "2026-10-08T11:00:00+09:00");
  assert.equal((await gitActivity({ repoRoots: [root], gitAuthor: ME }, { now })).find((x) => x.name === "a")!.commitsToday.length, 1);
  clearGitCache();
  assert.equal((await gitActivity({ repoRoots: [root], gitAuthor: ME }, { now })).find((x) => x.name === "a")!.commitsToday.length, 2);
});

test("git: 없는 루트는 빈 배열", async () => {
  clearGitCache();
  assert.deepEqual(await gitActivity({ repoRoots: ["/nonexistent/x"], gitAuthor: ME }), []);
});
