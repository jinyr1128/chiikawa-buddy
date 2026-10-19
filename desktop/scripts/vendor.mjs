// 렌더러용 라이브러리를 node_modules 에서 renderer/vendor/ 로 복사한다(번들러·CDN 없음).
// 사용: npm run vendor   (marked/dompurify 버전 올린 뒤 한 번)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'renderer', 'vendor');
const FILES = [
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
];

fs.mkdirSync(out, { recursive: true });
for (const [src, dst] of FILES) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', src.split('/')[0], 'package.json'), 'utf8'));
  // 소스맵 참조는 빼고(파일 없음), 출처·버전은 머리에 남긴다
  const code = fs.readFileSync(path.join(root, 'node_modules', src), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  fs.writeFileSync(path.join(out, dst), `// vendored: ${pkg.name}@${pkg.version} (${pkg.license}) — scripts/vendor.mjs 로 갱신\n${code}`);
  console.log(`${dst} ← ${pkg.name}@${pkg.version}`);
}
