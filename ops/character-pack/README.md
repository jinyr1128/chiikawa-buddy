# 캐릭터 움짤 만들기 도구

움짤(GIF)·영상(webm)의 배경을 지워 캐릭터에 넣을 때 쓰는 도구입니다. 그림 파일 자체는 저작권 때문에 저장소에 넣지 않고, 각자 맥의 `~/.cy-agent/characters/`에만 둡니다.

## 1. 배경 지우기 (GIF → 배경 투명한 움직이는 PNG)

맥 내장 「피사체 분리」(Vision)로 장면마다 배경을 지웁니다. macOS 14 이상.

```bash
swiftc -O ops/character-pack/nukki.swift -o /tmp/nukki
/tmp/nukki 입력.gif 출력.png          # 출력: "<장면 수> <분리 성공 수>"
```

## 2. 영상(webm)에서 장면 뽑기 → 배경 지우기

```bash
E=desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
"$E" ops/character-pack/extract-frames.cjs 영상.webm /tmp/frames 24   # 초당 24장
/tmp/nukki /tmp/frames 출력.png 0.0417                                 # 폴더 입력 + 장면 간격(초)
```

## 3. 확인할 것

배경 지우기가 깨지는 경우가 있어요. 넣기 전에 장면을 훑어보고 빼세요.

- 배경 조각(풀·벽·구름)이 남음
- 캐릭터와 배경 색이 같아 몸이 지워짐(예: 검은 배경 + 세이렌 검은 머리)
- 중간에 뒤로 돌거나 다른 캐릭터가 끼어듦

## 4. 앱에 넣기

설정 창 「캐릭터 → ＋ 새 캐릭터」에서 칸마다 파일을 넣거나, 앱 API(`PUT /characters/:id/media/:slot`, docs/contract.md)로 넣습니다.
칸: 대기(eyes_open·eyes_closed) · 작업 중(study) · 확인 필요(plan) · 춤(dance) · 응원(cheer) · 점심(lunch).
