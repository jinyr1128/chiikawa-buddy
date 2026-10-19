// 눈 깜빡임용 캐릭터 정지 이미지 2장(눈 뜸/감음) 준비 — 결과는 ~/.cy-agent/assets 에 둔다(레포 assets/ 에 복사해 두면 설치 때 같이 깔린다).
//   <src>/character_eyes_open.png, <src>/character_eyes_closed.png
//   → <out>/eyes_open.png, eyes_closed.png (512), eyes_open@2x.png, eyes_closed@2x.png (1024)
//   → <out>/../character.png 를 새 eyes_open(512)로 교체 (기존 파일은 character.prev.png 로 한 번만 보관)
// 처리: 배경 투명화(가장자리에서 이어진 흰색/투명만) → 흰 매트 섞인 테두리 색 되돌림 → 몸통 알파 255 로 정규화
//       → 감은 눈을 뜬 눈에 정합(눈 영역 빼고 외곽선·알파가 가장 잘 겹치는 배율·이동 탐색) → 둘의 합집합 bbox 로 정사각 크롭(여백 4%)
//       → 프리멀티플라이 Lanczos3 로 512/1024 축소.
// 사용: node scripts/prepare-eyes.mjs [--src ~/Downloads] [--out ~/.cy-agent/assets/character] [--preview <dir>] [--no-main]
// 같은 입력이면 같은 출력(멱등). 의존성 없음(PNG 는 scripts/png.mjs, 미리보기만 ffmpeg 있으면 사용).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { decodePNG, encodePNG } from './png.mjs';

const EXPAND = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ── 1. 배경 정리 ────────────────────────────────────────────────────────────
// 가장자리에서 이어진 '투명 또는 거의 흰색' 칸을 배경으로 본다(안쪽 흰색 하이라이트는 외곽선에 막혀 남는다).
function backgroundMask({ w, h, rgba }, { min = 236, spread = 16 } = {}) {
  const bg = new Uint8Array(w * h);
  const isBg = (k) => {
    const i = k * 4;
    if (rgba[i + 3] === 0) return true;
    if (rgba[i + 3] < 250) return false; // 반투명 흰빛 테두리는 배경이 아니라 매트 섞인 외곽선 — 아래에서 색을 되돌린다
    const lo = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]), hi = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    return lo >= min && hi - lo <= spread;
  };
  const stack = [];
  const seed = (k) => { if (!bg[k] && isBg(k)) { bg[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const k = stack.pop(), x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < w * (h - 1)) seed(k + w);
  }
  return bg;
}

function cleanBackground(img) {
  const { w, h } = img;
  const out = Buffer.from(img.rgba);
  const bg = backgroundMask(img);
  // 배경의 원래 색(매트) — 흰 배경에서 오려낸 그림이면 테두리에 흰색이 섞여 있다
  let n = 0, sum = 0, opaqueBg = 0;
  for (let k = 0; k < w * h; k++) if (bg[k]) { n++; sum += Math.min(out[k * 4], out[k * 4 + 1], out[k * 4 + 2]); if (out[k * 4 + 3] > 0) opaqueBg++; }
  const whiteMatte = n > 0 && sum / n >= 230;
  for (let k = 0; k < w * h; k++) if (bg[k]) out.writeUInt32BE(0, k * 4);
  // 테두리 1~2px: 배경과 맞닿은 칸 중 밝은 칸은 밝을수록 투명하게(불투명 흰 배경이던 경우의 계단 완화)
  const touchesBg = (k) => {
    const x = k % w;
    return (x > 0 && bg[k - 1]) || (x < w - 1 && bg[k + 1]) || (k >= w && bg[k - w]) || (k < w * (h - 1) && bg[k + w]);
  };
  if (opaqueBg > 0) {
    const ring = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) if (!bg[k] && touchesBg(k)) ring[k] = 1;
    for (let k = 0; k < w * h; k++) if (!bg[k] && !ring[k]) {
      const x = k % w;
      if ((x > 0 && ring[k - 1] === 1) || (x < w - 1 && ring[k + 1] === 1) || (k >= w && ring[k - w] === 1) || (k < w * (h - 1) && ring[k + w] === 1)) ring[k] = 2;
    }
    for (let k = 0; k < w * h; k++) if (ring[k]) {
      const i = k * 4, lo = Math.min(out[i], out[i + 1], out[i + 2]);
      if (lo < 170) continue;
      const a = Math.max(0.1, Math.min(1, (255 - lo) / 85)) * (out[i + 3] / 255);
      out[i + 3] = Math.min(out[i + 3], Math.round(a * 255));
    }
  }
  // 흰 매트 되돌리기: 반투명 칸의 색 C = a·F + (1-a)·255 → F = (C - 255(1-a)) / a
  if (whiteMatte) {
    for (let k = 0; k < w * h; k++) {
      const i = k * 4, a = out[i + 3] / 255;
      if (a <= 0 || a >= 1) continue;
      for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((out[i + c] - 255 * (1 - a)) / a)));
    }
  }
  // 몸통 알파 정규화: 불투명이어야 할 곳이 254 같은 값이면 그 값을 255 로 끌어올린다(최빈값 기준, 240 이상일 때만)
  const hist = new Uint32Array(256);
  for (let k = 0; k < w * h; k++) hist[out[k * 4 + 3]]++;
  let body = 255;
  for (let a = 240; a < 256; a++) if (hist[a] > hist[body]) body = a;
  if (body < 255) {
    for (let k = 0; k < w * h; k++) {
      const i = k * 4 + 3;
      out[i] = out[i] >= body - 3 ? 255 : Math.round((out[i] * 255) / body);
    }
  }
  return { img: { w, h, rgba: out }, stats: { bgPixels: n, opaqueBg, whiteMatte, bodyAlpha: body } };
}

// ── 2. 정합 ────────────────────────────────────────────────────────────────
function features({ w, h, rgba }) {
  // 채널 0: 알파, 채널 1: 잉크 진하기(알파 × 어두움) — 외곽선이 또렷하게 잡힌다
  const f = new Float32Array(w * h * 2);
  for (let k = 0; k < w * h; k++) {
    const i = k * 4, a = rgba[i + 3] / 255;
    const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    f[k * 2] = a; f[k * 2 + 1] = a * (1 - lum);
  }
  return { w, h, f };
}
function sampleF({ w, h, f }, x, y, ch) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.min(w - 2, x | 0), y0 = Math.min(h - 2, y | 0), fx = x - x0, fy = y - y0;
  const k = y0 * w + x0;
  const a = f[k * 2 + ch], b = f[(k + 1) * 2 + ch], c = f[(k + w) * 2 + ch], d = f[(k + w + 1) * 2 + ch];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
export function bbox({ w, h, rgba }, thr = 8) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3] > thr) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
// 뜬 눈(ref) 좌표 p 에 대해 감은 눈(mov) 의 q = s·(p - C) + C + t. 눈 영역(eyeBox, ref 좌표)은 비교에서 뺀다.
function register(ref, mov, eyeBox) {
  const R = features(ref), M = features(mov);
  const [bx0, by0, bx1, by1] = bbox(ref);
  const C = [ref.w / 2, ref.h / 2];
  const pts = (step) => {
    const p = [];
    for (let y = Math.max(0, by0 - 12); y <= Math.min(ref.h - 1, by1 + 12); y += step)
      for (let x = Math.max(0, bx0 - 12); x <= Math.min(ref.w - 1, bx1 + 12); x += step) {
        if (x >= eyeBox[0] && x <= eyeBox[2] && y >= eyeBox[1] && y <= eyeBox[3]) continue;
        const k = y * ref.w + x;
        p.push(x, y, R.f[k * 2], R.f[k * 2 + 1]);
      }
    return Float32Array.from(p);
  };
  const cost = (P, s, tx, ty) => {
    let e = 0;
    for (let i = 0; i < P.length; i += 4) {
      const qx = s * (P[i] - C[0]) + C[0] + tx, qy = s * (P[i + 1] - C[1]) + C[1] + ty;
      const d0 = sampleF(M, qx, qy, 0) - P[i + 2], d1 = sampleF(M, qx, qy, 1) - P[i + 3];
      e += d0 * d0 + 2 * d1 * d1;
    }
    return e / (P.length / 4);
  };
  const search = (P, s0, t0, sr, ss, tr, ts) => {
    let best = { e: Infinity };
    for (let s = s0 - sr; s <= s0 + sr + 1e-9; s += ss)
      for (let ty = t0[1] - tr; ty <= t0[1] + tr + 1e-9; ty += ts)
        for (let tx = t0[0] - tr; tx <= t0[0] + tr + 1e-9; tx += ts) {
          const e = cost(P, s, tx, ty);
          if (e < best.e) best = { e, s, tx, ty };
        }
    return best;
  };
  // 초기값: bbox 중심 차이 + 크기 비
  const mb = bbox(mov), rb = [bx0, by0, bx1, by1];
  const s0 = ((mb[2] - mb[0]) + (mb[3] - mb[1])) / ((rb[2] - rb[0]) + (rb[3] - rb[1]));
  const t0 = [(mb[0] + mb[2]) / 2 - (s0 * ((rb[0] + rb[2]) / 2 - C[0]) + C[0]), (mb[1] + mb[3]) / 2 - (s0 * ((rb[1] + rb[3]) / 2 - C[1]) + C[1])];
  let b = search(pts(8), s0, t0.map(Math.round), 0.012, 0.002, 6, 1);
  b = search(pts(4), b.s, [b.tx, b.ty], 0.002, 0.0005, 1, 0.25);
  b = search(pts(2), b.s, [b.tx, b.ty], 0.0005, 0.0001, 0.25, 0.125);
  const identity = cost(pts(2), 1, 0, 0);
  return { s: b.s, tx: b.tx, ty: b.ty, C, err: b.e, errIdentity: identity };
}
// mov 를 ref 캔버스(w×h)로 리샘플 (프리멀티플라이 바이리니어). 정수 이동·배율 1 이면 그대로 복사.
function warp(mov, w, h, { s, tx, ty, C }) {
  const out = Buffer.alloc(w * h * 4);
  const integer = Math.abs(s - 1) < 1e-6 && Number.isInteger(tx) && Number.isInteger(ty);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const qx = s * (x - C[0]) + C[0] + tx, qy = s * (y - C[1]) + C[1] + ty;
    const o = (y * w + x) * 4;
    if (integer) {
      if (qx < 0 || qy < 0 || qx >= mov.w || qy >= mov.h) continue;
      mov.rgba.copy(out, o, (qy * mov.w + qx) * 4, (qy * mov.w + qx) * 4 + 4);
      continue;
    }
    const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
    let r = 0, g = 0, b = 0, a = 0;
    for (const [dx, dy, wt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const sx = x0 + dx, sy = y0 + dy;
      if (wt === 0 || sx < 0 || sy < 0 || sx >= mov.w || sy >= mov.h) continue;
      const i = (sy * mov.w + sx) * 4, al = (mov.rgba[i + 3] / 255) * wt;
      r += mov.rgba[i] * al; g += mov.rgba[i + 1] * al; b += mov.rgba[i + 2] * al; a += al;
    }
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a * 255); }
  }
  return { w, h, rgba: out };
}

// ── 3. 크롭 + 축소 ─────────────────────────────────────────────────────────
export function squareBox(boxes, margin = 0.04) {
  const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
  const side0 = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const side = Math.round(side0 * (1 + 2 * margin));
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  return { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), side, union: [x0, y0, x1, y1] };
}
// (box.x, box.y, side) 영역을 size×size 로 — 프리멀티플라이 분리형 Lanczos3. 캔버스 밖은 투명.
export function cropResize(img, box, size) {
  const { w, h, rgba } = img;
  const n = box.side, scale = size / n;
  // 프리멀티플라이 float 소스(크롭 영역)
  const src = new Float32Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = box.x + x, sy = box.y + y;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const i = (sy * w + sx) * 4, a = rgba[i + 3] / 255, o = (y * n + x) * 4;
    src[o] = rgba[i] * a; src[o + 1] = rgba[i + 1] * a; src[o + 2] = rgba[i + 2] * a; src[o + 3] = a;
  }
  const lanczos = (x) => (x === 0 ? 1 : Math.abs(x) >= 3 ? 0 : (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * Math.PI * x * x));
  const weights = (outN) => {
    const fs_ = Math.max(1, 1 / scale), sup = 3 * fs_, W = [];
    for (let o = 0; o < outN; o++) {
      const c = (o + 0.5) / scale - 0.5;
      const lo = Math.ceil(c - sup), hi = Math.floor(c + sup), ws = [];
      let tot = 0;
      for (let j = lo; j <= hi; j++) { const v = lanczos((j - c) / fs_); ws.push([Math.max(0, Math.min(n - 1, j)), v]); tot += v; }
      W.push(ws.map(([j, v]) => [j, v / tot]));
    }
    return W;
  };
  const Wt = weights(size);
  const tmp = new Float32Array(size * n * 4); // 가로 먼저
  for (let y = 0; y < n; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    for (const [j, v] of Wt[x]) { const i = (y * n + j) * 4; tmp[o] += src[i] * v; tmp[o + 1] += src[i + 1] * v; tmp[o + 2] += src[i + 2] * v; tmp[o + 3] += src[i + 3] * v; }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [j, v] of Wt[y]) { const i = (j * size + x) * 4; r += tmp[i] * v; g += tmp[i + 1] * v; b += tmp[i + 2] * v; a += tmp[i + 3] * v; }
    const o = (y * size + x) * 4;
    a = Math.max(0, Math.min(1, a));
    if (a < 0.5 / 255) continue;
    out[o] = Math.max(0, Math.min(255, Math.round(r / a))); out[o + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b / a))); out[o + 3] = Math.round(a * 255);
  }
  return { w: size, h: size, rgba: out };
}

// ── 4. 검증 ────────────────────────────────────────────────────────────────
export function blinkDiff(a, b, thr = 24) {
  let x0 = a.w, y0 = a.h, x1 = -1, y1 = -1, count = 0;
  const mask = new Uint8Array(a.w * a.h);
  for (let k = 0; k < a.w * a.h; k++) {
    const i = k * 4;
    const aa = a.rgba[i + 3] / 255, ba = b.rgba[i + 3] / 255;
    let d = Math.abs(a.rgba[i + 3] - b.rgba[i + 3]);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.rgba[i + c] * aa - b.rgba[i + c] * ba));
    if (d <= thr) continue;
    mask[k] = 1; count++;
    const x = k % a.w, y = (k / a.w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // 1px 외곽선 안티에일리어싱 차이(두 그림이 따로 그려져 생기는 실선)를 걸러낸 '실질 차이' — 열림 연산(침식 r=1 → 팽창 r=1)
  const W = a.w, H = a.h, at = (m, x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x]);
  const er = new Uint8Array(W * H), op = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let all = 1;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!at(mask, x + dx, y + dy)) { all = 0; break; }
    er[y * W + x] = all;
  }
  let ox0 = W, oy0 = H, ox1 = -1, oy1 = -1, ocount = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let any = 0;
    for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1; dx++) if (at(er, x + dx, y + dy)) { any = 1; break; }
    if (!any) continue;
    op[y * W + x] = 1; ocount++;
    if (x < ox0) ox0 = x; if (x > ox1) ox1 = x; if (y < oy0) oy0 = y; if (y > oy1) oy1 = y;
  }
  // 실질 차이 덩어리(연결 성분) — 큰 순서로 [픽셀 수, x0, y0, x1, y1]
  const seen = new Uint8Array(W * H), blobs = [];
  for (let k = 0; k < W * H; k++) if (op[k] && !seen[k]) {
    const st = [k]; seen[k] = 1;
    let n = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    while (st.length) {
      const q = st.pop(), x = q % W, y = (q / W) | 0; n++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (const nq of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, q - W, q + W]) if (nq >= 0 && nq < W * H && op[nq] && !seen[nq]) { seen[nq] = 1; st.push(nq); }
    }
    blobs.push([n, bx0, by0, bx1, by1]);
  }
  blobs.sort((p, q) => q[0] - p[0]);
  return { count, bbox: [x0, y0, x1, y1], mask, solid: { count: ocount, bbox: [ox0, oy0, ox1, oy1], mask: op, blobs } };
}
function alphaStats(img) {
  const { w, h, rgba } = img, A = (x, y) => rgba[(y * w + x) * 4 + 3];
  const corners = [A(0, 0), A(w - 1, 0), A(0, h - 1), A(w - 1, h - 1)];
  // 몸통: 중심 근처 ±10% 영역 알파 최소값
  let bodyMin = 255;
  for (let y = Math.round(h * 0.55); y < Math.round(h * 0.75); y++) for (let x = Math.round(w * 0.4); x < Math.round(w * 0.6); x++) bodyMin = Math.min(bodyMin, A(x, y));
  return { corners, bodyMin, center: A(w >> 1, Math.round(h * 0.65)) };
}

function previews(dir, out, diffMask, size) {
  const ff = ['/opt/homebrew/bin/ffmpeg', 'ffmpeg'].find((p) => { try { execFileSync(p, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  fs.mkdirSync(dir, { recursive: true });
  // 차이 마스크 PNG (빨강)
  // 빨강 = 실질 차이, 주황 반투명 = 1px 외곽선 안티에일리어싱 차이
  const dm = Buffer.alloc(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    if (diffMask.solid.mask[k]) { dm[k * 4] = 255; dm[k * 4 + 3] = 255; }
    else if (diffMask.mask[k]) { dm[k * 4] = 255; dm[k * 4 + 1] = 160; dm[k * 4 + 3] = 110; }
  }
  fs.writeFileSync(path.join(dir, 'diff_mask.png'), encodePNG(size, size, dm));
  if (!ff) { console.log('- ffmpeg 없음 — 미리보기 건너뜀'); return; }
  const o = path.join(out, 'eyes_open@2x.png'), c = path.join(out, 'eyes_closed@2x.png');
  const run = (args) => execFileSync(ff, ['-v', 'error', '-y', ...args]);
  // 컨택트 시트: 뜬 눈 | 감은 눈 | 겹침(감은 눈 50%) + 차이 빨강 — 체커보드 위
  run(['-f', 'lavfi', '-i', `color=c=0xcccccc:s=${size}x${size}:d=1`, '-i', o, '-i', c, '-i', path.join(dir, 'diff_mask.png'), '-filter_complex',
    `[0]format=rgba,geq=r='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':g='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':b='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':a=255,split=3[b1][b2][b3];` +
    `[b1][1]overlay[p1];[b2][2]overlay[p2];[2]colorchannelmixer=aa=0.5[c50];[b3][1]overlay[t3];[t3][c50]overlay[t4];[3]colorchannelmixer=aa=0.6[dm];[t4][dm]overlay[p3];` +
    `[p1][p2][p3]hstack=3`, '-frames:v', '1', path.join(dir, 'contact_sheet.png')]);
  // 깜빡임 미리보기: 뜬 눈 1.6초 → 감은 눈 0.15초 반복 (GIF 는 체커보드 위, APNG 는 투명 유지)
  const list = path.join(dir, 'blink.txt');
  fs.writeFileSync(list, `file '${o}'\nduration 1.6\nfile '${c}'\nduration 0.15\nfile '${o}'\nduration 0.01\n`);
  run(['-f', 'concat', '-safe', '0', '-i', list, '-plays', '0', '-f', 'apng', path.join(dir, 'blink.apng')]);
  run(['-f', 'concat', '-safe', '0', '-i', list, '-f', 'lavfi', '-i', `color=c=0xcccccc:s=${size}x${size}`, '-filter_complex',
    `[1]format=rgba,geq=r='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':g='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':b='if(eq(mod(floor(X/16)+floor(Y/16),2),0),204,255)':a=255[bg];` +
    `[bg][0]overlay=shortest=1,split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse`, '-loop', '0', path.join(dir, 'blink.gif')]);
  fs.rmSync(list);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? EXPAND(args[i + 1]) : d; };
  const src = opt('--src', path.join(os.homedir(), 'Downloads'));
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const out = opt('--out', path.join(home, 'assets', 'character'));
  const preview = opt('--preview', null);

  const open0 = decodePNG(fs.readFileSync(path.join(src, 'character_eyes_open.png')));
  const closed0 = decodePNG(fs.readFileSync(path.join(src, 'character_eyes_closed.png')));
  console.log(`입력: open ${open0.w}×${open0.h}, closed ${closed0.w}×${closed0.h}`);
  const o = cleanBackground(open0), c = cleanBackground(closed0);
  console.log('배경 정리 open', o.stats, '/ closed', c.stats);

  // 눈 영역(비교 제외): bbox 기준 상대 위치 — 눈썹 아래~볼 위, 얼굴 가운데 폭
  const rb = bbox(o.img);
  const bw = rb[2] - rb[0], bh = rb[3] - rb[1];
  const eyeBox = [rb[0] + bw * 0.28, rb[1] + bh * 0.24, rb[0] + bw * 0.72, rb[1] + bh * 0.46].map(Math.round);
  const reg = register(o.img, c.img, eyeBox);
  console.log(`정합: scale ${reg.s.toFixed(4)}, offset (${reg.tx.toFixed(3)}, ${reg.ty.toFixed(3)}) px [closed = s·(open − C) + C + t, C=(${reg.C})], ` +
    `오차 ${reg.err.toFixed(5)} (정합 전 ${reg.errIdentity.toFixed(5)}), 제외 영역 ${eyeBox}`);
  const closedAligned = warp(c.img, o.img.w, o.img.h, reg);

  const box = squareBox([bbox(o.img), bbox(closedAligned)], 0.04);
  console.log(`크롭: 합집합 bbox ${box.union} → 정사각 x=${box.x} y=${box.y} side=${box.side} (open 캔버스 기준)`);

  fs.mkdirSync(out, { recursive: true });
  const results = {};
  for (const [size, suffix] of [[512, ''], [1024, '@2x']]) {
    for (const [name, img] of [['eyes_open', o.img], ['eyes_closed', closedAligned]]) {
      const r = cropResize(img, box, size);
      fs.writeFileSync(path.join(out, `${name}${suffix}.png`), encodePNG(r.w, r.h, r.rgba));
      results[`${name}${suffix}`] = r;
      console.log(`✓ ${name}${suffix}.png ${size}×${size}`, alphaStats(r));
    }
  }
  for (const suffix of ['', '@2x']) {
    const d = blinkDiff(results[`eyes_open${suffix}`], results[`eyes_closed${suffix}`]);
    console.log(`깜빡임 차이${suffix || ' (512)'}: 전체 ${d.count}px bbox ${d.bbox} / 실질(1px 외곽선 제외) ${d.solid.count}px bbox ${d.solid.bbox}`);
    console.log(`  큰 덩어리 [px,x0,y0,x1,y1]: ${d.solid.blobs.slice(0, 4).map((b) => `[${b}]`).join(' ')} … 총 ${d.solid.blobs.length}개`);
    if (suffix === '@2x' && preview) previews(preview, out, d, 1024);
  }

  if (!args.includes('--no-main')) {
    const mainPng = path.join(path.dirname(out), 'character.png');
    const prev = path.join(path.dirname(out), 'character.prev.png');
    const next = fs.readFileSync(path.join(out, 'eyes_open.png'));
    if (fs.existsSync(mainPng) && !fs.existsSync(prev) && !fs.readFileSync(mainPng).equals(next)) fs.copyFileSync(mainPng, prev);
    fs.writeFileSync(mainPng, next);
    console.log(`✓ ${mainPng} ← eyes_open.png${fs.existsSync(prev) ? ' (이전 그림: character.prev.png)' : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
