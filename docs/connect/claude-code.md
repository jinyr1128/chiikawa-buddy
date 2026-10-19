# Claude Code 준비: 로그인과 MCP 서버 등록

Claude Code는 시사의 뇌 중 하나입니다(기본값 `brain.provider: "claude-code"`). 코드 고치기, 워크트리, 백그라운드 에이전트, 작업 세션, 자동 머지는 뇌를 다른 것으로 골라도 오직 Claude Code로만 돌아갑니다. 대화와 브리핑만 쓰실 거라면 Claude Code 없이 Codex·Gemini·OpenAI·Claude API 키로도 충분합니다([brain.md](brain.md) 참고).

데몬은 Claude Agent SDK를 씁니다. Agent SDK는 이 맥에 깔린 Claude Code 실행 파일을 그대로 띄우는 라이브러리라서, Claude Code를 설치하고 한 번 로그인해 두면 따로 API 키를 넣지 않아도 됩니다. MCP 서버도 Claude Code에 등록한 것(`~/.claude.json`)을 그대로 씁니다. 설치 마법사의 「뇌 고르기」는 로그인된 Claude Code를 찾으면 「찾았어요 ✓」로 보여 줍니다.

> 확인한 출처(2026-10): [설치](https://code.claude.com/docs/en/setup) · [MCP](https://code.claude.com/docs/en/mcp) · [Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview)

## 1. 설치

공식 문서는 네이티브 설치를 권합니다(자동 업데이트도 됩니다).

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

다른 방법도 공식 문서에 나와 있습니다.

```bash
brew install --cask claude-code              # Homebrew (자동 업데이트 안 됨 → brew upgrade claude-code)
npm install -g @anthropic-ai/claude-code     # npm (Node 22+). sudo 로 깔지 말 것
```

새 터미널 창을 열어서 확인해 보세요.

```bash
claude --version     # 예: 2.1.x (Claude Code)
claude doctor        # 설치·설정 진단(세션을 열지 않음)
```

`claude: command not found`가 나오면 설치 경로(`~/.local/bin`)가 PATH에 없는 것입니다. 참고로 `ops/install.sh`가 만드는 launchd 잡의 PATH에는 `~/.local/bin`·`/opt/homebrew/bin`·`/usr/local/bin`이 들어 있습니다.

## 2. 로그인 (한 번)

```bash
claude
```

브라우저가 열리면 로그인합니다. Claude Code는 Pro·Max·Team·Enterprise 또는 Console 계정이 있어야 쓸 수 있습니다(무료 플랜 제외). 로그인이 끝나면 `/exit`로 나와도 됩니다.

### Agent SDK가 이 로그인을 쓰는 방식

- 데몬(`agent/`)은 `@anthropic-ai/claude-agent-sdk`의 `query()`를 부르고, SDK가 Claude Code 실행 파일을 하위 프로세스로 띄웁니다. 그 프로세스가 위에서 로그인한 자격 증명을 그대로 쓰기 때문에 API 키는 필요 없습니다.
- Claude Code 자체는 `ANTHROPIC_API_KEY` 환경변수가 있으면 그 키를 씁니다(데몬에서 보이게 하려면 launchd 잡 환경에 넣어야 합니다). Claude Code 없이 Claude API 키로 대화·브리핑만 하려면 `brain.provider: "anthropic"` + `brain.anthropicApiKey`(또는 `CY_AGENT_ANTHROPIC_API_KEY`)를 쓰면 됩니다. 자세한 건 [brain.md](brain.md)에 있습니다.
- 참고로 Agent SDK 문서는 "Agent SDK로 만든 **제품을 남에게 제공할 때** claude.ai 로그인을 쓰지 말고 API 키를 쓰라"고 안내합니다. cy-agent는 내 맥에서 나 혼자 쓰는 개인 도구라 내 로그인으로 돌리지만, 다른 사람에게 배포하거나 호스팅할 거라면 API 키 방식으로 바꿔야 합니다.

## 3. MCP 서버 등록 (`claude mcp add`)

커넥터를 `mode: "mcp"`로 쓸 때만 필요합니다. 등록할 때는 꼭 `--scope user`를 붙여 주세요. 데몬은 사용자 범위 서버(`~/.claude.json`의 최상위 `mcpServers`)만 봅니다. 기본값인 `local`로 등록하면 그 폴더에서만 보여서 데몬이 찾지 못합니다.

### 원격(HTTP) 서버

```bash
claude mcp add --scope user --transport http <이름> <URL>

# 예: 헤더로 토큰을 넘기는 서버
claude mcp add --scope user --transport http my-api https://mcp.example.com/mcp \
  --header "Authorization: Bearer <토큰>"
```

OAuth 로그인을 쓰는 서버(Atlassian·Linear 등)는 등록한 뒤 `claude`를 열고 `/mcp` → 서버 선택 → 브라우저에서 로그인하면 됩니다. 셸에서 `claude mcp login <이름>`으로 해도 됩니다.

### 로컬(stdio) 서버

```bash
claude mcp add --scope user -e KEY=value --transport stdio <이름> -- <명령> [인자...]

# 예
claude mcp add --scope user -e SLACK_MCP_XOXP_TOKEN=xoxp-... --transport stdio slack \
  -- npx -y slack-mcp-server@latest --transport stdio
```

- `--` 뒤는 서버 실행 명령 그대로입니다. `--`를 빼면 서버 쪽 옵션(`--transport stdio`, `--read-only` 등)을 Claude Code가 자기 옵션으로 읽어 버립니다.
- `-e`(`--env`)는 `KEY=value`를 여러 개 받습니다. **`-e` 바로 뒤에 서버 이름을 두면 이름까지 KEY=value로 읽혀서 실패**하니, 위처럼 `-e … --transport stdio <이름>` 순서로 쓰세요.
- 토큰이 `~/.claude.json`에 평문으로 저장된다는 점도 기억해 두세요.

### 확인·삭제

```bash
claude mcp list            # 상태: ✔ Connected / ! Needs authentication / ✘ Failed to connect
claude mcp get <이름>       # 설정·범위 확인 (Scope: User 인지 볼 것)
claude mcp remove <이름>    # 삭제(원격 서버면 저장된 OAuth 토큰도 지움)
```

도구 이름을 직접 확인하려면 `claude`를 열고 `/mcp` → 서버 → 도구 목록을 보면 됩니다. cy-agent에서 도구 이름은 `mcp__<서버 이름>__<도구>` 꼴이 됩니다.

## 4. 이름 맞추기: 가장 흔한 실수

`claude mcp add`로 준 **서버 이름**과 `~/.cy-agent/config.json`의 `connectors.<기능>.server`는 **글자 그대로 같아야** 합니다.

```bash
claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp/readonly \
  --header "Authorization: Bearer <GitHub PAT>"
```

```json
{ "connectors": { "issues": { "mode": "mcp", "preset": "github", "server": "github" } } }
```

프리셋(`preset`)에는 기본 서버 이름이 정해져 있어서(`connectors.ts`의 `PRESETS`), 그 이름으로 등록했다면 `server`는 생략해도 됩니다. 다른 이름으로 등록했다면 `server`에 그 이름을 적어 주세요.

데몬을 다시 띄우면(`./ops/install.sh` 재실행 또는 `launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`) 로그 첫머리에 확인 줄이 찍힙니다.

```bash
grep '\[connectors\]' ~/.cy-agent/logs/com.cy-agent.daemon.log | tail -5
# [connectors] 이슈: mcp · MCP github (github)
# [connectors] 메일: mcp (준비 안 됨) · MCP 서버 "gmail"가 Claude Code에 등록돼 있지 않아요
```

"등록돼 있지 않아요"가 보이면 `claude mcp get <이름>`으로 이름과 범위(User)를 확인하세요.

## 안전장치

어떤 MCP를 붙여도 브리핑·채팅 모델은 읽기 도구만 씁니다. 매핑한 역할의 도구만 허용 목록에 넣고, 이름에 send·create·update·delete 같은 쓰기 단어가 든 도구는 PreToolUse 훅이 막습니다(`agent/src/guard.ts`, `connectors.ts`). 그래도 MCP 서버 쪽에 읽기 전용 옵션(`--read-only`, `/readonly` 등)이 있다면 켜 두기를 권합니다.
