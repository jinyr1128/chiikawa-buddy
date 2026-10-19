// 더 붙일 수 있는 MCP 목록. 화면용 데이터만 둔다.
// 도구 이름은 여기 넣지 않는다. 확인한 이름은 docs/connect/more-mcp.md 에만 적는다.
// Slack·캘린더·메일·GitHub 는 이미 프리셋이 있으므로 여기 없다.
export const EXTRA_MCPS = [
  {
    id: "notion",
    title: "Notion",
    kid: "노션에 적어 둔 글을 찾아서 읽을 수 있어요.",
    youCan: "회의 노트나 할 일 페이지를 열어 무슨 내용인지 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developers.notion.com/guides/mcp/mcp-supported-tools", text: "노션 도구 목록" }],
  },
  {
    id: "google-drive",
    title: "Google Drive",
    kid: "구글 드라이브에 있는 파일을 찾아서 읽을 수 있어요.",
    youCan: "문서 이름을 찾고, 그 안에 적힌 글을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server", text: "구글 드라이브 연결 안내" }],
  },
  {
    id: "figma",
    title: "Figma",
    kid: "피그마 그림이 어떻게 생겼는지 볼 수 있어요.",
    youCan: "디자인 링크를 주면 화면 모양과 글자, 색을 읽어 올 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/", text: "피그마 도구 목록" }],
  },
  {
    id: "todoist",
    title: "Todoist",
    kid: "투두이스트에 적어 둔 할 일을 볼 수 있어요.",
    youCan: "오늘 할 일과 프로젝트 이름을 찾아볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://github.com/Doist/todoist-mcp/blob/main/README.md", text: "투두이스트 공식 안내" }],
  },
  {
    id: "box",
    title: "Box",
    kid: "박스에 넣어 둔 파일을 찾아서 읽을 수 있어요.",
    youCan: "회사 파일 이름과 그 안에 적힌 글을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developer.box.com/guides/box-mcp/tools", text: "박스 도구 목록" }],
  },
  {
    id: "miro",
    title: "Miro",
    kid: "미로 보드에 붙여 둔 내용을 읽을 수 있어요.",
    youCan: "보드를 찾고, 그 위에 있는 그림과 글을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developers.miro.com/docs/miro-mcp-tools", text: "미로 도구 목록" }],
  },
  {
    id: "asana",
    title: "Asana",
    kid: "아사나에 있는 할 일을 볼 수 있어요.",
    youCan: "나에게 맡긴 일과 프로젝트 상태를 읽어 올 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developers.asana.com/docs/mcp-tools-reference", text: "아사나 도구 목록" }],
  },
  {
    id: "monday",
    title: "monday.com",
    kid: "먼데이 보드에 적힌 일을 볼 수 있어요.",
    youCan: "보드와 문서, 댓글을 찾아서 읽을 수 있어요.",
    readOnly: true,
    links: [{ href: "https://developer.monday.com/api-reference/docs/platform-mcp-tools", text: "먼데이 도구 목록" }],
  },
  {
    id: "airtable",
    title: "Airtable",
    kid: "에어테이블 표에 있는 줄을 읽을 수 있어요.",
    youCan: "어떤 표가 있는지 찾고, 칸에 적힌 내용을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://airtable.com/developers/agents/mcp/tools", text: "에어테이블 도구 목록" }],
  },
  {
    id: "dropbox",
    title: "Dropbox",
    kid: "드롭박스에 있는 파일을 찾아서 읽을 수 있어요.",
    youCan: "파일 이름을 찾고, 문서 안에 적힌 글을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", text: "드롭박스 연결 안내" }],
  },
  {
    id: "canva",
    title: "Canva",
    kid: "캔바에 만들어 둔 디자인을 찾아서 읽을 수 있어요.",
    youCan: "디자인 이름과 그 안에 적힌 글을 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://www.canva.dev/docs/mcp/tools/", text: "캔바 도구 목록" }],
  },
  {
    id: "sentry",
    title: "Sentry",
    kid: "앱이 어디서 고장 났는지 기록을 볼 수 있어요.",
    youCan: "에러와 느린 구간을 검색해 볼 수 있어요.",
    readOnly: true,
    links: [{ href: "https://docs.sentry.io/product/sentry-mcp/", text: "센트리 연결 안내" }],
  },
  {
    id: "stripe",
    title: "Stripe",
    kid: "스트라이프에 있는 결제 기록을 읽어 볼 수 있어요.",
    youCan: "고객이나 결제 내역을 조회하는 질문을 할 수 있어요.",
    readOnly: true,
    links: [{ href: "https://docs.stripe.com/mcp", text: "스트라이프 도구 목록" }],
  },
];

// MCP 등록 안내가 의미 있는 플랜(코딩 도구가 있는 것)에서만 목록을 보여 준다.
export function extraMcpsForPlan(planId) {
  if (planId === 'tools' || planId === 'code') return EXTRA_MCPS;
  return [];
}
