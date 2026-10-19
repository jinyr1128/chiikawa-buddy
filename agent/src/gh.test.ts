import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argv, capOutput, ghEnabled, ghHandlers, ghMcpServer, GH_HINT, GH_MAX_OUT, GH_TOOL_NAMES, isAllowedArgv, repoFind, runGh, shrinkJson, stripAnsi,
  vQueryTokens, GhInputError, _clearGhCache, _resetGhProbe,
} from "./gh.ts";
import { isReadOnlyCall } from "./guard.ts";
import { readOnlyHookFor, stepName, toolOptions } from "./brain.ts";
import { loadConfig } from "./config.ts";

// 가짜 gh: 받은 argv 를 로그에 남기고, 명령에 따라 정해진 답을 낸다
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), "cy-gh-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const k = a.slice(0, 2).join(" ");
const out = (s) => process.stdout.write(s);
if (k === "pr view" && a[2] === "7") { setTimeout(() => out(JSON.stringify({ number: 7, title: "느림" })), 400); }
else if (k === "pr view" && a[2] === "8") { setTimeout(() => out("{}"), 60000); }
else if (k === "pr view" && a[2] === "404") { process.stderr.write("\\u001b[31mGraphQL: Could not resolve to a PullRequest\\u001b[0m\\n"); process.exit(1); }
else if (k === "pr view") out(JSON.stringify({ number: Number(a[2]), title: "제목", state: "MERGED", url: "https://github.com/" + a[4] + "/pull/" + a[2], body: "x".repeat(10000), files: Array.from({ length: 200 }, (_, i) => ({ path: "f" + i })) }));
else if (k === "pr diff") out("\\u001b[32m+added\\u001b[0m\\n" + "-".repeat(100000));
else if (k === "api user") out("me-login\\n");
else if (k === "api user/orgs") out("org-a\\norg-b\\n");
else if (k === "repo view") { if (a[2] === "org-b/target") out(JSON.stringify({ nameWithOwner: "org-b/target", url: "https://github.com/org-b/target" })); else { process.stderr.write("not found"); process.exit(1); } }
else if (k === "search repos") out(JSON.stringify([{ fullName: "zz/other" }, { fullName: "yy/lost" }]));
else out("[]");
`);
  chmodSync(bin, 0o755);
  const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } };
  return { bin, calls };
}

test("argv 틀: 고정 명령 + 검증한 값만", () => {
  assert.deepEqual(argv.prView({ repo: "octo-org/infra-manifests", number: 1817 }).slice(0, 6), ["pr", "view", "1817", "-R", "octo-org/infra-manifests", "--json"]);
  assert.ok(argv.prView({ repo: "o/n", number: 1 }).at(-1)!.includes("mergedBy"));
  assert.deepEqual(argv.prDiff({ repo: "o/n", number: "12" }), ["pr", "diff", "12", "-R", "o/n", "--color", "never"]);
  assert.deepEqual(argv.prList({ repo: "o/n", state: "merged", author: "@me", search: "label:bug fix", limit: 500 }).slice(0, 10),
    ["pr", "list", "-R", "o/n", "--state", "merged", "--author", "@me", "--search=label:bug fix", "--limit"]);
  assert.equal(argv.prList({ repo: "o/n", limit: 500 }).at(-3), "50"); // 상한
  assert.deepEqual(argv.searchPrs({ query: "org:octo-org 1817 -label:wip" }).slice(-4), ["--", "org:octo-org", "1817", "-label:wip"]);
  assert.deepEqual(argv.runList({ repo: "o/n", branch: "feat/x" }).slice(0, 6), ["run", "list", "-R", "o/n", "--branch", "feat/x"]);
  assert.deepEqual(argv.runView({ repo: "o/n", id: 123456789 }).slice(0, 5), ["run", "view", "123456789", "-R", "o/n"]);
  for (const k of ["prView", "prDiff", "prList", "searchPrs", "searchIssues", "issueView", "runList", "runView"] as const) {
    const a = (argv[k] as any)({ repo: "o/n", number: 1, id: 1, query: "x" });
    assert.ok(isAllowedArgv(a), k);
  }
});

test("주입 시도는 거부", () => {
  const bad: [string, () => unknown][] = [
    ["repo flag", () => argv.prView({ repo: "--repo=evil/x", number: 1 })],
    ["repo dash", () => argv.prView({ repo: "-R/x", number: 1 })],
    ["repo shell", () => argv.prView({ repo: "o/n;rm -rf ~", number: 1 })],
    ["repo traversal", () => argv.prView({ repo: "../..", number: 1 })],
    ["repo 3 parts", () => argv.prView({ repo: "a/b/c", number: 1 })],
    ["number flag", () => argv.prView({ repo: "o/n", number: "--web" })],
    ["number float", () => argv.prView({ repo: "o/n", number: 1.5 })],
    ["number neg", () => argv.prView({ repo: "o/n", number: -1 })],
    ["number str", () => argv.prView({ repo: "o/n", number: "12; ls" })],
    ["state", () => argv.prList({ repo: "o/n", state: "--web" })],
    ["author", () => argv.prList({ repo: "o/n", author: "--web" })],
    ["search flag", () => argv.prList({ repo: "o/n", search: "x --web" })],
    ["query long flag", () => argv.searchPrs({ query: "--web" })],
    ["query short flag", () => argv.searchPrs({ query: "foo -w" })],
    ["query flag=", () => argv.searchIssues({ query: "--json=body" })],
    ["query empty", () => argv.searchPrs({ query: "   " })],
    ["query too long", () => argv.searchPrs({ query: "a".repeat(300) })],
    ["query ctrl", () => argv.searchPrs({ query: "a\u0000b" })],
    ["query non-string", () => argv.searchPrs({ query: ["--web"] })],
    ["branch flag", () => argv.runList({ repo: "o/n", branch: "--json" })],
    ["branch traversal", () => argv.runList({ repo: "o/n", branch: "a/../b" })],
    ["run id", () => argv.runView({ repo: "o/n", id: "abc" })],
    ["limit", () => argv.searchPrs({ query: "x", limit: -5 })],
  ];
  for (const [name, fn] of bad) assert.throws(fn, GhInputError, name);
  assert.throws(() => vQueryTokens("-label:bug -x"));
  // 쓰기·임의 명령은 실행기 단에서도 막힘
  for (const a of [["pr", "merge", "1"], ["pr", "create"], ["api", "repos/o/n/pulls", "-X", "POST"], ["repo", "delete", "o/n"], ["issue", "close", "1"], ["run", "rerun", "1"], ["auth", "logout"]]) {
    assert.equal(isAllowedArgv(a), false, a.join(" "));
  }
});

test("runGh 는 허용 밖 argv 를 실행하지 않는다", async () => {
  const g = fakeGh();
  const r = await runGh(["pr", "merge", "1", "-R", "o/n"], { bin: g.bin });
  assert.equal(r.ok, false);
  assert.equal(g.calls().length, 0);
});

test("핸들러: 입력 거부는 실행 없이 isError", async () => {
  const g = fakeGh();
  const h = ghHandlers({ bin: g.bin });
  const r = await h.pr_view({ repo: "o/n --web", number: 1 } as any);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /입력 거부/);
  assert.equal((await h.search_prs({ query: "--owner=x" })).isError, true);
  assert.equal(g.calls().length, 0);
});

test("pr_view: 실제 argv 로 실행, JSON 긴 본문·배열 줄이고 상한 안", async () => {
  const g = fakeGh();
  const h = ghHandlers({ bin: g.bin });
  const r = await h.pr_view({ repo: "octo-org/infra-manifests", number: 1817 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(g.calls()[0].slice(0, 5), ["pr", "view", "1817", "-R", "octo-org/infra-manifests"]);
  const j = JSON.parse(r.content[0].text);
  assert.equal(j.state, "MERGED");
  assert.equal(j.url, "https://github.com/octo-org/infra-manifests/pull/1817");
  assert.ok(j.body.length < 4100);
  assert.equal(j.files.length, 61); // 60 + "…(140개 더)"
  assert.ok(r.content[0].text.length <= GH_MAX_OUT + 100);
});

test("gh 실패는 stderr(ANSI 걷음)를 isError 로", async () => {
  const g = fakeGh();
  const r = await ghHandlers({ bin: g.bin }).pr_view({ repo: "o/n", number: 404 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Could not resolve/);
  assert.doesNotMatch(r.content[0].text, /\u001b/);
});

test("pr_diff: ANSI 걷고 30KB 로 자름", async () => {
  const g = fakeGh();
  const r = await ghHandlers({ bin: g.bin }).pr_diff({ repo: "o/n", number: 1 });
  const t = r.content[0].text;
  assert.ok(t.startsWith("+added\n"));
  assert.doesNotMatch(t, /\u001b/);
  assert.ok(t.length <= GH_MAX_OUT + 100, String(t.length));
  assert.match(t, /잘림/);
});

test("출력 상한·ANSI·JSON 줄이기 단위", () => {
  assert.equal(capOutput("abc", 10), "abc");
  assert.ok(capOutput("a".repeat(50), 10).startsWith("a".repeat(10) + "\n…"));
  assert.equal(stripAnsi("\u001b[1;31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "red link");
  assert.deepEqual(shrinkJson({ a: "xxxxx", b: [1, 2, 3] }, 3, 2), { a: "xxx…(2자 잘림)", b: [1, 2, "…(1개 더)"] });
});

test("비동기: 느린 gh 동안에도 이벤트 루프가 돈다", async () => {
  const g = fakeGh();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  const r = await ghHandlers({ bin: g.bin }).pr_view({ repo: "o/n", number: 7 });
  clearInterval(iv);
  assert.ok(Date.now() - t0 >= 350);
  assert.ok(ticks >= 15, `ticks=${ticks}`);
  assert.match(r.content[0].text, /느림/);
});

test("타임아웃: 끝나지 않는 gh 는 잘리고 isError", async () => {
  const g = fakeGh();
  const t0 = Date.now();
  const r = await ghHandlers({ bin: g.bin, timeoutMs: 500 }).pr_view({ repo: "o/n", number: 8 });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /시간 초과/);
});

test("repo_find: 내 계정·org 마다 repo view, 찾으면 기억", async () => {
  _clearGhCache();
  const g = fakeGh();
  const r = await repoFind("target", { bin: g.bin });
  assert.deepEqual(r.searched, ["me-login", "org-a", "org-b"]);
  assert.deepEqual(r.matches, [{ nameWithOwner: "org-b/target", url: "https://github.com/org-b/target" }]);
  const n = g.calls().length;
  await repoFind("target", { bin: g.bin });
  assert.equal(g.calls().length, n); // 캐시
  // 못 찾으면 search repos 로 후보
  const miss = await repoFind("nothing", { bin: g.bin });
  assert.ok(g.calls().some((c) => c[0] === "search" && c[1] === "repos"));
  assert.equal(miss.matches.length, 2);
  await assert.rejects(repoFind("--help", { bin: g.bin }));
  assert.equal((await ghHandlers({ bin: g.bin }).repo_find({ name: "a b" })).isError, true);
});

test("가드: gh 도구는 읽기 전용으로 통과, 다른 이름은 막힘", async () => {
  for (const n of GH_TOOL_NAMES) assert.equal(isReadOnlyCall(`mcp__gh__${n}`, {}).allow, true, n);
  for (const n of ["mcp__gh__pr_merge", "mcp__gh__api", "mcp__github__create_pull_request"]) assert.equal(isReadOnlyCall(n, {}).allow, false, n);
  const hook = readOnlyHookFor(undefined);
  const res = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__gh__pr_view", tool_input: { repo: "o/n", number: 1 } } as any, undefined, { signal: new AbortController().signal });
  assert.deepEqual(res, {});
});

test("도구 설정: 켜면 gh 서버·허용 목록·프롬프트 힌트, 끄면 없음", () => {
  const base = loadConfig();
  _resetGhProbe(undefined);
  const off = toolOptions({ ...base, github: {} }, {});
  assert.equal(off.gh, false);
  assert.ok(!off.allowedTools.includes("mcp__gh__*"));
  assert.equal(off.hint, "");

  const on = toolOptions({ ...base, github: { enabled: true } }, {});
  assert.equal(on.gh, true);
  assert.ok(on.allowedTools.includes("mcp__gh__*"));
  assert.ok(on.disallowedTools.includes("Bash"));
  assert.ok(on.hint.includes("gh 도구로 직접 확인") && on.hint.includes("repo_find"));
  assert.equal(on.hint, GH_HINT);
  assert.equal(on.model, base.models.general);
  // 도구 없는 호출(제목 짓기 등)엔 안 붙는다
  assert.equal(toolOptions({ ...base, github: { enabled: true } }, { tools: false }).gh, false);
  // 명시적으로 끄면 gh 로그인돼 있어도 끔, 설정 없으면 시작 때 점검 결과를 따른다
  _resetGhProbe(true);
  assert.equal(ghEnabled({ github: {} }), true);
  assert.equal(ghEnabled({ github: { enabled: false } }), false);
  assert.equal(ghEnabled({}), true);
  _resetGhProbe(false);
  assert.equal(ghEnabled({}), false);
  _resetGhProbe(undefined);
});

test("SDK 서버: 이름 gh, sdk 타입", () => {
  const s = ghMcpServer({ github: { enabled: true } });
  assert.equal(s.type, "sdk");
  assert.equal(s.name, "gh");
});

test("진행 단계 이름", () => {
  assert.equal(stepName("mcp__gh__pr_view", { repo: "o/n", number: 3 }), "gh.pr_view o/n#3");
  assert.equal(stepName("mcp__gh__search_prs", { query: "org:x 1817" }), "gh.search_prs org:x 1817");
  assert.equal(stepName("mcp__gh__repo_find", { name: "abc" }), "gh.repo_find abc");
});

test("설정: env CY_AGENT_GITHUB 가 끄고 켠다", () => {
  assert.equal(loadConfig({ ...process.env, CY_AGENT_GITHUB: "0" }).github?.enabled, false);
  assert.equal(loadConfig({ ...process.env, CY_AGENT_GITHUB: "1" }).github?.enabled, true);
});
