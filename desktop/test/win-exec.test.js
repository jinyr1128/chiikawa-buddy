// 윈도우 CLI 띄우기: .cmd shim 은 셸 없이 node 로, 못 읽으면 안전한 인자만 cmd.exe 로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winCommand, execBin } from '../src/win-exec.js';

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

test('winCommand: 맥·리눅스와 .exe 는 그대로', () => {
  assert.deepEqual(winCommand('/x/claude', ['-p', 'a\nb'], { platform: 'darwin' }), { file: '/x/claude', args: ['-p', 'a\nb'] });
  assert.deepEqual(winCommand('/x/codex.cmd', ['x'], { platform: 'darwin' }), { file: '/x/codex.cmd', args: ['x'] });
  assert.deepEqual(winCommand('C:\\b\\claude.exe', ['-p', 'a "b"\n'], { platform: 'win32' }), { file: 'C:\\b\\claude.exe', args: ['-p', 'a "b"\n'] });
});

test('winCommand: npm .cmd shim 은 안의 JS 를 node 로(셸 없이) — 사용자 글도 그대로', () => {
  const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const deps = { platform: 'win32', readFile: () => SHIM, nodePath: 'C:\\Shisa\\Shisa.exe' };
  const c = winCommand(`${NPM}\\codex.cmd`, ['exec', '--', '사용자: "안녕" & del *\n%PATH%'], { ...deps, exists: (p) => p === script });
  assert.deepEqual(c, { file: 'C:\\Shisa\\Shisa.exe', args: [script, 'exec', '--', '사용자: "안녕" & del *\n%PATH%'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  // shim 옆에 node.exe 가 있으면 그걸
  const local = winCommand(`${NPM}\\codex.cmd`, ['x'], { ...deps, exists: (p) => p === script || p === `${NPM}\\node.exe` });
  assert.deepEqual(local, { file: `${NPM}\\node.exe`, args: [script, 'x'] });
  // 옛 shim 모양("%~dp0\…")
  const old = winCommand(`${NPM}\\claude.cmd`, [], { ...deps, readFile: () => '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.mjs" %*', exists: (p) => p.endsWith('cli.mjs') });
  assert.equal(old.args[0], `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.mjs`);
});

test('winCommand: shim 을 못 읽으면 cmd.exe /d /s /c — 안전한 인자만, 아니면 null', () => {
  const deps = { platform: 'win32', readFile: () => { throw new Error('ENOENT'); }, exists: () => false };
  const c = winCommand('C:\\Program Files\\x\\claude.cmd', ['auth', 'status', ''], deps);
  assert.deepEqual(c, { file: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\x\\claude.cmd" auth status """'], verbatim: true });
  for (const bad of ['a b', 'a"b', 'a&b', 'a|b', '%PATH%', 'a\nb', 'a^b', 'a<b', '!x!', 'a(b)']) {
    assert.equal(winCommand('C:\\x\\claude.cmd', ['-p', bad], deps), null, bad);
  }
  assert.equal(winCommand('C:\\%x%\\claude.bat', ['status'], deps), null);
});

test('execBin: 실행 옵션을 붙여 exec 를 부르고, 못 띄우면 오류로 끝낸다', () => {
  let seen;
  const exec = (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, 'ok'); return 'child'; };
  assert.equal(execBin(exec, '/x/claude', ['a'], { cwd: '/t' }, () => {}, { platform: 'darwin' }), 'child');
  assert.deepEqual(seen, { file: '/x/claude', args: ['a'], opts: { cwd: '/t' } });
  execBin(exec, 'C:\\x\\claude.cmd', ['auth', 'status'], { timeout: 1 }, () => {}, { platform: 'win32', readFile: () => '', exists: () => false });
  assert.equal(seen.file, 'cmd.exe');
  assert.equal(seen.opts.windowsVerbatimArguments, true);
  assert.equal(seen.opts.windowsHide, true);
  assert.equal(seen.opts.timeout, 1);
  execBin(exec, 'C:\\n\\codex.cmd', ['x'], { env: { A: '1' } }, () => {}, { platform: 'win32', readFile: () => '"%dp0%\\a.js"', exists: (p) => p === 'C:\\n\\a.js', nodePath: 'C:\\S.exe' });
  assert.deepEqual([seen.file, seen.opts.env], ['C:\\S.exe', { A: '1', ELECTRON_RUN_AS_NODE: '1' }]);
  let err;
  const r = execBin(exec, 'C:\\x\\claude.cmd', ['-p', 'a b'], {}, (e) => { err = e; }, { platform: 'win32', readFile: () => '', exists: () => false });
  assert.equal(r, null);
  assert.equal(err.code, 'EUNSAFE');
});
