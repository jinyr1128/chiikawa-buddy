# Slack 연결

Slack은 두 가지 용도로 씁니다.

| 용도 | 무엇이 필요 | 설정 키 |
|---|---|---|
| **봇 DM**: 브리핑·제안·승인 버튼·캔버스를 봇 DM으로 받기 | 봇 토큰(`xoxb-`) + 앱 토큰(`xapp-`) + 내 멤버 ID | `slackBotToken` · `slackAppToken` · `slackUserId` |
| **Slack 읽기**: 내 DM·멘션·참여 스레드를 브리핑에 넣기 | 아래 모드 중 하나 | `connectors.slack` |

`connectors.slack`의 모드는 다음과 같습니다.

| 모드 | 어떻게 읽나 | 추천 |
|---|---|---|
| `api` | 내 Slack 앱의 사용자 토큰(`xoxp-`, 읽기 스코프만)으로 Web API를 직접 부릅니다. 5분마다 새 메시지만 받아 로컬 DB(`~/.cy-agent/cy.db`)에 쌓고, 브리핑은 그걸 봅니다. 중간에 모델을 거치지 않아서 결과가 매번 같습니다 | **추천** |
| `mcp` | Claude Code에 등록한 Slack MCP 서버. 로컬에 모으지 않고 브리핑·채팅 모델이 그때그때 도구로 읽습니다 | 앱을 만들 수 없을 때 |
| `off` | 읽지 않습니다 | |

`mcp` 모드는 Claude Code 뇌일 때만 읽힙니다(다른 뇌는 도구를 쓰지 못합니다). `api` 모드는 어떤 뇌든 됩니다.

설치 마법사(패널 「설치」 → 「더 연결하기」 → Slack)에는 두 가지 길이 있습니다. 앱 사용자 토큰을 넣는 쪽은 아래 (a)와 같고, Slack 공식 MCP로 로그인하는 쪽은 `connectors.slack`을 `{ "mode": "mcp", "server": "slack" }`로 넣어 줍니다. 어느 쪽이든 끝나면 데몬을 한 번 다시 켜 주세요(`launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`).

---

## (a) 추천: api 모드, 내 Slack 앱 하나로 봇 + 사용자 토큰

앱 하나에 봇(DM용)과 읽기 전용 사용자 스코프를 같이 넣은 매니페스트 [`ops/slack-user-manifest.yaml`](../../ops/slack-user-manifest.yaml)을 씁니다. 봇 부분은 [`ops/slack-manifest.yaml`](../../ops/slack-manifest.yaml)과 똑같고, 사용자 스코프는 읽기 전용입니다.

`channels:history` `groups:history` `im:history` `mpim:history` `channels:read` `groups:read` `im:read` `mpim:read` `users:read` `search:read`

> 봇 DM이 필요 없다면 매니페스트에서 `features.bot_user`·`oauth_config.scopes.bot`·`settings`를 지워도 되지만, 그대로 두기를 권합니다.

### 1) 앱 만들기

1. https://api.slack.com/apps 접속 → 오른쪽 위 **Create New App**
2. **From a manifest** 선택
3. 워크스페이스 고르기 → **Next**
4. 형식 탭을 **YAML**로 바꾸고, 기본 내용을 지운 뒤 `ops/slack-user-manifest.yaml` 내용을 통째로 붙여넣기 → **Next**
5. 요약(봇 스코프 7개, 사용자 스코프 10개, Socket Mode 켜짐)을 확인하고 **Create**

### 2) 설치

1. 왼쪽 **Install App**(또는 **OAuth & Permissions**) → **Install to Workspace** → 권한 화면에서 **허용(Allow)**
2. 워크스페이스가 앱 승인을 요구하면 "관리자에게 요청" 화면이 나옵니다. 관리자가 승인해야 토큰이 생깁니다(워크스페이스 정책에 따라 다르고, 개인 워크스페이스라면 보통 바로 설치됩니다).

### 3) 토큰 복사

| 어디서 | 무엇 | 어디에 |
|---|---|---|
| **OAuth & Permissions** → OAuth Tokens → **User OAuth Token** | `xoxp-…` | `connectors.slack.userToken` |
| **OAuth & Permissions** → OAuth Tokens → **Bot User OAuth Token** | `xoxb-…` | `slackBotToken` |
| **Basic Information** → App-Level Tokens → **Generate Token and Scopes** → 이름 아무거나, 스코프 `connections:write` 추가 → **Generate** | `xapp-…` | `slackAppToken` |
| Slack 앱에서 내 프로필 → ⋮(더 보기) → **멤버 ID 복사** | `U…` | `slackUserId` |

### 4) 설정

`~/.cy-agent/config.json`:

```json
{
  "slackBotToken": "xoxb-...",
  "slackAppToken": "xapp-...",
  "slackUserId": "U0123ABCDE",
  "connectors": {
    "slack": { "mode": "api", "userToken": "xoxp-..." }
  }
}
```

토큰을 파일에 두기 싫다면 환경변수 `CY_AGENT_SLACK_USER_TOKEN`으로 줄 수도 있습니다(파일보다 우선합니다). 다만 데몬은 launchd로 뜨기 때문에 launchd 잡 환경에 넣어야 합니다. 보통은 `config.json`(권한 600)에 두는 쪽이 간단합니다.

### 5) 반영·확인

```bash
./ops/install.sh     # 또는: launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
grep -E '\[connectors\] Slack|\[slack-ingest\]|Socket Mode' ~/.cy-agent/logs/com.cy-agent.daemon.log | tail
```

정상이라면 이렇게 나옵니다.

```
[connectors] Slack: api · Slack Web API (사용자 토큰)
[cy-agent] Slack Socket Mode 연결
[slack-ingest] {"calls":…,"messages":…, …}     ← 5분마다(설정 slackIngestIntervalMin)
```

- `Slack: api (준비 안 됨) · userToken(xoxp-…)이 없어요`가 보이면 토큰 키 이름과 위치를 확인하세요.
- `[slack-ingest]`의 `errors`가 계속 0보다 크거나 메시지가 0개라면 토큰을 직접 확인해 보세요. 응답에 `"ok": true`가 있고, `x-oauth-scopes` 헤더에 위 10개 스코프가 다 있어야 합니다.

  ```bash
  curl -s -D - -H "Authorization: Bearer xoxp-..." https://slack.com/api/auth.test | grep -iE 'x-oauth-scopes|"ok"'
  ```

  - 스코프가 모자라면(`missing_scope`) **OAuth & Permissions → User Token Scopes**를 확인한 뒤 **Reinstall to Workspace**를 누르세요(토큰이 바뀔 수 있으니 다시 복사해야 합니다).
  - `invalid_auth` / `token_revoked`라면 재설치해서 토큰을 다시 발급받으세요.
  - 호출별 오류 원문을 보려면 데몬을 `CY_AGENT_DEBUG=1`로 띄웁니다(`cd agent && CY_AGENT_DEBUG=1 npm start`. launchd 잡은 먼저 `launchctl bootout gui/$(id -u)/com.cy-agent.daemon`으로 내려 두세요).

### 6) (선택) 깊은 백필

처음 한 번, 과거 대화를 크게 모으고 싶다면 이렇게 합니다.

```bash
cd agent
node src/cli.ts kg crawl                 # 대화·스레드·채널 기록 (Ctrl+C로 멈추면 받은 것까지 저장)
node src/cli.ts kg crawl --no-channels   # 채널 기록은 건너뛰기
node src/cli.ts kg crawl --rate 30       # 분당 호출 상한(기본 60). 레이트리밋이 잦으면 낮춘다
```

slack이 `api`가 아니면 "Slack 수집이 꺼져 있어요"라는 메시지와 함께 끝납니다.

### api 모드가 하는 일과 안 하는 일

- 부르는 Web API는 `auth.test` · `users.conversations` · `conversations.history` · `conversations.replies` · `conversations.info` · `search.messages` · `users.info`입니다. 이 목록 밖의 메서드(쓰기 메서드 포함)는 코드에서 거부합니다(`agent/src/ingest/slack-api.ts`).
- 사용자 토큰은 내가 볼 수 있는 것만 읽습니다. 내가 들어가 있지 않은 비공개 채널이나 남의 DM은 볼 수 없습니다.
- 봇 DM·버튼·캔버스는 봇 토큰으로 따로 돌아갑니다(위 표 참고).

---

## (b) 대안: mcp 모드, Slack MCP 서버

로컬에 모아 두기보다 필요할 때 모델이 직접 읽게 하고 싶거나, 이미 Slack MCP 서버를 쓰고 있다면 이쪽을 고르세요.

### 프리셋 `slack-mcp-server`: [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)

`xoxp` 사용자 토큰을 지원하고, 메시지 게시 도구(`conversations_add_message`)는 기본으로 꺼져 있습니다(`SLACK_MCP_ADD_MESSAGE_TOOL`을 주지 않으면 등록되지 않습니다). 위 (a)에서 만든 앱의 **User OAuth Token**을 그대로 쓰면 됩니다. 읽기 도구에 필요한 스코프는 (a)의 사용자 스코프로 충분합니다(이 서버 문서에는 쓰기용 `chat:write`·`im:write` 등도 나열돼 있지만, 읽기만 할 거라면 필요 없습니다).

```bash
claude mcp add --scope user -e SLACK_MCP_XOXP_TOKEN=xoxp-... --transport stdio slack \
  -- npx -y slack-mcp-server@latest --transport stdio
claude mcp list      # slack: ✔ Connected
```

```json
{ "connectors": { "slack": { "mode": "mcp", "preset": "slack-mcp-server" } } }
```

프리셋이 매핑하는 도구(출처: 저장소 README·`docs/03-configuration-and-usage.md`):

| 역할 | 도구 |
|---|---|
| search | `conversations_search_messages` |
| history | `conversations_history` |
| replies | `conversations_replies` |
| channels | `channels_list` |
| users | `users_search` |

다른 이름으로 등록했다면 `"server": "<그 이름>"`을 더해 주세요.

### Slack 공식 MCP 서버: 직접 채우기

Slack이 운영하는 원격 MCP 서버(`https://mcp.slack.com/mcp`, [문서](https://docs.slack.dev/ai/slack-mcp-server))도 있습니다. 다만 이런 제약이 있습니다.

- 클라이언트가 **등록된 Slack 앱(고정 app ID, 디렉터리 공개 또는 내부 앱)** 을 통해 confidential OAuth(client_id·client_secret)로 붙어야 하고, 동적 클라이언트 등록(DCR)은 지원하지 않습니다. 워크스페이스 관리자 승인도 거쳐야 합니다. Claude Code는 공식 파트너 클라이언트로 나와 있지만, 연결 단계는 문서에 없습니다.
- 공식 문서에 **도구 이름이 다 나와 있지 않습니다**(파일 업로드 도구 두 개만 이름이 나옵니다).

그래서 cy-agent에는 프리셋이 없습니다. 연결에 성공했다면 `claude` → `/mcp` → 서버 → 도구 목록에서 이름을 확인하고 직접 매핑하세요.

```json
{
  "connectors": {
    "slack": {
      "mode": "mcp",
      "server": "slack-official",
      "tools": { "search": "<검색 도구 이름>", "history": "<채널 기록 도구 이름>", "replies": "<스레드 도구 이름>" }
    }
  }
}
```

`tools`를 비워 두면 그 서버 전체가 허용 목록에 들어가고, 가드가 이름에 get·list·search·read 같은 읽기 단어가 있으면서 쓰기 단어가 없는 도구만 통과시킵니다.

### mcp 모드의 차이

- 로컬 수집이 없으니 "답하지 않은 DM·멘션" 확정 목록과 지식그래프의 Slack 부분이 비게 됩니다. 브리핑마다 모델이 검색해서 판단하므로 덜 결정적이고, 매번 토큰 비용이 듭니다.
- `node src/cli.ts kg crawl`은 동작하지 않습니다.
