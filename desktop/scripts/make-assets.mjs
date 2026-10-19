// 플레이스홀더 이미지 생성 — 캐릭터(blob) PNG, 트레이 템플릿 아이콘.
// 진짜 캐릭터가 오면 assets/character.png 만 덮어쓰면 된다.
// 사용: node scripts/make-assets.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const force = process.argv.includes('--force');

// ---- 최소 PNG 인코더 (RGBA 8bit) ----
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 래스터라이저: shade(x,y) → [r,g,b,a] | null, 4x4 슈퍼샘플링 ----
function render(w, h, shade, ss = 4) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / w, (y + (sy + 0.5) / ss) / h);
          if (!c) continue;
          const ca = c[3] / 255;
          r += c[0] * ca; g += c[1] * ca; b += c[2] * ca; a += ca;
        }
      }
      const n = ss * ss;
      const i = (y * w + x) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// 귀여운 blob: 말랑한 몸통 + 눈 + 볼터치 + 입
function blob(x, y) {
  // 몸통: 아래가 살짝 넓은 물방울형
  const cx = 0.5, cy = 0.6;
  const ry = 0.36;
  const rx = 0.4 + 0.04 * Math.max(0, (y - cy) / ry);
  const body = inEllipse(x, y, cx, cy, rx, ry);
  const outline = inEllipse(x, y, cx, cy, rx + 0.018, ry + 0.018);
  // 바닥 그림자
  if (!outline) {
    if (inEllipse(x, y, 0.5, 0.965, 0.3, 0.03)) return [0, 0, 0, 40];
    return null;
  }
  if (!body) return [92, 78, 160, 255];
  // 눈
  for (const ex of [0.38, 0.62]) {
    if (inEllipse(x, y, ex + 0.012, 0.535, 0.022, 0.022)) return [255, 255, 255, 255];
    if (inEllipse(x, y, ex, 0.55, 0.042, 0.055)) return [40, 34, 66, 255];
  }
  // 볼
  for (const bx of [0.29, 0.71]) {
    if (inEllipse(x, y, bx, 0.645, 0.055, 0.03)) return [255, 150, 170, 200];
  }
  // 입: 작은 호
  const md = Math.hypot(x - 0.5, y - 0.6);
  if (y > 0.62 && md > 0.045 && md < 0.062 && Math.abs(x - 0.5) < 0.045) return [40, 34, 66, 255];
  // 하이라이트
  if (inEllipse(x, y, 0.36, 0.38, 0.07, 0.04)) return [255, 255, 255, 140];
  // 위→아래 그라데이션
  const t = Math.min(1, Math.max(0, (y - 0.24) / 0.72));
  return mix([196, 186, 255, 255], [150, 132, 236, 255], t);
}

// 트레이: 검정 blob + 투명 눈 (template 이미지)
function trayShape(x, y) {
  for (const ex of [0.37, 0.63]) if (inEllipse(x, y, ex, 0.52, 0.07, 0.1)) return null;
  if (inEllipse(x, y, 0.5, 0.56, 0.42, 0.38)) return [0, 0, 0, 255];
  return null;
}

function write(name, buf) {
  const p = path.join(ASSETS, name);
  if (!force && fs.existsSync(p)) return console.log(`skip ${name} (exists, --force to overwrite)`);
  fs.writeFileSync(p, buf);
  console.log(`wrote ${name}`);
}

fs.mkdirSync(ASSETS, { recursive: true });
write('character.png', encodePNG(280, 280, render(280, 280, blob)));
write('trayTemplate.png', encodePNG(16, 16, render(16, 16, trayShape)));
write('trayTemplate@2x.png', encodePNG(32, 32, render(32, 32, trayShape)));
