# 이슈 트래커 연결 (GitHub · Jira · Linear)

이슈도 로컬에 모아 두지 않습니다. 브리핑이나 채팅 때 모델이 "나에게 할당된 열린 이슈와 리뷰 요청"을 매핑된 읽기 도구로 봅니다.

| 모드 | 어떻게 읽나 |
|---|---|
| `mcp` | Claude Code에 등록한 이슈 트래커 MCP(Claude Code 뇌일 때만 읽힙니다) |
| `off` | 브리핑에서 이슈 단계가 빠집니다 |

역할은 `search`(이슈 검색) · `list`(이슈 목록) · `read`(이슈 하나) · `searchPrs`(PR 검색) · `me`(내 계정)입니다. 쓰기 도구(생성·댓글·상태 변경 등)는 매핑에 적어도 허용되지 않습니다.

> 이슈 커넥터는 한 번에 하나만 쓸 수 있습니다(`connectors.issues` 하나).

## 프리셋 `github`: [github/github-mcp-server](https://github.com/github/github-mcp-server) (공식)

### 1) 토큰 만들기

GitHub → Settings → Developer settings → Personal access tokens에서 만듭니다. 읽기 권한만 있으면 됩니다.
- Fine-grained 토큰: 볼 저장소를 고르고, Repository permissions에서 **Issues: Read-only**, **Pull requests: Read-only**, **Metadata: Read-only**를 줍니다.
- 조직 저장소는 조직이 fine-grained 토큰을 승인해야 할 수도 있습니다.

### 2) 등록: 원격 서버(추천, 설치할 것 없음)

공식 Claude 설치 가이드([docs/installation-guides/install-claude.md](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md))는 Claude Code 2.1.1 이상에서 `add-json`을 쓰라고 안내합니다. 여기에 사용자 범위와 읽기 전용 URL(`/readonly`, [docs/remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md))을 더하면 이렇게 됩니다.

```bash
claude mcp add-json --scope user github \
  '{"type":"http","url":"https://api.githubcopilot.com/mcp/readonly","headers":{"Authorization":"Bearer <GitHub PAT>"}}'
```

같은 내용을 `claude mcp add`로 쓰면 다음과 같습니다(가이드의 2.1.0 이하용 형식).

```bash
claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp/readonly \
  -H "Authorization: Bearer <GitHub PAT>"
```

읽기 전용은 헤더 `"X-MCP-Readonly": "true"`로도 켤 수 있습니다([docs/server-configuration.md](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)).
원격 서버의 OAuth 로그인은 "호스트 앱이 GitHub App/OAuth App을 설정해야 한다"고만 나와 있고 Claude Code에서 되는지는 확인되지 않아서, 여기서는 PAT 방식만 적었습니다.

### 2') 등록: 로컬 Docker

```bash
claude mcp add --scope user -e GITHUB_PERSONAL_ACCESS_TOKEN=<GitHub PAT> --transport stdio github \
  -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_READ_ONLY=1 ghcr.io/github/github-mcp-server
```

(`GITHUB_READ_ONLY=1`은 README의 Docker 읽기 전용 예시입니다. 바이너리로 돌린다면 `--read-only`를 쓰면 됩니다.)

### 3) 설정

```json
{ "connectors": { "issues": { "mode": "mcp", "preset": "github" } } }
```

매핑(README에서 확인):

| 역할 | 도구 |
|---|---|
| search | `search_issues` |
| list | `list_issues` |
| read | `issue_read` |
| searchPrs | `search_pull_requests` |
| me | `get_me` |

## Jira·Confluence: Atlassian Rovo MCP 서버(공식 원격), 직접 채우기

출처: [Atlassian 지원: Getting started with the Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/) (2026-10)

```bash
claude mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v2/mcp
claude          # 열고 /mcp → atlassian → 브라우저에서 Atlassian 로그인·사이트 허용
```

공식 문서에 도구 이름 전체 목록이 없어서(검색 도구 몇 개만 나옵니다) 프리셋은 만들지 못했습니다. 대신 두 가지 방법이 있습니다.

1. 매핑 없이 쓰기: 서버 전체를 허용하고, 가드가 읽기 이름만 통과시킵니다.
   ```json
   { "connectors": { "issues": { "mode": "mcp", "server": "atlassian" } } }
   ```
   가드는 이름을 단어 단위로 나눠 보고(camelCase도 나눕니다), get·list·search·read·fetch·lookup 같은 단어가 있으면서 쓰기 단어(create·update·add·transition·comment …)가 없을 때만 허용합니다.
2. 직접 채우기: `/mcp`에서 도구 이름을 확인해 적습니다.
   ```json
   { "connectors": { "issues": { "mode": "mcp", "server": "atlassian", "tools": { "search": "<JQL 검색 도구>", "read": "<이슈 하나 읽기 도구>" } } } }
   ```

참고로 이 서버를 쓰면 조직의 Rovo 크레딧이 소모될 수 있습니다(문서에 언급돼 있습니다). 조직 관리자가 MCP 접근을 막아 뒀을 수도 있습니다.

## Linear(공식 원격): 직접 채우기

출처: [Linear Docs: MCP server](https://linear.app/docs/mcp) (2026-10)

```bash
claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp/readonly
claude          # /mcp → linear → 브라우저 로그인
```

읽기 전용 엔드포인트(`/mcp/readonly`)는 문서에 있지만 도구 이름은 나와 있지 않습니다. 그래서 위 Atlassian처럼 `"server": "linear"`만 두거나, `/mcp`에서 확인해 `tools`를 채우면 됩니다.

```json
{ "connectors": { "issues": { "mode": "mcp", "server": "linear" } } }
```
