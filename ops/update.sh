#!/bin/sh
# 최신 버전으로 업데이트: 이 저장소 폴더에서 ./ops/update.sh
# 받아 온 GitHub 저장소에서 최신 코드를 받고(git pull) → setup-mac.sh 로 최신 릴리스 앱을 설치한다. 설정·캐릭터·기록은 그대로.
# AI(Claude Code·Codex)에게 「치이카와 매니저 업데이트해줘」라고 해도 된다.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
command -v git >/dev/null 2>&1 || { echo "✗ git 이 없어요. 터미널에 xcode-select --install 을 입력해 설치한 뒤 다시 실행해 주세요."; exit 1; }
[ -d .git ] || { echo "✗ git 으로 받은 폴더가 아니에요(ZIP 으로 받은 경우). README 대로 다시 받아 주세요."; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ 이 폴더에 직접 고친 파일이 있어 멈춰요:"; git status --short --untracked-files=no
  echo "  고친 걸 버려도 되면: git checkout -- . 후 다시 실행해 주세요."
  exit 1
fi
echo "→ 최신 코드 받는 중…"
git pull -q --ff-only || { echo "✗ 최신 코드를 받지 못했어요. 인터넷 연결을 확인해 주세요."; exit 1; }
exec "$DIR/ops/setup-mac.sh" --update-only "$@"
