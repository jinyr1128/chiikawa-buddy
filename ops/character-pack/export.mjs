#!/usr/bin/env node
// 내 캐릭터 묶음 내보내기: ~/.cy-agent/characters(움짤 캐릭터·대사·기본 캐릭터 대사 고친 것)만 zip 으로.
// 설정 파일(열쇠·비밀번호)·알림·메일·대화는 넣지 않는다. 사용: node ops/character-pack/export.mjs [나갈 zip 경로] [기본 캐릭터 이름]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
const src = path.join(HOME, 'characters');
const out = path.resolve(process.argv[2] ?? 'chiikawa-characters.zip');
const preferName = process.argv[3] ?? '짭몽가';
if (!fs.existsSync(src)) { console.error(`캐릭터 폴더가 없어요: ${src}`); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cpack-'));
const dst = path.join(stage, 'characters');
fs.cpSync(src, dst, { recursive: true, filter: (p) => !/\.DS_Store$|\.tmp-/.test(p) });
// 목록과 기본 캐릭터(새로 깐 사람이 처음 볼 캐릭터)
const chars = fs.readdirSync(dst).filter((d) => d.startsWith('u-')).map((id) => {
  const c = JSON.parse(fs.readFileSync(path.join(dst, id, 'character.json'), 'utf8'));
  return { id, name: c.name };
});
const def = chars.find((c) => c.name === preferName) ?? chars[0];
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ app: 'chiikawa-manager', made: new Date().toISOString(), defaultCharacter: def?.id ?? null, characters: chars }, null, 2));
fs.rmSync(out, { force: true });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', stage, out]);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`✅ ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)}MB) · 캐릭터 ${chars.length}개 · 기본 ${def?.name ?? '-'}`);
