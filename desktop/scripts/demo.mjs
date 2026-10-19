// 녹화용 데모: 가짜 데몬(데모 데이터) + 데모 전용 Electron 인스턴스를 띄우고 타임라인을 천천히 돌린다.
// 사용: npm run demo [-- --fast | --speed 0.8 | --from todos | --only chat,merge | --loop | --list | --exit | --shots <dir>]
// 진짜 데몬(47823)·평소 오버레이는 건드리지 않는다 — 포트(기본 47950)가 다르면 저장소(userData)도 따로 쓴다.
// Ctrl-C 로 둘 다 정리한다(이 스크립트가 띄운 프로세스만).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BEATS, parseArgs, selectBeats, plan, totalOf, fmtClock, runTimeline } from './demo-driver.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(DIR, '..');

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
let indices;
try { indices = selectBeats(opts); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

const rows = plan(BEATS, { pace: opts.pace, indices });
console.log(`시사 비서 데모 — 장면 ${rows.length}개, 예상 ${fmtClock(totalOf(rows))} (속도 ×${(1 / opts.pace).toFixed(2)})`);
for (const r of rows) console.log(`  [${fmtClock(r.at)}] ${String(r.n).padStart(2)}. ${r.id.padEnd(10)} ${r.title}`);
if (opts.list) process.exit(0);

const procs = new Set();
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* 이미 끝남 */ } }
  setTimeout(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } } process.exit(code); }, 1500).unref();
  if (!procs.size) process.exit(code);
  Promise.all([...procs].map((p) => new Promise((r) => (p.exitCode !== null || p.signalCode ? r() : p.once('exit', r))))).then(() => process.exit(code));
}
process.on('SIGINT', () => { console.log('\n정리 중…'); stopAll(130); });
process.on('SIGTERM', () => stopAll(143));

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

// 주 화면 작업 영역(메뉴 막대·Dock 빼고, 왼쪽 위 원점) — Electron screen.workArea 와 같은 값
function workArea() {
  try {
    const js = 'ObjC.import("AppKit"); const s=$.NSScreen.screens.objectAtIndex(0); const f=s.frame, v=s.visibleFrame; JSON.stringify({x:v.origin.x, y:f.size.height-(v.origin.y+v.size.height), w:v.size.width, h:v.size.height})';
    return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }));
  } catch { return { x: 0, y: 25, w: 1440, h: 875 }; }
}

// 녹화용 배치: 캐릭터는 오른쪽 아래, 패널(760×640)·작업 세션 창은 그 왼쪽. 데모 인스턴스 저장소에만 쓴다
function layout() {
  const wa = workArea();
  const W = 420; // main.js SIZE.width
  const win = { x: Math.round(wa.x + wa.w - W - 20), y: Math.round(wa.y + wa.h - 580) };
  const panelH = Math.min(640, wa.h - 40), sessionH = Math.min(680, wa.h - 40);
  const clampX = (x) => Math.max(wa.x + 10, x);
  const panel = { x: clampX(win.x + 50 - 760), y: Math.round(wa.y + wa.h - panelH - 24), width: 760, height: panelH };
  const session = { x: clampX(win.x + 50 - 900), y: Math.round(wa.y + wa.h - sessionH - 24), width: 900, height: sessionH };
  return { wa, pos: win, panel, session };
}

function prepareUserData(port, lay) {
  const base = path.join(os.homedir(), 'Library', 'Application Support', `cy-agent-desktop-${port}`);
  fs.mkdirSync(base, { recursive: true });
  // 패널 탭·접힘 같은 localStorage 는 매번 처음부터
  for (const d of ['Local Storage', 'Session Storage']) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  fs.writeFileSync(path.join(base, 'state.json'), JSON.stringify({ bubblesHidden: false, winHeight: 580, winWidth: 420, pos: lay.pos, panel: lay.panel, session: lay.session }, null, 2));
  return base;
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* 아직 */ }
    await sleep(200);
  }
  throw new Error(`${url} 응답 없음`);
}

function startDaemon(port) {
  const p = spawn(process.execPath, [path.join(DIR, 'fake-daemon.mjs')], {
    cwd: APP,
    env: { ...process.env, CY_AGENT_PORT: String(port), FAKE_QUIET: '1', FAKE_NO_RUN: '1', FAKE_DATA: path.join(DIR, 'demo-data.mjs'), DEMO_PACE: String(opts.pace), FAKE_DANCE_MS: String(Math.max(3000, Math.round(10000 * opts.pace))) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.add(p);
  const logFile = fs.createWriteStream(path.join(os.tmpdir(), `cy-demo-daemon-${port}.log`));
  p.stdout.pipe(logFile);
  p.stderr.on('data', (c) => process.stderr.write(`[daemon] ${c}`));
  p.on('exit', (code) => { procs.delete(p); if (!stopping) { console.error(`✗ 가짜 데몬이 끝났어 (${code})`); stopAll(1); } });
  return p;
}

function startApp(port, cdpPort) {
  const electron = createRequire(import.meta.url)('electron');
  const p = spawn(electron, ['.', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*'], {
    cwd: APP,
    env: { ...process.env, CY_AGENT_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.add(p);
  p.stderr.on('data', (c) => { const s = String(c); if (/error|failed/i.test(s) && !/DevTools listening|GPU|Autofill/i.test(s)) process.stderr.write(`[app] ${s}`); });
  p.on('exit', (code) => { procs.delete(p); if (!stopping) { console.error(`✗ 앱이 닫혔어 (${code})`); stopAll(1); } });
  return p;
}

// 스크린샷 → 한 장짜리 모아 보기(ffmpeg 가 있으면). 장면마다 [본 창 | 오버레이]
function contactSheet(dir, snaps) {
  const ok = snaps.filter((s) => s.files.overlay);
  if (!ok.length) return null;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { return null; }
  const tiles = [];
  for (const s of ok) {
    const out = path.join(dir, `tile-${String(tiles.length + 1).padStart(2, '0')}.png`);
    const label = `${s.n}. ${s.label} (${s.at})`.replace(/[:'\\]/g, ' ');
    const inputs = s.files.main ? ['-i', s.files.main, '-i', s.files.overlay] : ['-f', 'lavfi', '-i', 'color=c=0x2b2f38:s=760x640:d=1', '-i', s.files.overlay];
    const filter = `[0]scale=760:640:force_original_aspect_ratio=decrease,pad=760:640:(ow-iw)/2:(oh-ih)/2:color=0x2b2f38[a];color=c=0x3a3f4b:s=420x640[bg];[1]scale=420:580,format=rgba[o];[bg][o]overlay=0:60[b];[a][b]hstack,format=rgb24,drawtext=text='${label}':x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=0x000000aa:boxborderw=6[v]`;
    // drawtext(글자 넣기)는 ffmpeg 빌드에 따라 없다 — 있으면 쓰고 없으면 그림만
    for (const f of [filter, filter.replace(/,drawtext=[^[]*/, '')]) {
      try { execFileSync('ffmpeg', ['-y', '-loglevel', 'quiet', ...inputs, '-filter_complex', f, '-map', '[v]', '-frames:v', '1', out], { stdio: 'ignore' }); tiles.push(out); break; } catch { /* 다음 */ }
    }
  }
  if (!tiles.length) return null;
  const cols = 3, rowsN = Math.ceil(tiles.length / cols);
  const sheet = path.join(dir, 'contact-sheet.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, 'tile-%02d.png'), '-vf', `format=rgb24,scale=590:320,tile=${cols}x${rowsN}:padding=6:color=0x111111`, '-frames:v', '1', sheet]);
  return sheet;
}

async function once() {
  const { port, cdpPort } = opts;
  if (!(await portFree(port))) throw new Error(`포트 ${port} 를 이미 쓰고 있어 — 예전 데모가 남았으면 닫거나 --port 로 바꿔`);
  if (!(await portFree(cdpPort))) throw new Error(`CDP 포트 ${cdpPort} 를 이미 쓰고 있어 — --cdp-port 로 바꿔`);
  const lay = layout();
  prepareUserData(port, lay);
  console.log(`\n가짜 데몬 :${port} · 앱 CDP :${cdpPort} · 캐릭터 창 (${lay.pos.x},${lay.pos.y}) · 패널 ${lay.panel.width}×${lay.panel.height} @ (${lay.panel.x},${lay.panel.y})`);
  startDaemon(port);
  await waitHttp(`http://127.0.0.1:${port}/health`, 10000);
  startApp(port, cdpPort);
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000);
  console.log('녹화 준비: 마우스는 화면 구석에 두세요(진짜 커서는 데모와 상관없음). 3초 뒤 시작…');
  await sleep(3000);
  const r = await runTimeline({ daemon: `http://127.0.0.1:${port}`, cdp: `http://127.0.0.1:${cdpPort}`, pace: opts.pace, indices, shots: opts.shots ? path.resolve(opts.shots) : null });
  if (opts.shots) {
    fs.writeFileSync(path.join(opts.shots, 'snaps.json'), JSON.stringify(r, null, 2));
    const sheet = contactSheet(path.resolve(opts.shots), r.snaps);
    if (sheet) console.log(`모아 보기: ${sheet}`);
  }
  return r;
}

async function restart() {
  for (const p of [...procs]) { try { p.kill('SIGTERM'); } catch { /* */ } }
  stopping = true;
  const end = Date.now() + 5000;
  while (procs.size && Date.now() < end) await sleep(100);
  for (const p of [...procs]) { try { p.kill('SIGKILL'); } catch { /* */ } procs.delete(p); }
  await sleep(800);
  stopping = false;
}

try {
  for (let n = 1; ; n++) {
    const r = await once();
    if (r.failures.length) console.log(`경고: ${r.failures.map((f) => `${f.beat} — ${f.error}`).join(' / ')}`);
    if (!opts.loop) break;
    console.log(`\n↻ 다시 (${n + 1}회차)`);
    await restart();
  }
  if (opts.exit) stopAll(0);
  else console.log('\n끝. 화면은 그대로 둬요 — Ctrl-C 로 데모 앱·데몬을 닫아요.');
} catch (e) {
  console.error(`✗ ${e.message}`);
  stopAll(1);
}
