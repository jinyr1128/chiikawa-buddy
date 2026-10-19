// 윈도우에서 claude·codex 같은 CLI 를 셸 없이 띄우기. 맥·리눅스는 그대로 넘긴다.
// npm 전역 설치는 .cmd shim 이라 execFile 로 바로 못 띄운다(EINVAL). shim 안의 JS 경로를 읽어 node 로 직접 돌리고,
// 못 읽으면 cmd.exe /d /s /c 로 — 이때는 줄바꿈·따옴표·% 같은 글자가 든 인자는 아예 안 보낸다(사용자 글이 셸에 닿지 않게).
import fs from 'node:fs';
import path from 'node:path';

const SHIM = /\.(cmd|bat)$/i;
// npm cmd-shim: "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*  (옛 모양은 "%~dp0\…")
const SHIM_SCRIPT = /"%~?dp0%?\\([^"%]+?\.[cm]?js)"/i;
// cmd 로 넘겨도 되는 인자(고정 하위 명령·옵션만)
const CMD_SAFE = /^[\w@.:\\/=+,-]*$/;

// → { file, args, env?, verbatim? } | null(안전하게 못 띄움)
export function winCommand(bin, args = [], { platform = process.platform, readFile = fs.readFileSync, exists = fs.existsSync, nodePath = process.execPath } = {}) {
  if (platform !== 'win32' || !SHIM.test(String(bin))) return { file: bin, args };
  let text = '';
  try { text = String(readFile(bin, 'utf8')); } catch { /* 못 읽으면 cmd 로 */ }
  const m = SHIM_SCRIPT.exec(text);
  const dir = path.win32.dirname(bin);
  const script = m ? path.win32.join(dir, m[1]) : null;
  if (script && exists(script)) {
    const local = path.win32.join(dir, 'node.exe'); // shim 은 옆에 node.exe 가 있으면 그걸 쓴다
    if (exists(local)) return { file: local, args: [script, ...args] };
    // 시사 앱 실행 파일(Electron)을 Node 로 — 데몬과 같은 방식
    return { file: nodePath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  if (/["%!^\r\n]/.test(bin) || !args.every((a) => typeof a === 'string' && CMD_SAFE.test(a))) return null;
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `""${bin}"${args.map((a) => ` ${a === '' ? '""' : a}`).join('')}"`], verbatim: true };
}

// execFile 과 같은 모양: exec(file, args, opts, cb) → child. 못 띄우면 cb(err) 하고 null
export function execBin(exec, bin, args, opts, cb, deps = {}) {
  const c = winCommand(bin, args, deps);
  if (!c) { cb(Object.assign(new Error('unsafe command line'), { code: 'EUNSAFE' }), '', ''); return null; }
  const win = (deps.platform ?? process.platform) === 'win32';
  const o = {
    ...opts,
    ...(c.env ? { env: { ...(opts?.env ?? process.env), ...c.env } } : {}),
    ...(c.verbatim ? { windowsVerbatimArguments: true } : {}),
    ...(win ? { windowsHide: true } : {}), // 검은 콘솔 창을 띄우지 않는다
  };
  return exec(c.file, c.args, o, cb);
}
