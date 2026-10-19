# 치이카와 매니저 — 윈도우

윈도우 10·11에서도 바탕화면 구석에 치이카와 친구들이 살아요. 하는 일은 맥 버전과 같아요([README](../README.md)).
데이터는 전부 내 PC(`%USERPROFILE%\.cy-agent\`)에만 저장돼요.

## 설치

**AI에게 맡기기(추천)**: Claude Code·Codex에 저장소 주소를 붙이고 「이거 내 PC에 설치해줘. AGENTS.md 대로 해줘」.

**직접 설치(PowerShell)**:

```powershell
git clone <이 저장소 주소>.git chiikawa-manager
cd chiikawa-manager
powershell -ExecutionPolicy Bypass -File ops\setup-win.ps1
```

- 설치 파일은 저장소의 윈도우 릴리스(태그 `v<버전>-windows`)에서 받아요. SHA-256으로 검증해요.
- 관리자 권한이 필요 없어요. `%LOCALAPPDATA%\ChiikawaManager`에 깔리고, 바탕 화면·시작 메뉴 바로 가기와 로그인할 때 자동 실행이 생겨요.
- 코드 서명을 하지 않은 앱이라 처음에 파란 「Windows의 PC 보호」 창이 뜰 수 있어요 → 「추가 정보」 → 「실행」.

## 맥과 다른 점

| | 윈도우 |
|---|---|
| 캐릭터 얼굴 아이콘 | 작업 표시줄 오른쪽 알림 영역(시계 옆, 안 보이면 `^`) |
| 캘린더 | iCal 비공개 주소로 연결(구글: 설정 → 캘린더 통합 → iCal 형식의 비공개 주소) — 「맥 캘린더에서 고르기」는 맥 전용 |
| Claude Code 작업 표시 | Claude Code(윈도우판은 Git Bash 필요)의 hook 으로 같아요 |
| Hermes 연동 | 맥 전용 |

## 업데이트·지우기

- 업데이트: 저장소 폴더에서 `git pull` 후 `powershell -ExecutionPolicy Bypass -File ops\setup-win.ps1`
- 지우기: 설정 → 앱 → 「치이카와 매니저」 제거. 데이터는 `%USERPROFILE%\.cy-agent`에 남아요.

## 만드는 사람용

윈도우 설치 파일은 **GitHub Actions**(윈도우 빌드 서버)가 만들어요: 맥 릴리스(`v<버전>`)가 올라오면 [`.github/workflows/windows.yml`](../.github/workflows/windows.yml)이 윈도우에서 테스트하고 `node windows/dist-win.mjs --arch=x64`로 Setup.exe·휴대용 zip을 만들어 `v<버전>-windows` 릴리스에 올려요. 손으로 돌리려면 저장소 → Actions → windows → Run workflow.
