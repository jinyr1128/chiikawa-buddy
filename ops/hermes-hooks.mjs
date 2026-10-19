#!/usr/bin/env node
// 터미널에서 Hermes 연동 켜기/끄기: node ops/hermes-hooks.mjs on | off | status (앱 메뉴 「Hermes 연동」과 같다)
import { isInstalled, setInstalled, hermesAvailable } from '../desktop/src/hermes-hooks.js';
const port = Number(process.env.CY_AGENT_PORT) || 47823;
const cmd = process.argv[2];
if (!hermesAvailable()) { console.log('Hermes 가 이 맥에 없어요.'); process.exit(1); }
if (cmd === 'status') console.log(isInstalled() ? '연동 켜짐' : '연동 꺼짐');
else if (cmd === 'on' || cmd === 'off') {
  const r = setInstalled(cmd === 'on', port);
  if (!r.ok) { console.error('실패:', r.error); process.exit(1); }
  console.log(cmd === 'on' ? '✅ Hermes 연동을 켰어요. Hermes 를 다시 켜면 그다음 대화부터 캐릭터가 같이 움직여요.' : '🧹 Hermes 연동을 껐어요.');
} else { console.log('사용법: node ops/hermes-hooks.mjs on | off | status'); process.exit(1); }
