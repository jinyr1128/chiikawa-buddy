import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jong, hasBatchim, josa } from "./josa.ts";
import { fillVars, unknownVars } from "./phrases.ts";
import { LINES_FILE } from "./characters.ts";
import { taskText } from "./claude-hooks.ts";

test("jong: 한글 받침 · 숫자·영어는 읽는 소리 · 끝 문장부호는 건너뜀", () => {
  assert.equal(hasBatchim("생각"), true);
  assert.equal(hasBatchim("명령 실행"), true);
  assert.equal(hasBatchim("main.js 고치기"), false);
  assert.equal(hasBatchim("main.js"), false); // 제이에스
  assert.equal(hasBatchim("README.md"), false); // 엠디
  assert.equal(hasBatchim("app.html"), true); // 엘
  assert.equal(hasBatchim("v3"), true); // 삼
  assert.equal(hasBatchim("2"), false); // 이
  assert.equal(hasBatchim("보고서…"), false);
  assert.equal(hasBatchim("'생각')"), true);
  assert.equal(hasBatchim(""), false);
  assert.equal(jong("파일"), 8); // ㄹ
});

test("josa: 표기마다 받침에 맞는 조사", () => {
  assert.equal(josa("생각", "(이)야"), "(이)야"); // 모르는 표기는 그대로
  assert.equal(josa("생각", "(이)"), "이");
  assert.equal(josa("고치기", "(이)"), "");
  assert.equal(josa("생각", "은(는)"), "은");
  assert.equal(josa("고치기", "은(는)"), "는");
  assert.equal(josa("고치기", "(은)는"), "는");
  assert.equal(josa("명령 실행", "을(를)"), "을");
  assert.equal(josa("main.js", "를(을)"), "를");
  assert.equal(josa("생각", "이(가)"), "이");
  assert.equal(josa("고치기", "(이)가"), "가");
  assert.equal(josa("검색", "과(와)"), "과");
  assert.equal(josa("고치기", "와(과)"), "와");
  assert.equal(josa("명령 실행", "(으)"), "으");
  assert.equal(josa("파일", "(으)"), ""); // ㄹ 받침은 「로」
  assert.equal(josa("고치기", "(으)"), "");
});

test("fillVars: 자리표시 바로 뒤 조사 표기를 받침에 맞춰 채운다", () => {
  const f = (line: string, task: string) => fillVars(line, { task });
  assert.equal(f("아직도 {task}(이)야?!", "명령 실행"), "아직도 명령 실행이야?!");
  assert.equal(f("아직도 {task}(이)야?!", "main.js 고치기"), "아직도 main.js 고치기야?!");
  assert.equal(f("아직도 {task}(이)야?!", "main.js"), "아직도 main.js야?!");
  assert.equal(f("이 시간에 {task}(이)라니", "생각"), "이 시간에 생각이라니");
  assert.equal(f("이 시간에 {task}(이)라니", "읽기"), "이 시간에 읽기라니");
  assert.equal(f("밤새 {task}은(는) 안 해!", "명령 실행"), "밤새 명령 실행은 안 해!");
  assert.equal(f("밤새 {task}은(는) 안 해!", "쓰기"), "밤새 쓰기는 안 해!");
  assert.equal(f("{task}을(를) 보는 중", "생각"), "생각을 보는 중");
  assert.equal(f("{task}이(가) 길어", "검색"), "검색이 길어");
  assert.equal(f("{task}(이)가 길어", "쓰기"), "쓰기가 길어");
  assert.equal(f("시작은 {task}(으)로.", "명령 실행"), "시작은 명령 실행으로.");
  assert.equal(f("시작은 {task}(으)로.", "파일"), "시작은 파일로.");
  assert.equal(f("아침엔 {task}(이)우다", "생각"), "아침엔 생각이우다");
  assert.equal(f("우나(밤새 {task}은(는) 안 돼)", "고치기"), "우나(밤새 고치기는 안 돼)"); // 카니 괄호 뜻 안에서도
  // 자리표시 없이 쓴 괄호·모르는 자리표시는 그대로
  assert.equal(fillVars("(이)야 {nope}(이)야", { task: "생각" }), "(이)야 {nope}(이)야");
  assert.equal(f("{task} 중이야 (이)", "생각"), "생각 중이야 (이)");
  // 조사 표기는 자리표시 검사에 걸리지 않는다
  assert.deepEqual(unknownVars("{task}(이)야 {task}은(는)", ["task"]), []);
});

test("기본 대사: {task}·{title} 바로 뒤에 받침 따라 바뀌어야 할 맨 조사가 없다", () => {
  const files = [LINES_FILE, new URL("../../assets/characters/presets/shisa-jeju.json", import.meta.url)];
  for (const f of files) {
    const bad = readFileSync(f, "utf8").match(/\{(?:task|title)\}(?:야|라니|지|구나|우다|는|은|를|을|가|이|로|으로|와|과)(?!\()/g);
    assert.equal(bad, null, String(f));
  }
  // 실제 일 이름으로 채워 보기
  for (const task of [taskText("Bash"), taskText(), taskText("Edit", { file_path: "/a/main.js" })]) {
    assert.doesNotMatch(fillVars("{task}(이)야 {task}은(는) {task}(이)라니", { task }), /\(|실행야|생각라니|실행는/);
  }
});
