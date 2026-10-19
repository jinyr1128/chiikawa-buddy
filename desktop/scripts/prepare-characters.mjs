// 고를 수 있는 캐릭터(하치와레·랏코·모몽가·카니)의 그림·영상을 원본에서 만든다. 결과는 레포 assets/characters/<id>/ 에 둔다.
//   eyes_open.png · eyes_closed.png  정지 그림(512 정사각형, 투명). 눈 감은 그림이 없으면 눈 뜬 그림만(깜빡이지 않는다)
//   study.webm · study.png           집중·공부 중 영상과 첫 장면
//   plan.webm  · plan.png            일정 알림(n분 전) 영상과 첫 장면
//   dance.webm · cheer.webm          「춤춰 줘」·「응원해 줘」 영상(있는 캐릭터만 — 없으면 앱이 다른 영상으로 대신한다)
//   lunch.webm · lunch.png           점심시간 영상(있는 캐릭터만 — 없으면 일정 알림 영상)
//   video.json                       { study: {...}, plan: {...} } — scene: true 면 배경이 있는 장면(네모 카드로 보인다)
// 시사(assets/character/)는 예전 그림·영상을 그대로 두고 더한 영상만 만든다(EXTRA — video.json 에 그 칸만 더한다)
// 배경 처리(key): green = 초록 배경 크로마키(prepare-videos.mjs 와 같은 그래프) · flood = 가장자리에서 이어진 단색 배경을 지움
//                 scene = 배경을 그대로 두고 가운데를 정사각형으로 자름
// 사용: node scripts/prepare-characters.mjs [--src ~/Downloads] [--out ../assets/characters] [--only hachi]
// 필요: ffmpeg/ffprobe (PATH 또는 /opt/homebrew/bin).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { keyColor, keyGraph, probe } from './prepare-videos.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SOURCES = {
  hachi: {
    stills: { open: 'new_eyes_open.png', closed: 'new_eyes_closed.png' }, // 2026-10 새로 받은 그림(테두리 정리)
    clips: { plan: { file: 'hachi_plan.mp4', key: 'green' }, study: { file: 'hachi_study.mp4', key: 'flood' }, cheer: { file: 'hachi-응원.gif', key: 'scene' } },
  },
  rakko: {
    stills: { open: 'rakko_eyes_open.png', closed: 'rakko_closed_eyes.png' },
    clips: { plan: { file: 'rakko_plan.gif', key: 'scene' }, study: { file: 'rakko_focus.gif', key: 'scene' }, dance: { file: 'rakko-dance.gif', key: 'scene', cx: 0.6 } },
  },
  momonga: {
    stills: { open: 'momonga_open_eyes.png', closed: 'momonga_closed_eyes.png' },
    clips: { plan: { file: 'momonga_plan.mp4', key: 'scene' }, study: { file: 'momonga_study.gif', key: 'scene' }, dance: { file: 'momonga_dance.gif', key: 'scene' } },
  },
  // 카니: 정지 그림은 투명 png(눈 뜬·감은 그림 크기가 달라 위치를 맞춘다). 영상은 전부 배경이 있는 장면, 집중 영상은 없다(빈 칸 규칙)
  kani: {
    stills: { open: 'kani-eyes-open.png', closed: 'kani-eyes-closed.png' },
    clips: {
      dance: { file: 'kani-cheer.gif', key: 'scene' }, cheer: { file: 'kani-cheer2.gif', key: 'scene' },
      lunch: { file: 'kani-eat.gif', key: 'scene' }, plan: { file: 'kani-plan.gif', key: 'scene', cx: 0.42 },
      study: { file: 'kani-study.mp4', key: 'scene', zoom: 0.8, cx: 0.42, cy: 0.44 }, // 회색 배경 그대로(배경색이 몸 색과 가까워 지우면 몸까지 빠진다)
    },
  },
  // 치이카와: 춤 두 개(dance·dance2, 짧은 것은 반복), 일정 알림 두 개(plan·plan2 우는 장면)
  chiikawa: {
    stills: { open: 'chii-eyes-open.png', closed: 'chii-eyes-closed.png' },
    clips: {
      dance: { file: 'chii-dance.gif', key: 'scene' }, dance2: { file: 'chii-dance-2.gif', key: 'scene', repeat: 5 },
      cheer: { file: 'chii-cheer.gif', key: 'scene', fps: 25 }, plan: { file: 'chii-plan.gif', key: 'scene' }, plan2: { file: 'chii-cry.gif', key: 'scene' },
      study: { file: 'chii-study.gif', key: 'flood', repeat: 4 }, lunch: { file: 'chiikawa-eat.gif', key: 'scene' },
    },
  },
  // 쿠리만쥬: 춤·일정 알림 영상은 없다(clips.json 에서 응원 영상을 쓴다)
  kuri: {
    stills: { open: 'kuri-eyes-open.png', closed: 'kuri-eyes-closed.png' },
    clips: { cheer: { file: 'kuri-cheer.gif', key: 'scene' }, study: { file: 'kuri-focus.gif', key: 'scene' }, lunch: { file: 'kuri-eat.gif', key: 'scene' } },
  },
};

// 기본 캐릭터에 더한 영상(같은 칸에 여러 개 → 앱이 그중 하나를 랜덤으로. 어느 칸에 넣는지는 assets/characters/clips.json)
export const EXTRA = {
  shisa: { dir: path.join('..', 'character'), clips: { dance2: { file: 'shisa-dance2.gif', key: 'scene', cx: 0.44 }, lunch: { file: 'shisa-eat.gif', key: 'scene' } } }, // 「お酒」 메뉴판 춤 · 점심
  hachi: { dir: 'hachi', clips: { lunch: { file: 'hachi-eat.gif', key: 'scene' } } },
  rakko: { dir: 'rakko', clips: { lunch: { file: 'rakko-eat.gif', key: 'scene' } } },
  usagi: { dir: 'usagi', clips: { lunch: { file: 'usagi-eat.gif', key: 'flood', repeat: 2 } } }, // 흰 배경 → 투명(우사기는 투명 캐릭터)
};
// 몇 개만 다시 만들기: --clips lunch,dance2 (칸 이름) · --no-stills(정지 그림은 그대로)
const ONLY_CLIPS = (() => { const i = process.argv.indexOf('--clips'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : null; })();
const wantClip = (name) => !ONLY_CLIPS || ONLY_CLIPS.includes(name);

export const SIZE = 512;
const MARGIN = 0.04; // 정사각형 각 변 여백(캐릭터 긴 변 대비)
const ALPHA_ON = 128;

const home = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function bin(name) {
  for (const d of (process.env.PATH || '').split(':').concat('/opt/homebrew/bin', '/usr/local/bin')) {
    const p = path.join(d, name);
    if (d && fs.existsSync(p)) return p;
  }
  throw new Error(`${name} 를 찾을 수 없다`);
}
const FFMPEG = bin('ffmpeg');
const ff = (args) => run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 30, encoding: 'buffer' });

// ffmpeg 로 rgba 프레임들을 읽는다(전부 메모리에 — 짧은 클립만 다룬다)
function readFrames(args, w, h) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const size = w * h * 4, out = [];
    let buf = Buffer.alloc(0), err = '';
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) { out.push(Buffer.from(buf.subarray(0, size))); buf = buf.subarray(size); }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

// ---- 배경 지우기(flood): 가장자리에서 이어진, 배경색에 가까운 칸만 투명하게. 안쪽 흰 몸통은 외곽선에 막혀 남는다 ----
export function floodKey(rgba, w, h, bg, { tol = 16, edgeTol = 90 } = {}) {
  const near = (i, t) => Math.abs(rgba[i] - bg[0]) <= t && Math.abs(rgba[i + 1] - bg[1]) <= t && Math.abs(rgba[i + 2] - bg[2]) <= t;
  const seen = new Uint8Array(w * h), stack = [];
  const seed = (x, y) => { const k = y * w + x; if (!seen[k] && near(k * 4, tol)) { seen[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const k = stack.pop(), x = k % w, y = (k - x) / w;
    rgba[k * 4 + 3] = 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  // 경계 한 줄: 배경과 섞인 만큼 반투명으로, 색은 배경을 뺀 만큼 되돌린다(회색 테두리 방지)
  const edge = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (rgba[k * 4 + 3] === 0) continue;
    if ((x > 0 && !rgba[(k - 1) * 4 + 3]) || (x < w - 1 && !rgba[(k + 1) * 4 + 3]) || (y > 0 && !rgba[(k - w) * 4 + 3]) || (y < h - 1 && !rgba[(k + w) * 4 + 3])) edge.push(k);
  }
  for (const k of edge) {
    const i = k * 4;
    const d = Math.max(Math.abs(rgba[i] - bg[0]), Math.abs(rgba[i + 1] - bg[1]), Math.abs(rgba[i + 2] - bg[2]));
    const a = Math.max(0.1, Math.min(1, d / edgeTol));
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.max(0, Math.min(255, Math.round((rgba[i + c] - bg[c] * (1 - a)) / a)));
    rgba[i + 3] = Math.round(a * 255);
  }
  return rgba;
}

// 투명 칸 근처의 초록 번짐 빼기(초록 배경에서 오려 낸 그림의 테두리)
export function despillGreen(rgba, w, h, band = 3) {
  const dist = new Uint8Array(w * h).fill(255);
  const q = [];
  for (let k = 0; k < w * h; k++) if (rgba[k * 4 + 3] < 250) { dist[k] = 0; q.push(k); }
  for (let qi = 0; qi < q.length; qi++) {
    const k = q[qi], x = k % w, y = (k - x) / w, d = dist[k] + 1;
    if (d > band) continue;
    for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
      if (n >= 0 && dist[n] > d) { dist[n] = d; q.push(n); }
    }
  }
  for (let k = 0; k < w * h; k++) {
    if (dist[k] > band) continue;
    const i = k * 4, cap = Math.max(rgba[i], rgba[i + 2]);
    if (rgba[i + 1] > cap) rgba[i + 1] = cap;
  }
  return rgba;
}

// 알파 bbox [x0, y0, x1, y1] (포함) | null
export function alphaBox(rgba, w, h, on = ALPHA_ON) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] < on) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

// bbox → 여백 넣은 정사각형 [sx, sy, side] (화면 밖은 투명 패딩)
export function squareOf(box, margin = MARGIN) {
  const bw = box[2] - box[0] + 1, bh = box[3] - box[1] + 1;
  const side = Math.ceil(Math.max(bw, bh) * (1 + 2 * margin));
  return [Math.round((box[0] + box[2] + 1) / 2 - side / 2), Math.round((box[1] + box[3] + 1) / 2 - side / 2), side];
}

// 프레임(rgba, w×h) 들을 정사각형 sq 로 잘라 SIZE 로 줄여 VP9 webm 으로. alpha 면 yuva420p(+alpha_mode)
function encodeFrames(frames, w, h, fps, sq, out, alpha) {
  const [sx, sy, side] = sq;
  const cx = Math.max(0, sx), cy = Math.max(0, sy);
  const cw = Math.min(w, sx + side) - cx, ch = Math.min(h, sy + side) - cy;
  const vf = alpha
    ? `premultiply=inplace=1,crop=${cw}:${ch}:${cx}:${cy},pad=${side}:${side}:${cx - sx}:${cy - sy}:color=0x00000000,scale=${SIZE}:${SIZE}:flags=lanczos,unpremultiply=inplace=1,format=yuva420p`
    : `crop=${cw}:${ch}:${cx}:${cy},scale=${SIZE}:${SIZE}:flags=lanczos,format=yuv420p`;
  const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    '-vf', vf, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-auto-alt-ref', '0', '-crf', '30', '-b:v', '0',
    '-deadline', 'good', '-cpu-used', '1', '-row-mt', '1', '-g', String(Math.round(fps * 2)), ...(alpha ? ['-metadata:s:v:0', 'alpha_mode=1'] : []), out];
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
    (async () => {
      for (const f of frames) if (!p.stdin.write(f)) await new Promise((r) => p.stdin.once('drain', r));
      p.stdin.end();
    })();
  });
}

async function clip(srcDir, outDir, name, spec) {
  const file = path.join(srcDir, spec.file);
  const info = await probe(file);
  const isGif = info.codec === 'gif';
  // gif 는 프레임 간격이 들쭉날쭉할 수 있어 평균 fps 로 고르게 뽑는다
  const fps = spec.fps ?? Math.round(info.fps * 1000) / 1000; // spec.fps: probe 가 틀리게 읽는 gif(프레임 간격이 1/100초로 잡힘)
  let frames;
  if (spec.key === 'green') {
    const key = await keyColor(file, info);
    frames = await readFrames(['-i', file, '-filter_complex', keyGraph(key, info.matrix), '-map', '[k]'], info.w, info.h);
  } else {
    frames = await readFrames(['-i', file, ...(isGif ? ['-vf', `fps=${fps}`] : [])], info.w, info.h);
  }
  const { w, h } = info;
  let sq, alpha = spec.key !== 'scene';
  if (spec.key === 'flood') {
    const c = frames[0], bg = [c[0], c[1], c[2]];
    for (const f of frames) floodKey(f, w, h, bg);
  }
  // 아주 짧은 움짤은 몇 번 이어 붙여 한 바퀴를 늘린다(repeat, 배경을 지운 뒤에)
  if (spec.repeat > 1) frames = Array.from({ length: spec.repeat }, () => frames).flat();
  if (alpha) {
    let box = null;
    for (const f of frames) box = union(box, alphaBox(f, w, h));
    sq = squareOf(box);
  } else {
    // 장면: 짧은 변 기준 가운데 정사각형(spec.cx = 가로 가운데 비율로 옮길 수 있다)
    // spec.zoom: 짧은 변의 몇 배만큼만 자른다(캐릭터가 작게 찍힌 영상) · spec.cy: 세로 가운데 비율
    const side = Math.round(Math.min(w, h) * (spec.zoom ?? 1)), cx = spec.cx ?? 0.5, cy = spec.cy ?? 0.5;
    sq = [Math.round(Math.max(0, Math.min(w - side, w * cx - side / 2))), Math.round(Math.max(0, Math.min(h - side, h * cy - side / 2))), side];
  }
  const out = path.join(outDir, `${name}.webm`);
  await encodeFrames(frames, w, h, fps, sq, out, alpha);
  const poster = path.join(outDir, `${name}.png`);
  await ff(['-c:v', 'libvpx-vp9', '-i', out, '-frames:v', '1', '-pix_fmt', 'rgba', poster]);
  const bytes = fs.statSync(out).size;
  console.log(`  ${name}: ${spec.file} ${w}x${h} ${frames.length}f ${fps}fps (${spec.key}) → ${path.relative(process.cwd(), out)} ${(bytes / 1024).toFixed(0)}KB`);
  return { file: `${name}.webm`, poster: `${name}.png`, size: SIZE, fps, frames: frames.length, duration: +(frames.length / fps).toFixed(3),
    scene: !alpha, source: { file: spec.file, w, h }, square: sq };
}

// 정지 그림: 눈 뜬·감은 그림을 같은 자리에 맞춘다(크기가 다르면 캐릭터 폭을 맞추고 아래 가운데를 맞춘다)
async function stills(srcDir, outDir, spec) {
  const load = async (f) => {
    const info = await probe(path.join(srcDir, f));
    const [rgba] = await readFrames(['-i', path.join(srcDir, f)], info.w, info.h);
    despillGreen(rgba, info.w, info.h);
    return { w: info.w, h: info.h, rgba, box: alphaBox(rgba, info.w, info.h) };
  };
  const open = await load(spec.open);
  const closed = spec.closed ? await load(spec.closed) : null;
  // 감은 그림을 눈 뜬 그림 좌표로 옮기는 배율·이동
  let k = 1, dx = 0, dy = 0;
  if (closed && (closed.w !== open.w || closed.h !== open.h)) {
    const ow = open.box[2] - open.box[0] + 1, cw = closed.box[2] - closed.box[0] + 1;
    k = ow / cw;
    dx = (open.box[0] + open.box[2]) / 2 - k * (closed.box[0] + closed.box[2]) / 2;
    dy = open.box[3] - k * closed.box[3];
  }
  let box = open.box;
  if (closed) box = union(box, [closed.box[0] * k + dx, closed.box[1] * k + dy, closed.box[2] * k + dx, closed.box[3] * k + dy].map(Math.round));
  const [sx, sy, side] = squareOf(box);
  const write = async (img, name, kk, ox, oy) => {
    const tmp = path.join(outDir, `.${name}.rgba`);
    fs.writeFileSync(tmp, img.rgba);
    // 원본 → (배율 kk, 이동 ox,oy) → 정사각형(sx,sy,side) → SIZE. 한 번의 scale + pad/crop 으로
    const s = SIZE / side;
    const W = Math.max(1, Math.round(img.w * kk * s)), H = Math.max(1, Math.round(img.h * kk * s));
    const px = Math.round((ox - sx) * s), py = Math.round((oy - sy) * s);
    const pad = Math.max(SIZE, W + Math.abs(px), H + Math.abs(py)) * 2;
    const vf = `premultiply=inplace=1,scale=${W}:${H}:flags=lanczos,pad=${pad}:${pad}:${pad / 2}:${pad / 2}:color=0x00000000,crop=${SIZE}:${SIZE}:${pad / 2 - px}:${pad / 2 - py},unpremultiply=inplace=1`;
    await ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.w}x${img.h}`, '-i', tmp, '-vf', vf, '-frames:v', '1', '-pix_fmt', 'rgba', path.join(outDir, `${name}.png`)]);
    fs.unlinkSync(tmp);
  };
  await write(open, 'eyes_open', 1, 0, 0);
  if (closed) await write(closed, 'eyes_closed', k, dx, dy);
  console.log(`  stills: ${spec.open}${closed ? ` + ${spec.closed} (배율 ${k.toFixed(3)})` : ''} → eyes_open${closed ? '·eyes_closed' : ''}.png`);
}

async function main() {
  const src = path.resolve(home(arg('src', '~/Downloads')));
  const outRoot = path.resolve(home(arg('out', path.join(HERE, '..', '..', 'assets', 'characters'))));
  const only = arg('only', '');
  for (const [id, spec] of Object.entries(SOURCES)) {
    if (only && only !== id) continue;
    const dir = path.join(outRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`- ${id}`);
    if (!process.argv.includes('--no-stills')) await stills(src, dir, spec.stills);
    const metaFile = path.join(dir, 'video.json');
    const meta = ONLY_CLIPS && fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    for (const [name, c] of Object.entries(spec.clips)) if (wantClip(name)) meta[name] = await clip(src, dir, name, c);
    fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify(meta, null, 2) + '\n');
  }
  for (const [id, spec] of Object.entries(EXTRA)) {
    if (only && only !== id) continue;
    const dir = path.join(outRoot, spec.dir);
    console.log(`- ${id} (더한 영상)`);
    const metaFile = path.join(dir, 'video.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    for (const [name, c] of Object.entries(spec.clips)) if (wantClip(name)) meta[name] = await clip(src, dir, name, c);
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
