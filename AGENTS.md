# AI 설치 안내 (Claude Code·Codex 등이 읽는 파일)

사용자가 「이 저장소 설치해줘」라고 하면 아래 순서대로 한다. 사용자는 개발자가 아닐 수 있으니 진행 상황을 쉬운 말로 알려 준다.

1. 확인: **macOS + 애플 실리콘**(`uname -m` = `arm64`) 또는 **윈도우 10·11**. 둘 다 아니면(인텔 맥·리눅스) 멈추고 알린다.
2. 저장소가 아직 없으면 사용자가 준 주소로 `git clone <주소> chiikawa-manager` 한다. 공개 저장소면 GitHub 로그인이 필요 없다.
   - 비공개 저장소(클론이 안 됨)면 `gh auth status` 로 로그인을 확인한다. 로그인은 **사용자가 직접** 한다 — 터미널에 `gh auth login --hostname github.com --git-protocol https --web` 을 띄우고 브라우저에서 코드를 넣고 Authorize 하라고 안내한 뒤 기다린다(비밀번호·코드를 대신 입력하지 않는다). 저장소 주인이 초대한 계정이어야 한다.
3. 저장소 폴더에서 설치 스크립트를 실행한다(5분 안팎).
   - 맥: `./ops/setup-mac.sh`
   - 윈도우: `powershell -ExecutionPolicy Bypass -File ops\setup-win.ps1` (관리자 권한 필요 없음, `%LOCALAPPDATA%\ChiikawaManager` 에 깔림). 처음 실행 때 「Windows의 PC 보호」 창이 뜨면 사용자에게 「추가 정보 → 실행」을 누르라고 안내한다. 윈도우에서 Claude Code 작업 표시(hook)는 Claude Code 가 쓰는 Git Bash 로 돈다.
   - 공통: 이 폴더를 받아 온 저장소의 최신 릴리스를 받아 설치한다. 실패하면 오류 문구를 그대로 읽고 고친 뒤 다시 실행한다.
   - 소스로 만들어야 하면 `./ops/setup-mac.sh --build` (Node.js 24+, `xcode-select --install` 필요).
   - 「캐릭터 묶음 없음」은 오류가 아니다(공유판은 기본 캐릭터 8명으로 시작한다).
4. 끝나면 확인: `curl -s http://127.0.0.1:47823/health` 가 `{"ok":true…}` 이면 앱이 켜진 것. 메뉴 막대의 캐릭터 얼굴 아이콘 → 「홈」을 열어 보라고 안내한다.
5. 연결은 사용자가 앱의 「연결 관리」에서 각자 계정으로 한다(Slack 토큰·메일 앱 비밀번호·노션 시크릿은 **사용자가 직접 붙여 넣는다** — AI 가 받아 적거나 대신 입력하지 않는다). 각 카드에 버튼과 단계가 있다.
6. macOS 가 「캘린더 접근」을 물으면 [전체 접근 허용]을 누르라고 알린다.
7. AI 작업 표시 확인(사용자가 쓰는 도구만):
   - Claude Code: `node ops/claude-hooks.mjs status` 가 「연동 켜짐」이면 된다. 터미널용 `claude` 가 로그인 전이면 **사용자가 직접** `claude auth login` 으로 브라우저에서 승인한다.
   - Codex: 설정이 필요 없다. CLI 를 원하면 `npm i -g @openai/codex` 후 사용자가 `codex login`.
   - `curl -s http://127.0.0.1:47823/usage` 로 AI 사용량(한도 %·오늘 토큰)이 읽히는지 본다. 한도 %는 그 도구를 한 번 쓰고 나면 채워진다.

업데이트: 저장소 폴더에서 `./ops/update.sh` (앱을 끄고 새 버전으로 바꾼 뒤 다시 켠다. 계정 연결·설정·캐릭터·기록은 그대로).

지우기: `osascript -e 'tell application "치이카와 매니저" to quit'; rm -rf "/Applications/치이카와 매니저.app"` (데이터는 `~/.cy-agent`, Claude 연동 끄기는 `node ops/claude-hooks.mjs off`, Hermes 는 `node ops/hermes-hooks.mjs off`).

## 배포·검증 범위

릴리스는 서명된 arm64 앱 zip, (있으면) 캐릭터 묶음 zip, SHA256SUMS.txt를 제공한다. 설치 스크립트가 체크섬을 확인한다. 사용자 개인 설정·인증·메일·할 일·대화는 배포하지 않는다.
노션은 통합에 공유한 페이지까지만 읽을 수 있다(회사 워크스페이스는 관리자 승인이 필요할 수 있다). 네이버는 맥 캘린더에 CalDAV 로그인 후 앱에서 캘린더를 추가해야 한다. 실제 연결 결과가 없으면 완료라고 보고하지 않는다.
설치 뒤 앱 버전, `/health`, 캐릭터 목록을 확인하고 로그인/권한 대기 항목을 구분해 보고한다.
