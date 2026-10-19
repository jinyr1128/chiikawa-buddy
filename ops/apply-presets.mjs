#!/usr/bin/env node
// 기본 캐릭터 말투 프리셋을 대사 덮어쓰기로 넣는다(앱이 켜져 있어야 함). 지금은 시사 → 제주 사투리.
// 되돌리기: 설정 창 캐릭터 ✎ → 「기본값으로」 또는 node ops/apply-presets.mjs --reset
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CY_AGENT_PORT) || 47823;
const PRESETS = { shisa: 'assets/characters/presets/shisa-jeju.json' };
const reset = process.argv.includes('--reset');

for (const [id, file] of Object.entries(PRESETS)) {
  const url = `http://127.0.0.1:${PORT}/characters/${id}${reset ? '/lines' : ''}`;
  let r;
  if (reset) {
    r = await fetch(url, { method: 'DELETE', headers: { 'x-cy-agent': '1' } });
  } else {
    const { _help, ...lines } = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    r = await fetch(url, { method: 'PUT', headers: { 'x-cy-agent': '1', 'content-type': 'application/json' }, body: JSON.stringify({ lines }) });
  }
  const body = await r.text();
  console.log(r.ok ? `✅ ${id}: ${reset ? '기본값으로 되돌림' : '프리셋 넣음'}` : `❌ ${id}: ${r.status} ${body.slice(0, 300)}`);
}
