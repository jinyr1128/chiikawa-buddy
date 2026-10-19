import { test } from "node:test";
import assert from "node:assert/strict";
import { modelChoices, modelLabel } from "./models.ts";
import { loadConfig } from "./config.ts";
import { chatAskOpts } from "./chat.ts";

test("모델 이름 → 짧은 라벨, 모르는 모양은 그대로", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude-haiku-5"), "Haiku 5");
  assert.equal(modelLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("my-model"), "my-model");
});

test("고를 수 있는 모델 = 설정의 코딩·일반·경량(큰 것부터, 겹치면 한 번)", () => {
  const cfg = loadConfig();
  const c = { ...cfg, brain: { ...cfg.brain, provider: "claude-code" as const }, models: { code: "claude-opus-5-5", general: "claude-sonnet-5-5", light: "claude-haiku-5-5" } };
  assert.deepEqual(modelChoices(c).map((x) => [x.id, x.label, x.role]), [
    ["claude-opus-5-5", "Opus 5.5", "code"], ["claude-sonnet-5-5", "Sonnet 5.5", "general"], ["claude-haiku-5-5", "Haiku 5.5", "light"],
  ]);
  const same = { ...c, models: { code: "claude-opus-5-5", general: "claude-opus-5-5", light: "claude-haiku-5-5" } };
  assert.deepEqual(modelChoices(same).map((x) => x.id), ["claude-opus-5-5", "claude-haiku-5-5"]);
});

test("고를 수 있는 모델: Claude 로 답하는 뇌일 때만, Gemini·OpenAI·Codex·로컬이면 빈 목록", () => {
  const cfg = loadConfig();
  const models = { code: "claude-opus-5-5", general: "claude-sonnet-5-5", light: "claude-haiku-5-5" };
  for (const provider of ["claude-code", "anthropic"] as const) assert.equal(modelChoices({ ...cfg, models, brain: { ...cfg.brain, provider } }).length, 3);
  for (const provider of ["gemini", "openai", "codex", "local"] as const) assert.deepEqual(modelChoices({ ...cfg, models, brain: { ...cfg.brain, provider } }), []);
});

test("채팅 설정: 고른 모델이 있으면 그것, 없으면 일반", () => {
  const cfg = loadConfig();
  assert.equal(chatAskOpts(cfg, "x").model, cfg.models.general);
  assert.equal(chatAskOpts(cfg, "x", undefined, "th1", "chat", cfg.models.code).model, cfg.models.code);
});
