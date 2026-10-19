// 원본 그림(흰 배경 png·jpg)에서 캐릭터 그림을 다시 만든다 — 결과는 ~/.cy-agent/assets. 레포에는 완성본이 assets/ 에 있고
// 설치(ops/install.sh)는 그걸 복사하므로 보통은 이 스크립트가 필요 없다. 새 그림으로 바꿀 때만 쓴다.
//   <src>/character_square.png → ~/.cy-agent/assets/character.png (흰 배경을 가장자리에서만 지워 투명하게)
//   <src>/character_<name>.jpg → ~/.cy-agent/assets/reactions/<name>.jpg
// 사용: node scripts/prepare-assets.mjs [--src ~/Downloads] [--force]
// 이미 있으면 건너뛴다(--force 로 다시). 의존성 없음(PNG 는 scripts/png.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePNG, encodePNG } from './png.mjs';

export const REACTIONS = ['merge', 'merge_complete', 'lots', 'daily', 'daily_all_complete', 'daily_half_complete', 'to_do_new'];

// 가장자리에서 이어진 '거의 흰색'만 투명하게. 안쪽 흰색(옷깃 등)은 외곽선에 막혀 남는다.
// 흰 배경과 맞닿은 테두리 한두 줄은 밝기에 따라 반투명으로 풀고 흰색을 빼 준다(헤일로 방지).
export function knockOutWhite({ w, h, rgba }, { min = 236, spread = 16 } = {}) {
  const out = Buffer.from(rgba);
  const isBg = (i) => {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
    return out[i + 3] > 0 && lo >= min && hi - lo <= spread;
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  const seed = (x, y) => { const k = y * w + x; if (!seen[k] && isBg(k * 4)) { seen[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const k = stack.pop();
    const x = k % w, y = (k - x) / w;
    out[k * 4 + 3] = 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  // 경계 정리: 지운 칸과 맞닿은 밝은 칸 → 밝을수록 투명하게, 흰색 섞인 만큼 색을 되돌린다(2바퀴)
  for (let pass = 0; pass < 2; pass++) {
    const edge = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (out[k * 4 + 3] !== 255) continue;
        const near = (x > 0 && out[(k - 1) * 4 + 3] < 255) || (x < w - 1 && out[(k + 1) * 4 + 3] < 255)
          || (y > 0 && out[(k - w) * 4 + 3] < 255) || (y < h - 1 && out[(k + w) * 4 + 3] < 255);
        if (near) edge.push(k);
      }
    }
    for (const k of edge) {
      const i = k * 4;
      const lo = Math.min(out[i], out[i + 1], out[i + 2]);
      if (lo < 170) continue; // 진한 외곽선은 그대로
      const a = Math.max(0.15, Math.min(1, (255 - lo) / (255 - 170)));
      for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((out[i + c] - 255 * (1 - a)) / a)));
      out[i + 3] = Math.round(a * 255);
    }
  }
  return { w, h, rgba: out };
}

export function alphaAt({ w, rgba }, x, y) {
  return rgba[(y * w + x) * 4 + 3];
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const si = args.indexOf('--src');
  const src = si >= 0 ? args[si + 1] : path.join(os.homedir(), 'Downloads');
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const dest = path.join(home, 'assets');
  fs.mkdirSync(path.join(dest, 'reactions'), { recursive: true });

  const main = path.join(src, 'character_square.png');
  const mainOut = path.join(dest, 'character.png');
  if (fs.existsSync(main) && (force || !fs.existsSync(mainOut))) {
    const img = knockOutWhite(decodePNG(fs.readFileSync(main)));
    fs.writeFileSync(mainOut, encodePNG(img.w, img.h, img.rgba));
    console.log(`✓ character.png (${img.w}×${img.h}, 모서리 알파 ${alphaAt(img, 0, 0)})`);
  } else if (!fs.existsSync(main)) console.log(`- ${main} 없음 — 건너뜀`);
  else console.log('- character.png 있음 (--force 로 다시)');

  for (const name of REACTIONS) {
    const from = path.join(src, `character_${name}.jpg`);
    const to = path.join(dest, 'reactions', `${name}.jpg`);
    if (!fs.existsSync(from)) { console.log(`- character_${name}.jpg 없음`); continue; }
    if (!force && fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
    console.log(`✓ reactions/${name}.jpg`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
