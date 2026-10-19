import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CLI = join(import.meta.dirname, "cli.ts");

function session(dir: string, id: string, daysAgo: number) {
  const p = join(dir, "proj", `${id}.jsonl`);
  mkdirSync(join(dir, "proj"), { recursive: true });
  const ts = new Date(Date.now() - daysAgo * 864e5).toISOString();
  writeFileSync(p, JSON.stringify({ type: "user", sessionId: id, cwd: "/work/repo", timestamp: ts, message: { content: `prompt ${id}` } }) + "\n");
  const t = (Date.now() - daysAgo * 864e5) / 1000;
  utimesSync(p, t, t);
}

test("cli sessions --all: 14일 컷오프 없이 전부, 모델 호출 없음", () => {
  const home = mkdtempSync(join(tmpdir(), "cy-cli-"));
  const claude = join(home, "claude"), codex = join(home, "codex");
  session(claude, "new1", 1);
  session(claude, "old1", 100);
  session(claude, "old2", 400);
  writeFileSync(join(home, "config.json"), JSON.stringify({ claudeProjectsDir: claude, codexSessionsDir: codex }));
  const env = { ...process.env, CY_AGENT_HOME: home, CY_AGENT_DB: join(home, "cy.db") };
  const run = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" });

  assert.match(run("sessions"), /세션 1개 반영/);
  assert.match(run("sessions", "--all"), /세션 2개 반영 \(전체\)/);
  assert.match(run("sessions", "--all"), /세션 0개 반영/, "바뀐 파일만 다시 읽는다");
  const db = new DatabaseSync(join(home, "cy.db"));
  assert.equal((db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'session'").get() as any).n, 3);
  db.close();
});
