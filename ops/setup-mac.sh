#!/bin/bash
# 치이카와 매니저 한 번에 설치(애플 실리콘 맥). 레포 폴더에서: ./ops/setup-mac.sh
#  1) 이 폴더를 받아 온 GitHub 저장소의 릴리스에서 앱(zip)과 캐릭터 묶음(있으면)을 받는다. 공개 저장소면 로그인 없이, 비공개면 gh 로그인. --build 면 소스로 직접 만든다
#  2) 앱을 응용 프로그램 폴더에 넣고(격리 표시 지움) 캐릭터 묶음을 ~/.cy-agent 에 넣는다
#  3) Claude Code 를 쓰면 Claude Code 연동(hook)을, Hermes 가 있으면 Hermes 연동을 켠다
#  4) 앱을 켠다. Slack·메일·캘린더·노션은 앱의 「연결 관리」에서 각자 계정으로 연결한다(열쇠·비밀번호는 각자 것)
# 옵션: --build · --tag v0.4.0 · --prefix <앱 넣을 폴더> · --home <데이터 폴더> · --no-hooks · --no-open · --repo owner/name
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')"
[ -n "$REPO" ] || REPO="jinyr1128/chiikawa-buddy"
TAG=""
PREFIX="/Applications"
HOME_DIR="${CY_AGENT_HOME:-$HOME/.cy-agent}"
BUILD=0; HOOKS=1; OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --tag) TAG="$2"; shift ;;
    --prefix) PREFIX="$2"; shift ;;
    --home) HOME_DIR="$2"; shift ;;
    --no-hooks) HOOKS=0 ;;
    --no-open) OPEN=0 ;;
    --repo) REPO="$2"; shift ;;
    *) echo "모르는 옵션: $1"; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="치이카와 매니저"
APP="$PREFIX/$APP_NAME.app"
say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*"; exit 1; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

say "맥 확인"
[ "$(uname -s)" = "Darwin" ] || die "맥에서만 돼요."
[ "$(uname -m)" = "arm64" ] || die "애플 실리콘(M1 이후) 맥용이에요. 인텔 맥은 --build 로 직접 만들어 주세요."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$BUILD" = 1 ]; then
  say "소스로 앱 만들기(몇 분 걸려요)"
  command -v node >/dev/null || die "Node.js 24 이상이 필요해요: brew install node"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "Node.js 24 이상이 필요해요(지금 $(node -v))."
  command -v swiftc >/dev/null || die "Xcode 명령줄 도구가 필요해요: xcode-select --install"
  (cd "$ROOT/agent" && npm ci --no-audit --no-fund)
  (cd "$ROOT/desktop" && npm ci --no-audit --no-fund && node node_modules/electron/install.js >/dev/null 2>&1 || true)
  (cd "$ROOT/desktop" && npm run dist -- --no-dmg)
  SRC_APP="$ROOT/desktop/dist/app/$APP_NAME-darwin-arm64/$APP_NAME.app"
  [ -d "$SRC_APP" ] || die "앱을 만들지 못했어요."
  PACK=""
else
  say "GitHub 릴리스에서 앱·캐릭터 받기"
  PACK="$WORK/chiikawa-characters.zip"
  # 1) 공개 저장소: 로그인 없이 바로 받는다(캐릭터 묶음은 있으면 받는다 — 인스타 공유용 판에는 없다)
  if [ -z "$TAG" ]; then
    LATEST="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
    case "$LATEST" in */releases/tag/*) TAG="${LATEST##*/}" ;; esac
  fi
  DL="https://github.com/$REPO/releases/download/$TAG"
  if [ -n "$TAG" ] && curl -fsSL -o "$WORK/chiikawa-manager-arm64.zip" "$DL/chiikawa-manager-arm64.zip" 2>/dev/null; then
    curl -fsSL -o "$WORK/SHA256SUMS.txt" "$DL/SHA256SUMS.txt" || die "검증 파일(SHA256SUMS.txt)을 못 받았어요."
    curl -fsSL -o "$PACK" "$DL/chiikawa-characters.zip" 2>/dev/null || rm -f "$PACK"
  else
    # 2) 비공개 저장소: 초대받은 계정으로 gh 로그인이 필요하다
    command -v gh >/dev/null || { command -v brew >/dev/null && brew install gh || die "gh 가 필요해요: brew install gh"; }
    gh auth status --hostname github.com >/dev/null 2>&1 || die "GitHub 로그인이 필요해요. 터미널에서 'gh auth login --web' 을 한 번 하고 다시 실행해 주세요(비공개 저장소라 초대받은 계정이어야 해요)."
    if [ -z "$TAG" ]; then TAG="$(gh release view -R "$REPO" --json tagName --jq .tagName)"; fi
    gh release download "$TAG" -R "$REPO" --pattern 'chiikawa-manager-arm64.zip' --pattern 'chiikawa-characters.zip' --pattern 'SHA256SUMS.txt' -D "$WORK" \
      || die "릴리스를 못 받았어요. 초대받은 GitHub 계정인지 확인해 주세요."
  fi
  (cd "$WORK" && shasum -a 256 -c --ignore-missing SHA256SUMS.txt) || die "다운로드 파일 검증에 실패했어요."
  [ -f "$PACK" ] || { PACK=""; echo "캐릭터 묶음 없음 — 기본 캐릭터 8명으로 시작해요(움짤 캐릭터는 앱에서 직접 넣을 수 있어요)."; }
  ditto -x -k "$WORK/chiikawa-manager-arm64.zip" "$WORK/unpacked"
  SRC_APP="$(find "$WORK/unpacked" -maxdepth 1 -name '*.app' -print -quit)" # 한글 이름 인코딩과 상관없이
  [ -d "$SRC_APP" ] || die "배포 파일 안에서 앱을 찾지 못했어요."
  codesign --verify --deep --strict "$SRC_APP" || die "앱 서명 검증에 실패했어요."

fi

say "앱 넣기: $APP"
if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true; sleep 3; pkill -f "$APP/Contents/MacOS" || true; sleep 1; fi
mkdir -p "$PREFIX"
if [ -d "$APP" ]; then
  BACKUP_APP="$PREFIX/$APP_NAME.previous.app"
  rm -rf "$BACKUP_APP"
  mv "$APP" "$BACKUP_APP"
fi
if ! ditto "$SRC_APP" "$APP"; then
  rm -rf "$APP"
  [ -d "${BACKUP_APP:-}" ] && mv "$BACKUP_APP" "$APP"
  die "앱 복사 실패 — 이전 앱을 복원했어요."
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
[ -d "$WORK/mnt" ] && hdiutil detach "$WORK/mnt" >/dev/null 2>&1 || true

# 앱 안의 Electron 을 Node 로 쓴다(Node.js 를 따로 깔지 않아도 되게)
NODE_BIN="$(command -v node || true)"
run_node() { if [ -n "$NODE_BIN" ]; then "$NODE_BIN" "$@"; else ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/chiikawa-buddy" "$@"; fi; }

if [ -n "${PACK:-}" ] && [ -f "$PACK" ]; then
  say "캐릭터 넣기"
  CY_AGENT_HOME="$HOME_DIR" run_node "$ROOT/ops/character-pack/import.mjs" "$PACK"
fi

say "처음 설정"
mkdir -p "$HOME_DIR"
CY_AGENT_HOME="$HOME_DIR" run_node -e '
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
const p = path.join(process.env.CY_AGENT_HOME, "config.json");
let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
let claude = false; try { execSync("command -v claude", { stdio: "ignore", shell: "/bin/zsh", env: { ...process.env, PATH: process.env.PATH + ":" + process.env.HOME + "/.local/bin:/opt/homebrew/bin" } }); claude = true; } catch {}
if (!c.brain && claude) c.brain = { provider: "claude-code" };   // Claude Code 가 있으면 그걸 AI 로
if (c.brain && c.onboarded === undefined) c.onboarded = true;    // AI 가 정해졌으면 처음 설정 마법사는 건너뛴다
c.calendarAlert = c.calendarAlert ?? { minutesBefore: [30, 10] }; // 회의 30분·10분 전 알림
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
console.log(claude ? "AI: Claude Code" : "AI: 앱을 켜면 고르는 화면이 나와요");
'

if [ "$HOOKS" = 1 ]; then
  say "AI 작업 연동"
  if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then run_node "$ROOT/ops/claude-hooks.mjs" on; else echo "Claude Code 없음 — 건너뜀(나중에 앱 「연결 관리」에서 켤 수 있어요)"; fi
  if [ -f "$HOME/.hermes/config.yaml" ]; then run_node "$ROOT/ops/hermes-hooks.mjs" on; fi
  [ -d "$HOME/.codex" ] && echo "Codex: 기록을 자동으로 지켜봐요(설정 필요 없음)"
fi

if [ "$OPEN" = 1 ]; then
  say "앱 켜기"
  open "$APP"
fi

cat <<EOF

🎉 설치 끝! 메뉴 막대(화면 위 오른쪽)의 아이콘 → 「홈」, 캐릭터는 「캐릭터 바꾸기」에서.
다음은 각자 계정으로 해 주세요(앱의 「연결 관리」 화면에서 버튼·붙여 넣기만 하면 돼요):
  • Slack · 메일(Gmail 앱 비밀번호) · 캘린더(맥 캘린더 계정) · 노션 · GitHub
처음 캘린더를 고를 때 macOS 가 「캘린더 접근」을 물으면 [허용].
EOF
