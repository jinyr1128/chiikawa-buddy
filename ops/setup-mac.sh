#!/bin/bash
# 치이카와 매니저 한 번에 설치(애플 실리콘 맥). 레포 폴더에서: ./ops/setup-mac.sh
#  1) GitHub 릴리스에서 앱(dmg)과 캐릭터 묶음을 받는다(비공개 저장소 → gh 로그인 필요). --build 면 소스로 직접 만든다
#  2) 앱을 응용 프로그램 폴더에 넣고(격리 표시 지움) 캐릭터 묶음을 ~/.cy-agent 에 넣는다
#  3) Claude Code 를 쓰면 Claude Code 연동(hook)을, Hermes 가 있으면 Hermes 연동을 켠다
#  4) 앱을 켠다. Slack·메일·캘린더·노션은 앱의 「연결 관리」에서 각자 계정으로 연결한다(열쇠·비밀번호는 각자 것)
# 옵션: --build · --tag v0.4.0 · --prefix <앱 넣을 폴더> · --home <데이터 폴더> · --no-hooks · --no-open · --repo owner/name
set -euo pipefail

REPO="jinyr1128/chiikawa-buddy"
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
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

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
  command -v gh >/dev/null || { command -v brew >/dev/null && brew install gh || die "gh 가 필요해요: brew install gh"; }
  gh auth status --hostname github.com >/dev/null 2>&1 || die "GitHub 로그인이 필요해요. 터미널에서 'gh auth login --web' 을 한 번 하고 다시 실행해 주세요(비공개 저장소라 초대받은 계정이어야 해요)."
  gh release download ${TAG:+"$TAG"} -R "$REPO" --pattern '*.dmg' --pattern 'chiikawa-characters.zip' -D "$WORK" \
    || die "릴리스를 못 받았어요. 저장소에 초대받았는지 확인해 주세요: https://github.com/$REPO"
  DMG="$(ls "$WORK"/*.dmg | head -1)"
  PACK="$WORK/chiikawa-characters.zip"
  hdiutil attach -nobrowse -readonly -mountpoint "$WORK/mnt" "$DMG" >/dev/null
  SRC_APP="$WORK/mnt/$APP_NAME.app"
fi

say "앱 넣기: $APP"
if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true; sleep 3; pkill -f "$APP/Contents/MacOS" || true; sleep 1; fi
mkdir -p "$PREFIX"
rm -rf "$APP"
ditto "$SRC_APP" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
[ -d "$WORK/mnt" ] && hdiutil detach "$WORK/mnt" >/dev/null 2>&1 || true

# 앱 안의 Electron 을 Node 로 쓴다(Node.js 를 따로 깔지 않아도 되게)
NODE_BIN="$(command -v node || true)"
run_node() { if [ -n "$NODE_BIN" ]; then "$NODE_BIN" "$@"; else ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/chiikawa-buddy" "$@"; fi; }

if [ -n "${PACK:-}" ] && [ -f "$PACK" ]; then
  say "캐릭터 넣기(짭몽가·찐몽가·움짤 캐릭터·시사 제주 사투리)"
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
