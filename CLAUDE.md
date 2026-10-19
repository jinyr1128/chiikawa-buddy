# AI 설치 안내 (Claude Code·Codex 등이 읽는 파일)

사용자가 「이 저장소 세팅해줘」라고 하면 아래 순서대로 한다. 사용자는 개발자가 아닐 수 있으니 진행 상황을 쉬운 말로 알려 준다.

1. 확인: macOS + 애플 실리콘(`uname -m` = `arm64`). 아니면 멈추고 알린다.
2. GitHub 로그인 확인: `gh auth status`. `gh` 가 없으면 `brew install gh`. 로그인이 안 돼 있으면 **사용자가 직접** 해야 한다 — 터미널에서 `gh auth login --hostname github.com --git-protocol https --web` 을 띄우고, 브라우저에서 코드를 넣고 Authorize 하라고 안내한 뒤 끝날 때까지 기다린다(비밀번호·코드를 대신 입력하지 않는다). 비공개 저장소라 저장소 주인이 초대한 계정이어야 한다.
3. 저장소 폴더에서 `./ops/setup-mac.sh` 를 실행한다(5분 안팎). 실패하면 오류 문구를 그대로 읽고 고친 뒤 다시 실행한다.
   - 릴리스를 못 받으면 저장소 초대 여부를 사용자에게 확인한다.
   - 소스로 만들어야 하면 `./ops/setup-mac.sh --build` (Node.js 24+, `xcode-select --install` 필요).
4. 끝나면 확인: `curl -s http://127.0.0.1:47823/health` 가 `{"ok":true…}` 이면 앱이 켜진 것. 메뉴 막대 아이콘 → 「홈」을 열어 보라고 안내한다.
5. 연결은 사용자가 앱의 「연결 관리」에서 각자 계정으로 한다(Slack 토큰·메일 앱 비밀번호·노션 시크릿은 **사용자가 직접 붙여 넣는다** — AI 가 받아 적거나 대신 입력하지 않는다). 각 카드에 버튼과 단계가 있다.
6. 처음 캘린더를 고를 때(또는 새 버전을 처음 켤 때) macOS 가 「캘린더 접근」을 물으면 [전체 접근 허용]을 누르라고 알린다.
7. AI 작업 표시 확인(사용자가 쓰는 도구만):
   - Claude Code: `node ops/claude-hooks.mjs status` 가 「연동 켜짐」이면 된다. 터미널용 `claude` 가 로그인 전이면 **사용자가 직접** `claude auth login` 으로 브라우저에서 승인한다.
   - Codex: 설정이 필요 없다. CLI 를 원하면 `npm i -g @openai/codex` 후 사용자가 `codex login`.
   - `curl -s http://127.0.0.1:47823/usage` 로 AI 사용량(한도 %·오늘 토큰)이 읽히는지 본다. 한도 %는 그 도구를 한 번 쓰고 나면 채워진다.

업데이트: 저장소 폴더에서 `git pull && ./ops/setup-mac.sh` (앱을 끄고 새 버전으로 바꾼 뒤 다시 켠다. 설정·캐릭터는 그대로).

지우기: `osascript -e 'tell application "치이카와 매니저" to quit'; rm -rf "/Applications/치이카와 매니저.app"` (데이터는 `~/.cy-agent`, Claude 연동 끄기는 `node ops/claude-hooks.mjs off`, Hermes 는 `node ops/hermes-hooks.mjs off`).
