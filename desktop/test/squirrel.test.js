// 윈도우 Squirrel 설치 이벤트 · 로그인 자동 실행 자리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { squirrelPlan, loginItemTarget, updateExe, appUserModelId } from '../src/squirrel.js';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Shisa\\app-0.2.0\\Shisa.exe';
const UPDATE = 'C:\\Users\\me\\AppData\\Local\\Shisa\\Update.exe';

test('squirrelPlan: 설치는 바로 가기 만들기, 업데이트(updated)는 아무것도 안 띄움, 제거는 지우기 + 로그인 항목 끄기, obsolete 는 그냥 끝', () => {
  const at = (arg) => squirrelPlan({ platform: 'win32', argv: [EXE, arg], execPath: EXE });
  assert.equal(updateExe(EXE), UPDATE);
  assert.deepEqual(at('--squirrel-install'), { event: 'install', run: [UPDATE, ['--createShortcut=Shisa.exe']], removeLoginItem: false });
  // 업데이트는 바로 가기를 다시 만들지 않는다(사용자가 지운 바탕화면 바로 가기가 되살아나지 않게)
  assert.deepEqual(at('--squirrel-updated'), { event: 'updated', run: null, removeLoginItem: false });
  assert.deepEqual(at('--squirrel-uninstall'), { event: 'uninstall', run: [UPDATE, ['--removeShortcut=Shisa.exe']], removeLoginItem: true });
  assert.deepEqual(at('--squirrel-obsolete'), { event: 'obsolete', run: null, removeLoginItem: false });
});

test('squirrelPlan: 평소 실행·첫 실행(--squirrel-firstrun)·맥은 null', () => {
  for (const arg of [undefined, '', '--squirrel-firstrun', '--squirrel-installx', '.', '--hidden']) {
    assert.equal(squirrelPlan({ platform: 'win32', argv: [EXE, arg], execPath: EXE }), null, String(arg));
  }
  assert.equal(squirrelPlan({ platform: 'darwin', argv: ['/A/Shisa', '--squirrel-install'], execPath: '/A/Shisa' }), null);
  assert.equal(squirrelPlan({ platform: 'win32', argv: [EXE, '--squirrel-install'], execPath: '' }), null);
  // 개발 실행(electron.exe . --squirrel-install)은 argv[1] 이 앱 폴더라 안 걸린다
  assert.equal(squirrelPlan({ platform: 'win32', argv: ['electron.exe', '.', '--squirrel-install'], execPath: 'electron.exe' }), null);
});

test('loginItemTarget: 윈도우 설치본만 Update.exe --processStart, 그 밖엔 기본값', () => {
  // name 을 박아 둬야 앱 ID 를 정하기 전(Squirrel 제거 실행)에도 같은 Run 값을 지운다
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: true, execPath: EXE }), { path: UPDATE, args: ['--processStart', '"Shisa.exe"'], name: 'com.squirrel.Shisa.Shisa' });
  assert.equal(appUserModelId(EXE), 'com.squirrel.Shisa.Shisa');
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: true, execPath: EXE, exists: () => false }), {});
  assert.deepEqual(loginItemTarget({ platform: 'win32', packaged: false, execPath: EXE }), {});
  assert.deepEqual(loginItemTarget({ platform: 'darwin', packaged: true, execPath: '/Applications/시사.app/Contents/MacOS/시사' }), {});
});

test('main.js 배선: 시작하자마자 Squirrel 이벤트면 Update.exe 만 띄우고 끝(창·데몬 없음), 로그인 항목은 같은 자리로', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /const SQUIRREL = squirrelPlan\(\{ platform: process\.platform, argv: process\.argv, execPath: process\.execPath \}\);/);
  assert.match(main, /if \(SQUIRREL\) \{[\s\S]*?app\.quit\(\)/);
  assert.match(main, /\} else if \(!app\.requestSingleInstanceLock\(\)\) \{/);
  assert.ok(main.indexOf('const SQUIRREL') < main.indexOf('requestSingleInstanceLock'));
  assert.match(main, /setLoginItemSettings\(\{ openAtLogin: p\.openAtLogin, \.\.\.loginTarget\(\) \}\)/);
  assert.match(main, /getLoginItemSettings\(loginTarget\(\)\)/);
  // 앱 ID 는 Squirrel 갈림길보다 먼저(제거 실행도 같은 ID)
  const aumid = main.indexOf('app.setAppUserModelId(appUserModelId(process.execPath))');
  assert.ok(aumid > 0 && aumid < main.indexOf('if (SQUIRREL) {'));
});

test('main.js 배선: 윈도우 로그오프·종료(session-end)에도 집중 기록·데몬 끄기, 드래그는 크기까지 setBounds', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(process\.platform === 'win32'\) win\?\.on\('session-end', onSessionEnd\);/);
  assert.match(main, /function onSessionEnd\(\) \{[\s\S]*?post\('\/focus\/stop', \{\}, \d+\)[\s\S]*?daemonHost\.stop\(\)/);
  assert.match(main, /win\.setBounds\(\{ x: p\.x - drag\.offX, y: p\.y - drag\.offY, \.\.\.SIZE \}\)/);
});
