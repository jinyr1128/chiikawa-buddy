#!/usr/bin/env node
// 터미널에서 Claude Code 연동 켜기/끄기: node ops/claude-hooks.mjs on | off | status
// (앱 메뉴 「Claude Code 연동」과 같은 일을 한다)
import { isInstalled, setInstalled, settingsPath } from '../desktop/src/claude-hooks.js';

const port = Number(process.env.CY_AGENT_PORT) || 47823;
const cmd = process.argv[2];
if (cmd === 'status') {
  console.log(isInstalled(port) ? '연동 켜짐' : '연동 꺼짐', `(${settingsPath()})`);
} else if (cmd === 'on' || cmd === 'off') {
  const r = setInstalled(cmd === 'on', port);
  if (!r.ok) { console.error('실패:', r.error); process.exit(1); }
  console.log(cmd === 'on' ? '✅ 연동을 켰어요. 새로 시작하는 Claude Code 대화부터 캐릭터가 같이 움직여요.' : '🧹 연동을 껐어요.');
} else {
  console.log('사용법: node ops/claude-hooks.mjs on | off | status');
  process.exit(1);
}
