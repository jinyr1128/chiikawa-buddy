#!/bin/bash
# Apple Silicon 배포. --publish면 검증한 파일을 비공개 GitHub 릴리스에 게시한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${SHISA_RELEASE_REPO:-jinyr1128/chiikawa-buddy}"
VER="$(node -p "require('$ROOT/desktop/package.json').version")"
DIST="$ROOT/desktop/dist/release-$VER"
mkdir -p "$DIST"
(cd "$ROOT/desktop" && npm run dist -- --no-dmg)
APP="$(find "$ROOT/desktop/dist/app" -maxdepth 2 -name '*.app' -print -quit)" # 한글 이름은 조합형·완성형이 달라 이름으로 찾으면 놓친다
[ -d "$APP" ] || { echo '앱 빌드 결과 없음'; exit 1; }
codesign --verify --deep --strict "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/chiikawa-manager-arm64.zip"
# CHAR_PACK_LITE=1: 공개 공유판 — 움짤 캐릭터는 빼고 기본 캐릭터 대사(시사 사투리 등)만
node "$ROOT/ops/character-pack/export.mjs" "$DIST/chiikawa-characters.zip" 찐몽가 ${CHAR_PACK_LITE:+--lite}
(cd "$DIST" && shasum -a 256 chiikawa-manager-arm64.zip chiikawa-characters.zip > SHA256SUMS.txt)
if [ "${1:-}" = '--publish' ]; then
  NOTES="${RELEASE_NOTES:-$ROOT/docs/releases/v$VER.md}"
  [ -f "$NOTES" ] || { echo "릴리스 설명 필요: $NOTES"; exit 1; }
  gh release create "v$VER" "$DIST/chiikawa-manager-arm64.zip" "$DIST/chiikawa-characters.zip" "$DIST/SHA256SUMS.txt" --repo "$REPO" --target "$(git -C "$ROOT" rev-parse HEAD)" --title "치이카와 매니저 v$VER" --notes-file "$NOTES"
else
  echo "배포 파일: $DIST (게시하려면 --publish)"
fi
