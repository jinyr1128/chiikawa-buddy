# 더 붙일 수 있는 MCP

cy-agent는 Claude Code에 등록된 MCP 서버로 글을 읽습니다. 여기 적은 서버들은 2026년 10월에 각 회사 공식 문서나 README에서 직접 확인한 것입니다. 문서에 도구 이름이 나와 있지 않은 경우에는 지어내지 않고 "문서에 이름 없음"이라고 적었습니다.

등록 명령은 전부 `claude mcp add --scope user` 꼴로 맞춰 두었습니다. 공식 예시에 `--scope user`가 없으면 붙였고, 공식 문서에 Claude Code 명령 자체가 없으면 문서의 주소로 만든 초안이라고 따로 밝혔습니다.

아래 서버들은 대부분 쓰기 도구도 갖고 있습니다. cy-agent는 도구 이름에 만들기·고치기·지우기·보내기 같은 말이 들어 있으면 호출을 막습니다(`agent/src/guard.ts`). 하지만 이름만 보고 막는 방식이라, 이름은 얌전한데 실제로는 뭔가를 바꾸는 도구는 빠져나갈 수 있습니다. 그런 도구는 항목마다 따로 적어 두었습니다.

그리고 여기 있는 서버를 등록한다고 해서 브리핑의 Slack·캘린더·메일·이슈 자리에 저절로 들어가지는 않습니다.

시사는 Claude Code에 등록된 서버를 전부 쓰지 않습니다. 브리핑과 채팅은 커넥터(`connectors`)로 연결한 서버만 쓰고, 다른 일에 쓰려고 등록해 둔 서버나 claude.ai 커넥터는 읽기 도구여도 막습니다. 여기 있는 서버를 채팅에서 쓰려면 `~/.cy-agent/config.json`에 이름을 적어 주세요.

```json
{ "allowMcp": ["notion"] }
```

---

## 이미 연결 가능

| 무엇 | 어떻게 | 문서 |
|---|---|---|
| Slack | `api`가 추천. MCP는 `slack-mcp-server`. 공식 Slack 원격 MCP는 프리셋 없음 | [slack.md](slack.md) |
| 캘린더 | ICS `api`가 추천. `google-calendar`, `ms-365` | [calendar.md](calendar.md) |
| 메일 | `gmail`(보관된 서버), `ms-365` | [mail.md](mail.md) |
| 이슈 | GitHub 공식 MCP 읽기 전용. Atlassian Rovo·Linear는 도구 이름이 문서에 없어 프리셋 없음 | [issues.md](issues.md) |
| 오늘 할 일 | 이 맥의 로컬 표. MCP 없음 | 없음 |
| 뇌 | 기본은 Claude Code 로그인. `brain.provider`로 codex·gemini·openai·anthropic·local | [brain.md](brain.md) |

---

## Notion

노션에 적어 둔 페이지를 찾아서 읽을 수 있습니다. 페이지를 만들고 고치는 도구도 있지만, 그건 cy-agent가 막습니다.

```bash
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
claude          # /mcp → notion → 브라우저 로그인
```

`--scope user`는 공식 예시에 없어서 붙였습니다. 출처: [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)

읽기 도구(일부): `notion-search`, `notion-fetch`, `notion-get-self`, `notion-get-comments`, `notion-get-teams`, `notion-query-data-sources`, `notion-query-meeting-notes`.

막히는 쓰기 도구: `notion-create-pages`, `notion-update-page`, `notion-create-comment`, `notion-move-pages`.

출처: [Supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools) (2026-10)

주의: 워크스페이스 관리자가 MCP 연결을 막아 둘 수 있습니다. 검색이 AI 검색으로 동작하는지는 요금제에 따라 다릅니다.

## Google Drive

드라이브에서 파일을 찾고, 그 안에 적힌 글을 읽을 수 있습니다. 파일을 만드는 도구도 있지만 막힙니다.

```bash
claude mcp add --scope user --transport http drive https://drivemcp.googleapis.com/mcp/v1
```

이 명령은 초안입니다. Google 문서에는 웹 Claude용 커스텀 커넥터 안내만 있고 Claude Code 명령은 없어서, 문서에 나온 주소와 HTTP 방식으로 만들었습니다. 쓰기 전에 Google Cloud 프로젝트에서 Drive API와 Drive MCP API를 켜고 OAuth 클라이언트를 만들어야 합니다. 개발자 미리보기라서 일반 계정에서는 바로 안 될 수도 있습니다.

읽기 도구: `search_files`, `read_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`.

막히는 쓰기 도구: `create_file`, `copy_file`. `download_file_content`는 파일 원본을 내려받는 도구로 문서에 나와 있습니다.

출처: [Configure the Drive MCP server](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server) (문서 갱신 2026-09-18, 2026-10 확인)

주의: 파일 안에 숨은 지시문이 있을 수 있다고 Google이 경고합니다. 모르는 파일을 통째로 읽히지 않는 편이 안전합니다.

## Figma

피그마 링크를 주면 화면 모양, 글자, 색을 읽어 올 수 있습니다. 파일을 만들고 그림을 그리는 도구도 있습니다.

```bash
claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp
claude          # /mcp → figma → Allow Access
```

이 명령은 Figma 문서의 Claude Code 수동 설치와 같습니다. 출처: [Set up the remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)

읽기 도구(일부): `get_design_context`, `get_metadata`, `get_screenshot`, `get_variable_defs`, `get_figjam`, `whoami`.

막히는 쓰기 도구: `create_new_file`, `upload_assets`. `use_figma`, `generate_figma_design`, `generate_diagram`은 문서를 고치거나 새로 만드는 도구인데 이름에 만들기·고치기 같은 말이 없어서, 이름만 보는 가드로는 막지 못할 수 있습니다.

출처: [Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) (2026-10)

주의: Figma가 허용한 클라이언트만 원격 서버에 붙을 수 있습니다. Claude Code는 그 목록에 들어 있습니다.

## Todoist

할 일 목록을 찾아볼 수 있습니다. README에 따르면 할 일을 고칠 수도 있는데, 쓰기처럼 보이는 이름은 cy-agent가 막습니다.

```bash
claude mcp add --scope user --transport http todoist https://ai.todoist.net/mcp
claude          # /mcp → todoist → 브라우저 로그인
```

`--scope user`는 붙인 것입니다. 출처: [Doist/todoist-mcp README](https://github.com/Doist/todoist-mcp/blob/main/README.md)

README에 이름이 있는 도구: `search`, `fetch`.

그 밖 도구 이름: **문서에 이름 없음.** README는 `src/tools` 폴더를 보라고만 하고, 등록된 이름을 나열하지 않습니다. 파일 이름을 도구 이름인 것처럼 적지는 않았습니다.

호스트 주소가 `todoist.com`이 아니라 `https://ai.todoist.net/mcp`라는 점에 주의하세요.

## Box

회사 Box에 있는 파일을 찾고 내용을 읽을 수 있습니다. 업로드·복사·댓글 도구도 있지만 막힙니다.

```bash
claude mcp add --scope user --transport http box https://mcp.box.com
claude          # /mcp 로 연결 확인
```

Box 문서의 예시는 `claude mcp add box --transport http https://mcp.box.com`입니다. 위 명령은 같은 주소에 사용자 범위를 붙인 초안입니다.

읽기 도구(일부): `who_am_i`, `get_file_content`, `get_file_details`, `list_folder_content_by_folder_id`, `search_files_keyword`, `search_folders_by_name`, `list_file_comments`.

막히는 쓰기 도구: `upload_file`, `create_folder`, `copy_file`, `create_file_comment`.

출처: [Available tools](https://developer.box.com/guides/box-mcp/tools), [Box MCP for Claude Code](https://developer.box.com/guides/box-mcp/integrations/claude-code) (2026-10)

주의: Box 엔터프라이즈 계정이어야 하고, 관리자가 MCP를 켜 둬야 합니다. 개인 Box에서는 안 될 수 있습니다.

## Miro

보드를 찾고, 보드 위의 글과 그림을 읽을 수 있습니다. 보드를 만들고 고치는 도구도 있습니다.

```bash
claude mcp add --scope user --transport http miro https://mcp.miro.com
claude          # /mcp 로 로그인
```

`--scope user`는 붙인 것입니다. 출처: [Miro MCP](https://developers.miro.com/docs/miro-mcp)

읽기 도구(일부): `board_search_boards`, `canvas_read_as_svg`, `canvas_search`, `comment_list_comments`, `prototype_read`, `image_get_data`.

막히는 쓰기 도구: `board_create`, `canvas_create_from_svg`, `canvas_update_from_svg`, `comment_reply`.

예전 이름인 `board_list_items`, `context_*`, `layout_*`, `diagram_*`, `doc_*`는 제거됐다고 문서에 나와 있어서 넣지 않았습니다.

출처: [Miro MCP Server Tools](https://developers.miro.com/docs/miro-mcp-tools) (2026-10)

주의: 호출 한도가 있습니다. 보드 주소가 있어야 내용을 읽기 쉽습니다.

## Asana

나에게 맡겨진 일과 프로젝트 상태를 읽어 올 수 있습니다. 일을 만들고 지우는 도구도 있지만 막힙니다.

```bash
claude mcp add --scope user --transport http \
  --client-id YOUR_CLIENT_ID \
  --client-secret \
  --callback-port 8080 \
  asana https://mcp.asana.com/v2/mcp
```

`--client-secret` 뒤에 값을 붙이지 않으면 입력을 가린 채로 비밀번호를 묻습니다. 공식 예시에는 `--scope user`가 없습니다. 리다이렉트 주소는 `http://localhost:8080/callback`으로 앱에 등록해야 합니다. 출처: [Connecting Coding Clients to Asana's V2 server](https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server)

읽기 도구(일부): `search_objects`, `get_my_tasks`, `get_tasks`, `get_task`, `search_tasks`, `get_projects`, `get_status_overview`, `get_me`.

막히는 쓰기 도구: `create_tasks`, `update_tasks`, `delete_task`, `add_comment`, `create_project`.

출처: [MCP Tools Reference](https://developers.asana.com/docs/mcp-tools-reference) (2026-10)

주의: V2는 앱을 직접 만들어야 하고, 동적 클라이언트 등록은 지원하지 않습니다. `search_tasks`는 프리미엄 계정용이라고 문서에 나와 있습니다.

## monday.com

보드, 문서, 댓글을 찾아서 읽을 수 있습니다. 보드와 아이템을 만드는 도구가 많습니다.

```bash
claude mcp add --scope user --transport http monday https://mcp.monday.com/mcp
```

이 명령은 초안입니다. 공식 문서는 주소 `https://mcp.monday.com/mcp`와 JSON 설정만 보여 주고, `claude mcp add` 예시는 없습니다. 예전 주소 `https://mcp.monday.com/sse`는 쓰지 말라고 안내하고 있습니다. 출처: [Compatible MCP clients](https://developer.monday.com/api-reference/docs/compatible-mcp-clients)

읽기 도구(일부): `search`, `get_board_info`, `get_board_items_page`, `list_workspaces`, `read_docs`, `get_updates`, `get_user_context`, `get_notetaker_meetings`.

막히는 쓰기 도구: `create_board`, `create_item`, `create_update`, `change_item_column_values`.

`all_monday_api`는 문서에 따르면 아무 GraphQL이나 실행하는 도구라서 고치는 호출도 할 수 있습니다. 이름에 쓰기 단어가 없으니 이름만 보는 가드로는 막지 못할 수 있습니다.

출처: [Platform MCP tools](https://developer.monday.com/api-reference/docs/platform-mcp-tools) (2026-10)

## Airtable

어떤 표가 있는지 찾고, 칸에 적힌 내용을 볼 수 있습니다. 줄을 만들고 지우는 도구도 있지만 막힙니다.

```bash
claude mcp add --scope user --transport http airtable https://mcp.airtable.com/mcp
claude          # /mcp → airtable → 브라우저 로그인
```

공식 도움말의 명령에 `--scope user`를 더했습니다. 출처: [Using the Airtable MCP server](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server)

읽기 도구(일부): `list_workspaces`, `list_bases`, `search_bases`, `list_tables_for_base`, `get_table_schema`, `list_records_for_table`, `search_records`, `list_automations`.

막히는 쓰기 도구: `create_records_for_table`, `update_records_for_table`, `delete_records_for_table`, `create_base`, `create_table`.

출처: [Tools Reference](https://airtable.com/developers/agents/mcp/tools) (2026-10)

주의: 내가 Airtable에서 볼 수 있는 표만 읽힙니다. 도구 이름은 바뀔 수 있다고 도움말에 나와 있습니다.

## Dropbox

파일 이름을 찾고, 문서 안의 글을 읽을 수 있습니다. 파일을 만들고 옮기고 지우는 도구도 있지만 막힙니다.

```bash
claude mcp add --scope user --transport http DropboxMCP https://mcp.dropbox.com/mcp
```

공식 예시는 `--scope user` 없이 `claude mcp add --transport http DropboxMCP https://mcp.dropbox.com/mcp`입니다. 출처: [How to connect the Dropbox remote MCP server](https://help.dropbox.com/integrations/connect-dropbox-mcp-server) (2026-09-30 갱신, 2026-10 확인)

도움말에 적힌 읽기 이름: `ListFolder`, `GetFileMetadata`, `GetFileContent`, `GetUsageAndQuota`, `Search`, `WhoAmI`, `ListSharedLinks`, `GetSharedLinkMetadata`, `ListFileRevisions`, `GetMarkdown`.

막히는 쓰기 도구: `CreateFolder`, `CreateFile`, `Copy`, `Move`, `Delete`, `CreateSharedLink`.

Dropbox Sign·Paper로 할 수 있는 일은 설명만 있고, 그 도구 이름은 **문서에 이름 없음**입니다.

아직 베타입니다. Claude Code는 지원 클라이언트 목록에 들어 있습니다.

## Canva

만들어 둔 디자인을 찾고, 그 안에 적힌 글을 볼 수 있습니다. 디자인을 만들고 고치고 내보내는 도구도 있습니다.

```bash
claude mcp add --scope user --transport http canva https://mcp.canva.com/mcp
```

이것도 초안입니다. 개발자 문서는 주소 `https://mcp.canva.com/mcp`를 알려 주고, 개인 비서 연결은 도움말 센터를 보라고 안내합니다. 그 페이지에도 `claude mcp add` 예시는 없습니다.

읽기 도구(일부): `search-designs`, `get-design`, `get-design-pages`, `get-design-content`, `get-presenter-notes`, `list-comments`, `get-assets`.

막히는 쓰기 도구: `generate-design`, `create-design`, `comment-on-design`, `upload-asset-from-url`. `export-design`, `perform-editing-operations`, `commit-editing-transaction`은 내보내거나 고치는 도구인데 이름에 만들기·고치기 같은 말이 없어서, 이름만 보는 가드로는 막지 못할 수 있습니다.

출처: [MCP tools and rate limits](https://www.canva.dev/docs/mcp/tools/), [About Canva MCP](https://www.canva.dev/docs/mcp/) (2026-10)

주의: 캔바 앱을 만드는 개발자용 서버(`canva-dev`, `@canva/cli mcp`)는 별개입니다. 그 서버의 도구 이름은 여기 적지 않았습니다.

## Sentry

앱이 어디서 고장 났는지, 어디가 느린지 기록을 검색해 볼 수 있습니다.

```bash
claude mcp add --scope user --transport http sentry https://mcp.sentry.dev/mcp
```

공식 Claude Code 예시는 조직·프로젝트로 범위를 좁힙니다. `--scope user`는 더한 것입니다.

```bash
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp/{organizationSlug}/{projectSlug}
```

출처: [Sentry MCP](https://docs.sentry.io/product/sentry-mcp/)

README에 이름이 있는 검색 도구: `search_errors`, `search_traces`, `search_logs`, `search_issues`.

그 밖 도구 이름: **문서에 이름 없음.** 제품 문서의 연결 페이지에는 도구 목록이 없고, README도 "등"이라고만 적고 있습니다.

출처: [getsentry/sentry-mcp README](https://github.com/getsentry/sentry-mcp/blob/main/README.md) (2026-10)

주의: 개발자가 에러를 볼 때 쓰는 서버입니다. README에 따르면 검색 도구 일부는 로컬 서버에서 쓸 때 별도 LLM 키가 있어야 동작합니다. 원격 주소는 OAuth로 로그인합니다.

## Stripe

결제 기록과 고객 정보를 조회하는 질문을 할 수 있습니다. 돈을 보내거나 API로 데이터를 쓰는 도구도 있습니다.

```bash
claude mcp add --scope user --transport http stripe https://mcp.stripe.com/
claude          # /mcp → stripe → 브라우저 로그인
```

공식 명령은 `--scope user` 없이 `claude mcp add --transport http stripe https://mcp.stripe.com/`입니다.

읽기 도구: `stripe_api_search`, `stripe_api_details`, `stripe_api_read`, `get_stripe_account_info`, `search_stripe_documentation`, `get_balance_summary`.

막히는 쓰기 도구: `stripe_api_write`, `send_money`. `convert_currency`, `transfer_money`는 돈을 옮기는 도구인데 이름에 보내기·쓰기 같은 말이 없어서, 이름만 보는 가드로는 막지 못할 수 있습니다. 결제 서버는 꼭 필요할 때만 붙이세요.

출처: [Stripe MCP](https://docs.stripe.com/mcp) (2026-10)

주의: 문서에 따르면 2026-10-31부터는 에이전트 표시가 없는 비밀 키를 더 이상 받지 않습니다. OAuth 쪽이 더 간단합니다.

---

## 일부러 뺀 것

출처가 공식 문서가 아니거나, 공식 문서에 도구 이름이 없어서 목록에 넣지 않은 것들입니다.

| 이름 | 이유 |
|---|---|
| ClickUp | 공식 서버와 Claude Code 명령(`https://mcp.clickup.com/mcp`)은 있습니다. 하지만 [Supported Tools](https://developer.clickup.com/docs/mcp-tools)에는 "Search Workspace" 같은 영어 설명만 있고 MCP 도구 식별자는 없습니다. |
| GitLab | [공식 문서](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)에는 `core`, `merge_requests` 같은 묶음 이름만 있고 개별 도구 이름은 없습니다. |
| HubSpot | 이번 조사에서 HubSpot 공식 도구 이름 목록을 확인하지 못했습니다. 제삼자 안내만 보여서 넣지 않았습니다. |
| Zoom | [시작 문서](https://developers.zoom.us/docs/mcp/)에 서버 주소는 있지만 도구 이름이 없습니다. |
| Canva Dev MCP | 캔바 앱을 만드는 개발자용입니다. 디자인 읽기 서버와 다른 서버라서 도구 이름을 적지 않았습니다. |
| Dropbox Sign·Paper | 파일 도구는 위에 넣었습니다. 서명·페이퍼 도구 이름은 도움말에 없습니다. |
| Todoist의 `search`·`fetch` 외 | README에 이름이 없습니다. |
| Sentry의 검색 네 개 외 | 제품 문서에 전체 목록이 없습니다. |
| Linear, Atlassian Rovo | 이미 [issues.md](issues.md)에 있습니다. 도구 이름은 그 문서에 적은 대로 아직 없습니다. |
| Slack, 캘린더, 메일, GitHub | 이미 프리셋이 있거나 [slack.md](slack.md)·[calendar.md](calendar.md)·[mail.md](mail.md)·[issues.md](issues.md)에 정리돼 있습니다. |
