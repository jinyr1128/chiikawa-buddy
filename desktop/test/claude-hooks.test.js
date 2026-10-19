import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withHooks, hooksInstalled, setInstalled, isInstalled, HOOK_EVENTS, MARK } from '../src/claude-hooks.js';
import { claudeBubble } from '../src/focus.js';

test('켜면 모든 이벤트에 들어가고, 남의 hook 은 그대로', () => {
  const mine = { type: 'command', command: 'echo hi' };
  const before = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } };
  const on = withHooks(before, true, 47823);
  assert.ok(hooksInstalled(on, 47823));
  assert.equal(on.model, 'opus');
  assert.deepEqual(on.hooks.Stop[0].hooks, [mine]);
  assert.equal(on.hooks.PreToolUse[0].matcher, '*');
  const twice = withHooks(on, true, 47823); // 두 번 켜도 하나만
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  const off = withHooks(twice, false, 47823);
  assert.ok(!hooksInstalled(off, 47823));
  assert.deepEqual(off.hooks, { Stop: [{ hooks: [mine] }] });
  assert.equal(HOOK_EVENTS.length, Object.keys(on.hooks).length);
});

test('파일로: 백업을 남기고, 깨진 파일은 건드리지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const file = path.join(dir, '.claude', 'settings.json');
  assert.ok(setInstalled(true, 47823, file).ok);
  assert.ok(isInstalled(47823, file));
  assert.ok(fs.readFileSync(file, 'utf8').includes(MARK));
  assert.ok(setInstalled(false, 47823, file).ok);
  assert.ok(!isInstalled(47823, file));
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.bak-')));
  fs.writeFileSync(file, '{ broken');
  const r = setInstalled(true, 47823, file);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('Claude 작업 말풍선: claude run 만, 최근 것 먼저, 집중 중엔 숨김', () => {
  const runs = [
    { kind: 'calendar', title: '캘린더', startedAt: '2026-10-19T00:00:03Z' },
    { kind: 'claude', title: 'Claude · 읽는 중 · a.md', startedAt: '2026-10-19T00:00:01Z' },
    { kind: 'claude', title: 'Claude · 고치는 중 · b.js', startedAt: '2026-10-19T00:00:02Z' },
  ];
  assert.deepEqual(claudeBubble(runs, null), { label: 'Claude 작업 중', title: '고치는 중 · b.js', more: 1, text: '고치는 중 · b.js 외 1개', claude: true });
  assert.equal(claudeBubble(runs, { active: {} }), null);
  assert.equal(claudeBubble([], null), null);
});
