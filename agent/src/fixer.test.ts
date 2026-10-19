import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestCommand, isBlockedBash, mergePr, noShipHook, resolveRepo, slugify } from "./fixer.ts";

test("resolveRepo: 허용 루트 안의 git 레포만", () => {
  const root = mkdtempSync(join(tmpdir(), "cy-root-"));
  const repo = join(root, "app");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  assert.ok(resolveRepo({ repoRoots: [root] }, join(repo, "src")).endsWith("/app"));
  const other = mkdtempSync(join(tmpdir(), "cy-other-"));
  assert.throws(() => resolveRepo({ repoRoots: [root] }, other), /허용된 레포 루트 밖/);
  assert.throws(() => resolveRepo({ repoRoots: [root] }, join(root, "../nope-xyz")), /없어/);
});

test("에이전트의 커밋·푸시·머지는 막고 테스트는 허용", () => {
  for (const c of ["git commit -m x", "git push origin main", "gh pr merge 1", "cd a && git push", "rm -rf ~/"]) assert.equal(isBlockedBash(c), true, c);
  for (const c of ["npm test", "git status", "git diff", "pnpm install", "rm -rf node_modules"]) assert.equal(isBlockedBash(c), false, c);
});

test("앞 옵션·따옴표·sh -c 로 감싼 git·gh 배포 명령도 막는다(수정 run 훅)", async () => {
  const blocked = ["git -C . push origin main", "git -c core.hooksPath=/dev/null commit -m x", "git --git-dir=.git commit -m x", "git --no-pager merge x",
    "'git' push", "g\\it push", "/usr/bin/git -C sub rebase main", "GIT.exe push", "bash -c 'git -C . push'", "sh -c \"git commit -m x\"",
    "git -c alias.ship=push ship", "git config alias.ship push", "gh -R owner/repo pr merge 1", "gh --repo=owner/repo pr create", "git switch main", "rm -fr ~/x", "env A=1 git push"];
  for (const c of blocked) {
    assert.equal(isBlockedBash(c), true, c);
    const r: any = await noShipHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c } } as any, "t", {} as any);
    assert.equal(r.hookSpecificOutput?.permissionDecision, "deny", c);
  }
  for (const c of ["git -C . diff", "git -c color.ui=false status", "git log --grep commit", "gh -R owner/repo pr view 1", "git checkout -b cy/x", "git ls-files | xargs grep TODO", "git config --get alias.ship", "npm test"])
    assert.equal(isBlockedBash(c), false, c);
});

test("detectTestCommand", () => {
  const d = mkdtempSync(join(tmpdir(), "cy-t-"));
  assert.equal(detectTestCommand(d), undefined);
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.deepEqual(detectTestCommand(d), ["npm", "test"]);
  writeFileSync(join(d, "pnpm-lock.yaml"), "");
  assert.deepEqual(detectTestCommand(d), ["pnpm", "test"]);
  // 파이썬: 워크트리 → 원래 체크아웃의 .venv, 없으면 uv · 시스템 python3
  const py = mkdtempSync(join(tmpdir(), "cy-py-")), main = mkdtempSync(join(tmpdir(), "cy-main-"));
  writeFileSync(join(py, "pyproject.toml"), ""); mkdirSync(join(py, "tests"));
  // Windows: venv 는 Scripts\python.exe, 시스템 파이썬은 python
  const win = process.platform === "win32";
  const [vbin, vpy] = win ? ["Scripts", "python.exe"] : ["bin", "python"];
  assert.deepEqual(detectTestCommand(py, main), [win ? "python" : "python3", "-m", "pytest", "-q"]);
  writeFileSync(join(py, "uv.lock"), "");
  assert.deepEqual(detectTestCommand(py, main), ["uv", "run", "pytest", "-q"]);
  mkdirSync(join(main, ".venv", vbin), { recursive: true }); writeFileSync(join(main, ".venv", vbin, vpy), "");
  assert.deepEqual(detectTestCommand(py, main), [join(main, ".venv", vbin, vpy), "-m", "pytest", "-q"]);
  mkdirSync(join(py, "venv", vbin), { recursive: true }); writeFileSync(join(py, "venv", vbin, vpy), "");
  assert.deepEqual(detectTestCommand(py, main), [join(py, "venv", vbin, vpy), "-m", "pytest", "-q"]);
});

test("slugify: 한글만이면 기본값", () => {
  assert.equal(slugify("Fix Button Color!"), "fix-button-color");
  assert.equal(slugify("버튼 색"), "change");
});


test("mergePr: 비동기로, 승인한 커밋을 --match-head-commit 으로 고정", async () => {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => { calls.push(args); return ""; };
  assert.equal(await mergePr("https://github.com/o/r/pull/1", "c".repeat(40), run), "머지 완료");
  assert.deepEqual(calls[0].slice(-2), ["--match-head-commit", "c".repeat(40)]);
  await mergePr("https://github.com/o/r/pull/1", "HEAD; rm -rf /", run);
  assert.ok(!calls[1].includes("--match-head-commit"));
});
