import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions } from "./instructions.ts";

test("홈 AGENTS.md·CLAUDE.md·레포 AGENTS.md를 모으고 중복 제거", () => {
  const home = mkdtempSync(join(tmpdir(), "cy-home-"));
  const repo = mkdtempSync(join(tmpdir(), "cy-repo-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, "AGENTS.md"), "커밋은 DemoUser로");
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "커밋은 DemoUser로");
  writeFileSync(join(repo, "AGENTS.md"), "workflows 수정 금지");
  const out = loadInstructions(repo, home);
  assert.equal(out.match(/DemoUser/g)?.length, 1);
  assert.match(out, /workflows 수정 금지/);
  assert.equal(loadInstructions(undefined, mkdtempSync(join(tmpdir(), "cy-empty-"))), "");
});
