import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setInstalled, isInstalled, HERMES_EVENTS } from '../src/hermes-hooks.js';

test('Hermes 연동: config 끝에 우리 블록만 넣고 빼며, 승인 목록엔 우리 스크립트만', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  fs.mkdirSync(path.join(home, '.hermes'));
  const cfg = path.join(home, '.hermes', 'config.yaml');
  fs.writeFileSync(cfg, 'model: gpt\nlist:\n  - a\n');
  fs.writeFileSync(path.join(home, '.hermes', 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: 'pre_tool_call', command: '/other.sh' }] }));
  assert.ok(setInstalled(true, 47823, home).ok);
  assert.ok(isInstalled(home));
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^model: gpt\nlist:\n  - a\n# chiikawa-buddy:hermes-start/);
  for (const ev of HERMES_EVENTS) assert.match(text, new RegExp(`  ${ev}:\\n    - command: `));
  const allow = JSON.parse(fs.readFileSync(path.join(home, '.hermes', 'shell-hooks-allowlist.json'), 'utf8')).approvals;
  assert.equal(allow.filter((e) => e.command === '/other.sh').length, 1);
  assert.equal(allow.length, 1 + HERMES_EVENTS.length);
  assert.ok(setInstalled(true, 47823, home).ok); // 두 번 켜도 한 블록
  assert.equal(fs.readFileSync(cfg, 'utf8').split('hermes-start').length, 2);
  assert.ok(setInstalled(false, 47823, home).ok);
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'model: gpt\nlist:\n  - a\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.hermes', 'shell-hooks-allowlist.json'), 'utf8')).approvals.length, 1);
  fs.writeFileSync(cfg, 'hooks:\n  pre_tool_call: []\n');
  assert.equal(setInstalled(true, 47823, home).ok, false); // 사용자가 쓴 hooks: 는 건드리지 않는다
});
