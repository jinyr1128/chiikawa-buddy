// 안내 문구 운영체제 구분: 렌더러 userAgent 로만, 윈도우는 PowerShell·Ctrl·install.ps1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWindowsUA, WIN, modKey, terminalRow, claudeInstall } from '../src/os-hint.js';
import { agentSteps } from '../src/setup-flow.js';

test('isWindowsUA: 크롬 윈도우 UA 만, Node·맥은 아님', () => {
  assert.equal(isWindowsUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0 Electron/44.7.0'), true);
  assert.equal(isWindowsUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/44.7.0'), false);
  assert.equal(isWindowsUA('Node.js/26'), false);
  assert.equal(isWindowsUA(undefined), false);
  assert.equal(WIN, false); // 테스트(Node)는 어느 OS 에서 돌려도 맥 문구
});

test('modKey·terminalRow·claudeInstall: 맥은 그대로, 윈도우는 Ctrl·PowerShell·install.ps1', () => {
  assert.equal(modKey(false), '⌘');
  assert.equal(modKey(true), 'Ctrl');
  assert.deepEqual(terminalRow(false), { keys: ['⌘', '스페이스'], text: '이 키를 누르고 **터미널** 이라고 친 뒤 **↩** 를 누릅니다.' });
  assert.match(terminalRow(true).text, /PowerShell/);
  assert.equal(claudeInstall(false), 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(claudeInstall(true), 'irm https://claude.ai/install.ps1 | iex');
});

test('agentSteps(win): 윈도우 설치 안내는 PowerShell·Ctrl+V·install.ps1', () => {
  const mac = agentSteps('claude');
  assert.equal(mac[0].code, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.deepEqual(mac[0].rows[1].keys, ['⌘', 'V']);
  const win = agentSteps('claude', true);
  assert.equal(win[0].code, 'irm https://claude.ai/install.ps1 | iex');
  assert.deepEqual(win[0].rows[1].keys, ['Ctrl', 'V']);
  assert.match(win[0].rows[0].text, /PowerShell/);
  assert.deepEqual(agentSteps('codex', true)[1].rows[1].keys, ['Ctrl', 'V']);
  assert.equal(agentSteps('codex', true)[0].code, 'npm install -g @openai/codex');
});
