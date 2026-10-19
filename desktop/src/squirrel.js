// 윈도우 Squirrel 설치기(Shisa-<ver>-Setup.exe)가 앱을 --squirrel-* 로 잠깐 띄울 때 할 일. 순수 로직(띄우기·종료는 main.js).
// 설치 폴더: %LOCALAPPDATA%\<앱>\Update.exe · %LOCALAPPDATA%\<앱>\app-<ver>\<앱>.exe
//  - install: 바탕화면·시작 메뉴 바로 가기 만들기 · uninstall: 지우기 + 로그인 자동 실행 끄기 · updated·obsolete: 그냥 끝
//    (updated 에 다시 만들면 사용자가 지운 바로 가기가 되살아난다. 바로 가기는 Update.exe --processStart 라 업데이트 뒤에도 맞다)
//  - 어느 경우든 창·데몬은 띄우지 않고 바로 끝낸다(Squirrel 이 기다린다)
import path from 'node:path';

const W = path.win32;

// Update.exe 자리: 실행 파일 폴더(app-<ver>)의 한 단계 위
export const updateExe = (execPath) => W.resolve(W.dirname(execPath), '..', 'Update.exe');

// 앱 ID: Squirrel 바로 가기와 같은 com.squirrel.<id>.<exe 이름>. 알림·작업 표시줄 묶음 + 로그인 항목(Run 값) 이름
export const appUserModelId = (execPath) => `com.squirrel.Shisa.${W.basename(execPath, '.exe')}`;

// → null(평소 실행) | { event, run: [file, args] | null, removeLoginItem }
export function squirrelPlan({ platform, argv = [], execPath }) {
  if (platform !== 'win32' || typeof execPath !== 'string' || !execPath) return null;
  const event = /^--squirrel-(install|updated|uninstall|obsolete)$/.exec(String(argv[1] ?? ''))?.[1];
  if (!event) return null;
  const exe = W.basename(execPath);
  const update = updateExe(execPath);
  if (event === 'install') return { event, run: [update, [`--createShortcut=${exe}`]], removeLoginItem: false };
  if (event === 'uninstall') return { event, run: [update, [`--removeShortcut=${exe}`]], removeLoginItem: true };
  return { event, run: null, removeLoginItem: false };
}

// 로그인 자동 실행: Squirrel 앱은 Update.exe --processStart 로 띄워야 업데이트(app-<ver> 폴더가 바뀜) 뒤에도 남는다.
// 맥은 기본값({}) 그대로. 읽을 때(getLoginItemSettings)도 같은 path·args 로 물어야 맞는 항목을 본다
// name: 윈도우는 Run 값 이름을 안 주면 그때의 앱 ID 를 쓴다 → 앱 ID 를 늦게 정하는 실행(제거 등)과 어긋나지 않게 늘 박아 둔다
// exists(Update.exe): Squirrel 없이 푼 앱(zip 등)이면 기본값(실행 파일 자신)
export function loginItemTarget({ platform, packaged, execPath, exists = () => true }) {
  if (platform !== 'win32' || !packaged || typeof execPath !== 'string' || !execPath) return {};
  const update = updateExe(execPath);
  if (!exists(update)) return {};
  return { path: update, args: ['--processStart', `"${W.basename(execPath)}"`], name: appUserModelId(execPath) };
}
