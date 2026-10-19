# 뇌(대화하는 AI) 고르기

뇌(AI)는 선택입니다. 뇌가 없어도 할 일 보기, 오늘 할 일 표, 정해진 말(인사·응원), 회의 알림(ICS)은 동작합니다. 말 걸기·채팅·브리핑 요약까지 쓰고 싶을 때 뇌를 하나 연결하면 됩니다.

가장 쉬운 방법은 설치 마법사의 「뇌 고르기」입니다. 패널 「설치」 탭이나 설정(⚙)의 「설치 다시 하기」에서 열 수 있습니다.

이 맥에 Claude Code나 Codex가 로그인돼 있으면 「찾았어요 ✓」로 떠서 누르기만 하면 됩니다. API 키는 붙여 넣는 순간 맞는 키인지 확인해 줍니다. AI 없이 쓰려면 「AI 없이 쓰기」를 고르세요. 뇌가 `local`로 정해지고 마법사는 다음 단계로 이어집니다.

고른 뇌는 `~/.cy-agent/config.json`의 `brain`에 저장되고, 데몬을 다시 켜지 않아도 바로 적용됩니다(`PUT /settings`).

| 뇌 | `brain.provider` | 필요한 것 | 할 수 있는 것 |
|---|---|---|---|
| Claude Code | `claude-code`(기본) | Claude Code 설치·로그인(Pro·Max·Team·Enterprise 또는 Console), [claude-code.md](claude-code.md) 참고 | 전부: 대화·브리핑, 할 일 자동 완료·진척, 지식그래프, mcp 연결, 코드 고치기·작업 세션·자동 머지 |
| Codex | `codex` | Codex CLI 설치·로그인(ChatGPT 유료 계정) | 대화·브리핑, 할 일 자동 완료·진척, 지식그래프·나에 대해 배우기 |
| Gemini | `gemini` | Google AI Studio 키 | 대화·브리핑 |
| OpenAI | `openai` | OpenAI 플랫폼 키(크레딧 필요) | 대화·브리핑 |
| Claude API | `anthropic` | Anthropic 콘솔 키(크레딧 필요) | 대화·브리핑 |
| Genspark | `genspark` | Genspark 유료 플랜 + `gsk login` 한 키 또는 붙여 넣은 `gsk-` 키 | 대화·브리핑 |
| 없음(AI 없이 쓰기) | `local` | 없음 | 정해진 말, 할 일, 오늘 할 일 표, 회의 알림 |

코드 고치기, 워크트리, 백그라운드 에이전트, 작업 세션의 「새 작업」·「이어서 하기」, 자동 머지는 뇌를 무엇으로 골랐든 Claude Code로 돌아갑니다. Claude Code가 없으면 이 버튼들은 아예 보이지 않습니다.

Gemini·OpenAI·Claude API·Genspark 뇌는 도구를 쓰지 못하고 답만 받습니다. 그래서 브리핑도 Slack(api)이나 캘린더(ICS)처럼 시사가 직접 모아 둔 자료만 가지고 합니다.

## Genspark

Genspark의 LLM 프록시(OpenAI 호환)로 Claude·GPT 등 여러 회사 모델을 키 하나로 씁니다.

1. [genspark.ai](https://www.genspark.ai)에 가입하고 [요금제](https://www.genspark.ai/pricing)에서 유료 플랜을 고릅니다. 무료 플랜 키로는 모델 목록만 열리고 대답은 하지 않습니다.
2. 터미널에서 공식 CLI를 깔고 로그인합니다.

   ```bash
   npm install -g @genspark/cli
   gsk login
   ```

3. 설치 마법사의 「뇌 고르기」에서 Genspark를 고르고 「gsk login 한 키 쓰기」를 누릅니다. 키를 직접 붙여 넣어도 됩니다.

「gsk login 한 키 쓰기」를 고르면 시사는 키를 따로 저장하지 않고, 쓸 때마다 `~/.genspark-tool-cli/config.json`의 키를 읽습니다. 다시 로그인해서 키가 바뀌어도 그대로 따라갑니다. 시사는 이 파일을 읽기만 하고 고치지 않습니다.

모델은 프록시의 모델 목록(`GET /models`)에 있는 것만 고를 수 있습니다. 패널 [모델] 탭에 그 목록이 그대로 나옵니다. 기본값은 목록에 있으면 `claude-sonnet-5-5`, 없으면 `gpt-5.4-mini`, 그것도 없으면 목록의 첫 모델입니다. 목록에 없는 모델을 고르면 요청을 보내기 전에 막고 알려 줍니다.

연결 상태에 「Genspark 키는 맞지만 크레딧이 필요해요」가 보이면 키는 맞은 것입니다. 유료 플랜을 고른 뒤 다시 말을 걸면 바로 됩니다. 「Genspark 키가 맞지 않아요」가 보이면 `gsk login`을 다시 해 주세요.

## 파일로 직접 넣기

```json
{ "brain": { "provider": "gemini", "geminiApiKey": "..." } }
```

| 키 | 환경변수(파일보다 우선) |
|---|---|
| `brain.provider` | `CY_AGENT_BRAIN` |
| `brain.geminiApiKey` | `CY_AGENT_GEMINI_API_KEY`, `GEMINI_API_KEY` |
| `brain.openaiApiKey` | `CY_AGENT_OPENAI_API_KEY`, `OPENAI_API_KEY` |
| `brain.anthropicApiKey` | `CY_AGENT_ANTHROPIC_API_KEY`(`ANTHROPIC_API_KEY`는 Claude Code도 쓰는 이름이라 읽지 않습니다) |
| `brain.gensparkApiKey` | `CY_AGENT_GENSPARK_API_KEY`(둘 다 없으면 `gsk login`이 남긴 `~/.genspark-tool-cli/config.json`) |
| `models.general` | `CY_AGENT_MODEL_GENERAL`(대화·브리핑 모델. 비우면 뇌마다 기본 모델) |

파일을 직접 고쳤다면 데몬을 다시 켜 주세요.

```bash
launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
```

키는 로그나 오류 메시지에 남지 않습니다. 연결 상태는 패널이나 설정 창의 「연결 상태」(`GET /status`)에서 볼 수 있고, 여기에도 키 값은 나오지 않습니다.
