#!/bin/sh
# 최신 버전 받기: GitHub 에서 받아(처음이면 clone, 있으면 pull) → install.sh 로 설치·적용 → 데몬·앱 다시 띄우기.
# 받은 폴더 안에서: ./ops/update.sh
# 폴더가 없어도(처음 설치도) 한 줄로: curl -fsSL https://raw.githubusercontent.com/cheo0y/shisa-agent/main/ops/update.sh | sh
# 다른 폴더에 두려면 SHISA_DIR=~/어딘가 를 앞에 붙인다
set -eu
REPO="${SHISA_REPO:-https://github.com/cheo0y/shisa-agent.git}"

# 이 스크립트가 레포 안에 있으면 그 레포, 아니면(curl 로 받아 실행) ~/shisa-agent
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "${SHISA_DIR:-}" ]; then DIR="$SHISA_DIR"
elif [ -n "$HERE" ] && [ -f "$HERE/install.sh" ] && [ -d "$HERE/../agent" ]; then DIR=$(cd "$HERE/.." && pwd)
else DIR="$HOME/shisa-agent"; fi

command -v git >/dev/null 2>&1 || { echo "✗ git 이 없습니다. 터미널에 xcode-select --install 을 입력해 설치한 뒤 다시 실행해 주세요."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ Node.js 가 없습니다. brew install node 로 설치한 뒤 다시 실행해 주세요."; exit 1; }

if [ ! -d "$DIR" ]; then
  echo "→ $DIR 에 처음 받는 중…"
  git clone "$REPO" "$DIR"
elif [ ! -d "$DIR/.git" ]; then
  echo "✗ $DIR 은 git 으로 받은 폴더가 아닙니다(ZIP 으로 받은 경우). 폴더 이름을 바꿔 두고 다시 실행하면 새로 받습니다."
  exit 1
else
  cd "$DIR"
  # 직접 고친 파일이 있으면 덮어쓰지 않고 멈춘다
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "✗ 이 폴더에 직접 고친 파일이 있어 멈춥니다:"; git status --short --untracked-files=no
    echo "  고친 걸 버려도 되면: cd \"$DIR\" && git checkout -- . 후 다시 실행해 주세요."
    exit 1
  fi
  BEFORE=$(git rev-parse --short HEAD)
  echo "→ 최신 버전 받는 중…"
  git symbolic-ref -q HEAD >/dev/null || { echo "✗ 지금 브랜치 위에 있지 않습니다. cd \"$DIR\" && git checkout main 후 다시 실행해 주세요."; exit 1; }
  if ! git pull -q --ff-only; then
    echo "✗ 최신 버전을 받지 못했습니다. 인터넷 연결을 확인해 주세요."
    echo "  이 폴더에서 직접 커밋을 만들었거나, 새 버전과 이름이 같은 파일을 직접 넣어 두었다면 그것 때문일 수 있습니다(위 영어 메시지 참고)."
    exit 1
  fi
  AFTER=$(git rev-parse --short HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then echo "→ 이미 최신입니다($AFTER). 그래도 다시 설치하고 띄웁니다."
  else echo "→ $BEFORE → $AFTER 바뀐 것:"; git log --oneline "$BEFORE..$AFTER" | sed 's/^/   /'; fi
fi

# 설치·적용(의존성·앱 빌드) 후 데몬·앱을 다시 띄운다(launchd 등록을 새로 하면 바로 켜진다)
cd "$DIR" && sh ./ops/install.sh
echo "✓ 최신 버전으로 다시 띄웠습니다. 캐릭터가 화면에 다시 나타나면 끝입니다."
