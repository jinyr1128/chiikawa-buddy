#!/usr/bin/env node
// 캐릭터 묶음 들여오기: zip → ~/.cy-agent/characters 에 붙인다(같은 id 는 새것으로 바꾼다). 지금 캐릭터가 없으면 묶음의 기본 캐릭터로.
// 앱이 켜져 있으면 다시 켜야 목록에 보인다(설치 스크립트가 알아서 다시 켠다). 사용: node ops/character-pack/import.mjs <zip>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
const zip = process.argv[2];
if (!zip || !fs.existsSync(zip)) { console.error('사용법: node ops/character-pack/import.mjs <chiikawa-characters.zip>'); process.exit(1); }
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cpack-in-'));
execFileSync('ditto', ['-x', '-k', zip, stage]);
const root = fs.existsSync(path.join(stage, 'characters')) ? stage : path.join(stage, fs.readdirSync(stage)[0] ?? '');
const src = path.join(root, 'characters');
if (!fs.existsSync(src)) { console.error('묶음 안에 characters 폴더가 없어요.'); process.exit(1); }
const dst = path.join(HOME, 'characters');
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(src)) {
  if (!/^(u-[a-z0-9]+|overrides)$/.test(name)) continue; // 모르는 건 건너뛴다
  fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true, force: true });
  if (name.startsWith('u-')) n++;
}
// 기본 캐릭터: 설정에 캐릭터가 없거나 기본 캐릭터(치이카와)면 묶음의 기본으로
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch { /* 없음 */ }
const cfgPath = path.join(HOME, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 처음 */ }
if (manifest.defaultCharacter && (!cfg.character || cfg.character === 'chiikawa')) {
  cfg.character = manifest.defaultCharacter;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
fs.rmSync(stage, { recursive: true, force: true });
console.log(`✅ 캐릭터 ${n}개를 넣었어요${manifest.defaultCharacter ? ` · 기본 캐릭터 ${(manifest.characters ?? []).find((c) => c.id === manifest.defaultCharacter)?.name ?? ''}` : ''}`);
