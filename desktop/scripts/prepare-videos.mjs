// 캐릭터 애니메이션(초록 배경 mp4) → 투명 VP9 WebM. 결과는 ~/.cy-agent/assets/character 에 둔다(레포 assets/character 에 복사해 두면 설치 때 같이 깔린다).
//   <src>/character_studying.mp4 → <out>/studying.webm (+ studying-1024.webm, studying.png)
//   <src>/character_dance.mp4    → <out>/dance.webm    (+ dance-1024.webm,    dance.png)
//   <out>/video.json             → { studying: {duration, fps, frames, size, ...}, dance: {...} }
// 하는 일: ① 크로마키(초록→알파, 가장자리만 despill) ② 캐릭터 없는 빈 프레임 제거 ③ 루프 이음매 맞추기
//          ④ 모든 프레임의 캐릭터 합집합 bbox → 여백 4% 정사각형 크롭(넘치면 투명 패딩) → 512(+1024)
// 사용: node scripts/prepare-videos.mjs [--src ~/Downloads] [--out ~/.cy-agent/assets/character] [--force]
// 같은 입력·같은 스크립트면 건너뛴다(--force 로 다시). 필요: ffmpeg/ffprobe (PATH 또는 /opt/homebrew/bin).
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const CLIPS = [
  { name: 'studying', file: 'character_studying.mp4', loopFix: true },
  { name: 'dance', file: 'character_dance.mp4', loopFix: true },
];

export const PARAMS = {
  similarity: 0.07, // chromakey: UV 거리 이하 → 완전 투명
  blend: 0.07, //       이 폭만큼 반투명으로 풀림 (≥ similarity+blend 면 불투명)
  despillBand: 3, //    투명 영역에서 이 픽셀 거리 안쪽만 despill (안쪽 하늘색 펜 등 보존)
  alphaOn: 128, //      '캐릭터 픽셀' 판정 알파
  emptyRatio: 0.002, // 캐릭터 픽셀 비율이 이 미만이면 빈 프레임
  bboxMinCount: 3, //   bbox 행/열 판정: 그 줄에 캐릭터 픽셀이 이만큼은 있어야(잡티 무시)
  margin: 0.04, //      정사각형 각 변 여백 (bbox 긴 변 대비)
  sizes: [512, 1024], // 512 는 필수, 1024 는 원본 크롭 크기가 허락할 때만
  crf: { 512: 30, 1024: 32 },
  loopWindow: 0.2, //   루프 이음매 탐색: 끝에서 이 비율 안의 프레임
  loopGain: 0.6, //     마지막 프레임보다 이음매 차이가 이 배 이하로 줄어야 자른다
};

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
const FFPROBE = bin('ffprobe');
const ff = (args, opts = {}) => run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 30, encoding: 'buffer', ...opts });

// ffmpeg 출력(rawvideo)을 프레임 단위로 흘려 받는다 — 전체를 메모리에 올리지 않게.
function frames(args, frameBytes, onFrame) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', ...args, '-f', 'rawvideo', 'pipe:1']);
    let buf = Buffer.alloc(0), n = 0, err = '';
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= frameBytes) { onFrame(buf.subarray(0, frameBytes), n++); buf = buf.subarray(frameBytes); }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(n) : reject(new Error(`ffmpeg ${code}: ${err}`))));
  });
}

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_space:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const s = j.streams[0];
  const [a, b] = s.r_frame_rate.split('/').map(Number);
  return { codec: s.codec_name, w: s.width, h: s.height, fps: a / (b || 1), frames: Number(s.nb_read_frames), pix: s.pix_fmt,
    matrix: s.color_space || 'bt709', duration: Number(j.format.duration) };
}

// 배경색(YUV): 가운데 프레임의 네 귀퉁이 40×40 평균의 중앙값. 키 색을 YUV 로 바로 넘겨 행렬(601/709) 어긋남을 피한다.
export async function keyColor(src, info) {
  const mid = Math.floor(info.frames / 2), c = 40, vals = [];
  for (const [x, y] of [[0, 0], [info.w - c, 0], [0, info.h - c], [info.w - c, info.h - c]]) {
    const { stdout } = await ff(['-i', src, '-vf', `select=eq(n\\,${mid}),crop=${c}:${c}:${x}:${y},format=yuv444p,scale=1:1:flags=area`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv444p', 'pipe:1']);
    vals.push([...stdout.subarray(0, 3)]);
  }
  const med = (k) => vals.map((v) => v[k]).sort((a, b) => a - b)[1];
  const yuv = [med(0), med(1), med(2)];
  return '0x' + yuv.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// 키잉 그래프 (원본 해상도, 출력 rgba). 마지막 라벨 [k].
//  - 4:2:0 크로마를 먼저 4:4:4 로 보간해 가장자리 계단을 줄이고
//  - despill 은 투명 영역 근처 띠에만 섞는다(maskedmerge) — 캐릭터 안쪽 색(하늘색 펜, 노란 음표)은 그대로.
export function keyGraph(key, matrix, p = PARAMS) {
  const dil = Array(p.despillBand).fill('dilation').join(',');
  return `[0:v]scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}:flags=bicubic+full_chroma_int+accurate_rnd,format=yuv444p,`
    + `chromakey=color=${key}:similarity=${p.similarity}:blend=${p.blend}:yuv=1,`
    + `scale=in_color_matrix=${matrix}:flags=bicubic+full_chroma_int+accurate_rnd,format=rgba,split=3[o][d0][m0];`
    + `[d0]despill=type=green:mix=0.5:expand=0[d];`
    + `[m0]format=rgba,alphaextract,negate,${dil},format=rgba[m];`
    + `[o][d][m]maskedmerge,format=rgba[k]`;
}

// 1차 분석: 프레임별 캐릭터 픽셀 비율·bbox, 루프 비교용 축소 RGB.
export async function analyze(src, info, key, p = PARAMS) {
  const { w, h } = info, stats = [];
  const graph = `${keyGraph(key, info.matrix, p)};[k]format=rgba,alphaextract[a]`;
  await frames(['-i', src, '-filter_complex', graph, '-map', '[a]', '-pix_fmt', 'gray'], w * h, (a, n) => {
    const rows = new Uint32Array(h), cols = new Uint32Array(w);
    let on = 0;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (a[i] >= p.alphaOn) { on++; rows[y]++; cols[x]++; }
    const lo = (arr) => arr.findIndex((v) => v >= p.bboxMinCount);
    const hi = (arr) => arr.length - 1 - [...arr].reverse().findIndex((v) => v >= p.bboxMinCount);
    const x0 = lo(cols), y0 = lo(rows);
    stats[n] = { n, ratio: on / (w * h), box: x0 < 0 || y0 < 0 ? null : [x0, y0, hi(cols), hi(rows)] };
  });
  const S = 96, thumbs = [];
  await frames(['-i', src, '-vf', `scale=${S}:${S}:flags=area`, '-pix_fmt', 'rgb24'], S * S * 3, (f, n) => { thumbs[n] = Buffer.from(f); });
  return { stats, thumbs };
}

const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// 남길 프레임 목록: 빈 프레임 제외 → 루프 이음매(첫 프레임과 가장 닮은 끝 프레임의 '직전'에서 끊기).
export function chooseFrames(info, { stats, thumbs }, loopFix, p = PARAMS) {
  const empty = stats.filter((s) => s.ratio < p.emptyRatio).map((s) => s.n);
  let keep = stats.filter((s) => s.ratio >= p.emptyRatio).map((s) => s.n);
  const loop = { trimmed: [] };
  if (keep.length > 10) {
    const first = thumbs[keep[0]];
    // 마지막 프레임 다음에 첫 프레임이 온다 → 이상적인 끝 = '다음 프레임이 첫 프레임과 같아지는' 지점.
    // 끝 후보 k 에서 이음매 비용 = diff(thumb[k+1], first) (k 가 마지막이면 diff(last, first) 로 근사: 정지 프레임 1개 차이)
    const seam = (idx) => (idx + 1 < keep.length ? diff(thumbs[keep[idx + 1]], first) : Infinity);
    const lastCost = diff(thumbs[keep[keep.length - 1]], first);
    // 참고용: 보통 프레임 간 차이(중앙값)
    const steps = keep.slice(1).map((n, i) => diff(thumbs[n], thumbs[keep[i]])).sort((a, b) => a - b);
    const typical = steps[Math.floor(steps.length / 2)];
    loop.lastCost = +lastCost.toFixed(2);
    loop.typicalStep = +typical.toFixed(2);
    if (loopFix) {
      const from = Math.floor(keep.length * (1 - p.loopWindow));
      let best = -1, bestCost = Infinity;
      for (let i = from; i < keep.length - 1; i++) { const c = seam(i); if (c < bestCost) { bestCost = c; best = i; } }
      if (best >= 0 && bestCost < lastCost * p.loopGain) {
        loop.trimmed = keep.slice(best + 1);
        loop.seamCost = +bestCost.toFixed(2);
        keep = keep.slice(0, best + 1);
      }
    }
  }
  return { keep, empty, loop };
}

// 합집합 bbox → 여백 넣은 정사각형 (프레임 밖이면 그만큼 투명 패딩)
export function squareBox(info, stats, keep, p = PARAMS) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (const n of keep) {
    const b = stats[n].box;
    if (!b) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  let side = Math.ceil(Math.max(bw, bh) * (1 + 2 * p.margin));
  side += side % 2;
  const sx = Math.round((x0 + x1 + 1) / 2 - side / 2), sy = Math.round((y0 + y1 + 1) / 2 - side / 2);
  // 화면 안 부분만 crop 하고 나머지는 pad
  const cx = Math.max(0, sx), cy = Math.max(0, sy);
  const cw = Math.min(info.w, sx + side) - cx, ch = Math.min(info.h, sy + side) - cy;
  return { bbox: [x0, y0, bw, bh], square: [sx, sy, side], crop: [cx, cy, cw, ch], pad: [cx - sx, cy - sy] };
}

function selectExpr(keep) {
  // 연속 구간으로 묶어 between() 으로
  const parts = [];
  for (let i = 0; i < keep.length;) {
    let j = i;
    while (j + 1 < keep.length && keep[j + 1] === keep[j] + 1) j++;
    parts.push(`between(n\\,${keep[i]}\\,${keep[j]})`);
    i = j + 1;
  }
  return parts.join('+');
}

async function encode(src, info, key, keep, box, size, out, p = PARAMS) {
  const [cx, cy, cw, ch] = box.crop, side = box.square[2], [px, py] = box.pad;
  // 투명 칸의 RGB 가 축소·4:2:0 에서 가장자리에 번지지 않게 premultiply 상태로 크롭·패딩·축소 후 되돌린다
  const graph = `${keyGraph(key, info.matrix, p)};`
    + `[k]select='${selectExpr(keep)}',setpts=N/(${info.fps}*TB),`
    + `premultiply=inplace=1,crop=${cw}:${ch}:${cx}:${cy},pad=${side}:${side}:${px}:${py}:color=0x00000000,`
    + `scale=${size}:${size}:flags=lanczos,unpremultiply=inplace=1,format=yuva420p[v]`;
  await ff(['-i', src, '-filter_complex', graph, '-map', '[v]', '-an', '-r', String(info.fps),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-crf', String(p.crf[size] ?? 31), '-b:v', '0',
    '-deadline', 'good', '-cpu-used', '1', '-row-mt', '1', '-g', String(Math.round(info.fps * 2)),
    '-metadata:s:v:0', 'alpha_mode=1', out]);
}

// 검증: libvpx 디코더로 알파 평면 확인 (내장 vp9 디코더는 알파를 버린다)
export async function verify(file, size) {
  const n = { frames: 0, emptyFrames: 0, minRatio: 1 };
  await frames(['-c:v', 'libvpx-vp9', '-i', file, '-vf', 'format=rgba,alphaextract', '-pix_fmt', 'gray'], size * size, (a) => {
    let on = 0;
    for (let i = 0; i < a.length; i++) if (a[i] >= 128) on++;
    const r = on / a.length;
    n.frames++; if (r < PARAMS.emptyRatio) n.emptyFrames++; n.minRatio = Math.min(n.minRatio, r);
  });
  const { stdout } = await ff(['-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  const at = (x, y) => stdout[(y * size + x) * 4 + 3];
  const c = size >> 1;
  return { ...n, minRatio: +n.minRatio.toFixed(3), cornerAlpha: at(2, 2), centerAlpha: at(c, c), bytes: fs.statSync(file).size };
}

async function main() {
  const src = path.resolve(home(arg('src', '~/Downloads')));
  const out = path.resolve(home(arg('out', '~/.cy-agent/assets/character')));
  const force = process.argv.includes('--force');
  fs.mkdirSync(out, { recursive: true });
  const metaPath = path.join(out, 'video.json');
  const prev = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const meta = { ...prev };

  for (const clip of CLIPS) {
    const file = path.join(src, clip.file);
    if (!fs.existsSync(file)) { console.log(`- ${clip.name}: ${file} 없음, 건너뜀`); continue; }
    const st = fs.statSync(file);
    const sig = crypto.createHash('sha1').update(JSON.stringify([clip.file, st.size, st.mtimeMs])).update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12);
    const main512 = path.join(out, `${clip.name}.webm`);
    if (!force && prev[clip.name]?.sig === sig && fs.existsSync(main512)) { console.log(`- ${clip.name}: 최신 (sig ${sig}), 건너뜀`); continue; }

    const info = await probe(file);
    console.log(`- ${clip.name}: ${info.codec} ${info.w}x${info.h} ${info.fps}fps ${info.frames}f ${info.duration}s (${info.pix}, ${info.matrix})`);
    const key = await keyColor(file, info);
    console.log(`  key color (YUV) ${key}, similarity ${PARAMS.similarity}, blend ${PARAMS.blend}`);
    const an = await analyze(file, info, key);
    const { keep, empty, loop } = chooseFrames(info, an, clip.loopFix);
    console.log(`  빈 프레임 ${empty.length}개 제거: [${empty.join(',')}]`);
    console.log(`  루프: 마지막→첫 차이 ${loop.lastCost} (보통 프레임 간 ${loop.typicalStep})` + (loop.trimmed.length
      ? ` → 끝 ${loop.trimmed.length}프레임 [${loop.trimmed[0]}..${loop.trimmed.at(-1)}] 잘라 이음매 ${loop.seamCost}` : ' → 그대로'));
    const box = squareBox(info, an.stats, keep);
    console.log(`  bbox x${box.bbox[0]} y${box.bbox[1]} ${box.bbox[2]}x${box.bbox[3]} → 정사각형 x${box.square[0]} y${box.square[1]} ${box.square[2]}² (crop ${box.crop.join(',')}, pad ${box.pad.join(',')})`);

    const entry = { file: `${clip.name}.webm`, poster: `${clip.name}.png`, size: 512, fps: info.fps, frames: keep.length,
      duration: +(keep.length / info.fps).toFixed(3), source: { file: clip.file, w: info.w, h: info.h, frames: info.frames },
      dropped: { empty, loopTrim: loop.trimmed }, crop: box, key, sig, variants: {} };
    for (const size of PARAMS.sizes) {
      if (size !== 512 && box.square[2] < size) { console.log(`  ${size}: 원본 크롭 ${box.square[2]}px < ${size}, 만들지 않음`); continue; }
      const name = size === 512 ? `${clip.name}.webm` : `${clip.name}-${size}.webm`;
      const dst = path.join(out, name);
      const tmp = dst.replace(/\.webm$/, '.tmp.webm');
      await encode(file, info, key, keep, box, size, tmp);
      fs.renameSync(tmp, dst);
      const v = await verify(dst, size);
      entry.variants[size] = { file: name, bytes: v.bytes };
      console.log(`  → ${dst} ${(v.bytes / 1024).toFixed(0)}KB, ${v.frames}f, 빈 프레임 ${v.emptyFrames}, 최소 캐릭터비 ${v.minRatio}, 알파 귀퉁이 ${v.cornerAlpha} / 가운데 ${v.centerAlpha}`);
      if (v.frames !== keep.length || v.emptyFrames || v.cornerAlpha !== 0) throw new Error(`${name} 검증 실패`);
    }
    // 포스터: 512 결과의 첫 프레임 (RGBA PNG)
    const poster = path.join(out, `${clip.name}.png`);
    await ff(['-c:v', 'libvpx-vp9', '-i', main512, '-frames:v', '1', '-pix_fmt', 'rgba', poster]);
    console.log(`  → ${poster}`);
    meta[clip.name] = entry;
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`→ ${metaPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
