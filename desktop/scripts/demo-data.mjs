// 녹화용 데모 데이터 — scripts/demo.mjs 가 가짜 데몬을 FAKE_DATA=이 파일 로 띄우면 fake-daemon.mjs 가 읽는다.
// 전부 지어낸 것: 사람·프로젝트·메시지·링크(example.*)는 실제와 상관없다.
// 내보내는 것: projects · todos · origins · autoDone · proposals · briefing · history · rules · meetings
//            today · createRuns · chat · route(데모 전용 /demo/* 경로와 데모 PR 머지)
import { randomUUID } from 'node:crypto';

// 데모 속도(1 = 녹화, 0.25 = --fast). 데몬 쪽 지연(채팅 단계·run 대본·머지)에 곱한다
const PACE = Math.max(0.05, Number(process.env.DEMO_PACE) || 1);
const later = (fn, ms) => setTimeout(fn, Math.round(ms * PACE));

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const HOME = '/Users/demo/work';
const SLACK = 'https://example.slack.com/archives';

// ---- 말풍선 목록(마크다운 — agent/src/reactions.ts todoListMd 와 같은 모양) ----
export const NEW_TODOS_MD = [
  '- **[P1]** 팀원 질문 답장 — 결제 화면 오류 재현 방법 · slack',
  '  #notes-dev 안드로이드 결제 화면이 빈 화면 — 재현 방법 문의',
  '- **[P2]** 디자인 QA 피드백 정리 · slack',
  '  디자이너 — 설정 화면 QA 12건, 배포 전 필수 3건',
].join('\n');
export const LOTS_MD = [
  '| | 할 일 | 출처 |',
  '|---|---|---|',
  '| **P1** | 팀원 질문 답장 — 결제 화면 오류… | slack |',
  '| **P1** | 분기 OKR 셀프 리뷰 제출 (18시 마감) | mail |',
  '| **P1** | NOTE-142 오프라인 동기화 충돌 수정 | jira |',
  '| **P2** | PR #128 리뷰 코멘트 반영 | session |',
  '| **P2** | 주간회의 준비 — 지난주 액션아이템 정리 | slack |',
  '| **P2** | 디자인 QA 피드백 정리 | slack |',
  '',
  '…외 2개',
].join('\n');
export const BRIEF_MD = [
  '- **[P1]** OKR 셀프 리뷰 · :red[오늘 18:00 마감]',
  '- **[P1]** `NOTE-142` 충돌 수정 · ==테스트만 남음==',
  '- **[P1]** 팀원 질문 답장 · slack',
  '- 15:00 **디자인 싱크** 전에 시안 비교표 챙기기',
].join('\n');

// ---- 프로젝트 ----
export const projects = [
  {
    name: '노트앱', path: `${HOME}/notes-app`, lastActive: ago(6), sessions24h: 4,
    lastTitle: '오프라인 동기화 충돌 처리', lastPrompt: '비행기 모드에서 쓴 메모가 다시 연결될 때 덮어써지는 거 고쳐줘', branch: 'fix/offline-merge',
    commitsToday: 4,
    recentCommits: [
      { sha: '9f3c2a1', subject: 'fix(sync): 오프라인 편집 충돌 시 마지막 수정 보존', time: ago(14) },
      { sha: '7b21e0d', subject: 'test(sync): 충돌 재현 케이스 6개 추가', time: ago(52) },
      { sha: '3e88f4c', subject: 'feat(settings): 저장 버튼 상태 표시', time: ago(118) },
      { sha: 'c05a9d2', subject: 'chore: 의존성 정리', time: ago(190) },
    ],
  },
  {
    name: '가계부', path: `${HOME}/ledger-app`, lastActive: ago(48), sessions24h: 2,
    lastTitle: '영수증 OCR 정확도 리포트', lastPrompt: '지난주 영수증 인식 실패 케이스를 표로 정리해줘', branch: 'main',
    commitsToday: 2,
    recentCommits: [
      { sha: 'a41d7e3', subject: 'feat(ocr): 금액 인식 후처리 규칙', time: ago(60) },
      { sha: '58c0b19', subject: 'docs: OCR 리포트 템플릿', time: ago(140) },
    ],
  },
  {
    name: '지도앱', path: `${HOME}/map-app`, lastActive: ago(150), sessions24h: 1,
    lastTitle: '야간 모드 지도 타일', lastPrompt: '어두운 지도에서 길 이름 대비 올려줘', branch: 'feat/night-tiles',
    commitsToday: 1,
    recentCommits: [{ sha: 'e9020fb', subject: 'style(map): 야간 타일 라벨 대비 7:1', time: ago(155) }],
  },
  {
    name: '위키 봇', path: `${HOME}/wiki-bot`, lastActive: ago(60 * 20), sessions24h: 1,
    lastTitle: '검색 결과 요약 길이 조정', lastPrompt: '답이 너무 길어. 세 줄로 줄여줘', branch: 'main',
    commitsToday: 0,
    recentCommits: [
      { sha: '1c7f3aa', subject: 'feat: 요약 세 줄 제한', time: ago(60 * 21) },
      { sha: 'b9e4410', subject: 'fix: 슬래시 명령 권한 체크', time: ago(60 * 23) },
    ],
  },
  {
    name: '디자인 토큰', path: `${HOME}/design-tokens`, lastActive: ago(60 * 30), sessions24h: 0,
    lastTitle: '다크모드 대비 개선', lastPrompt: '보조 텍스트 색 대비 4.5:1 맞춰줘', branch: 'cy/contrast',
    commitsToday: 0,
    recentCommits: [{ sha: '6d3f2c8', subject: 'style: 보조 텍스트 대비 4.5:1', time: ago(60 * 31) }],
  },
  {
    name: '개인 메모', path: `${HOME}/scratch-notes`, lastActive: ago(60 * 24 * 3), sessions24h: 0,
    lastTitle: '', lastPrompt: '', branch: 'main', commitsToday: 0, recentCommits: [],
  },
];

// ---- 할 일 (우선순위 순) ----
export const IDS = {
  slackQ: 'slack:C0DEMO1:1791500000.000100',
  okr: 'mail:demo-okr',
  haru142: 'jira:NOTE-142',
  pr128: `commit:${HOME}/notes-app@9f3c2a1`,
  weekly: 'slack:C0DEMO2:1791499000.000200',
  qa: 'slack:C0DEMO3:1791498000.000300',
  apiKey: 'slack:D0DEMO4:1791497000.000400',
  sync: 'cal:demo-sync',
  weeklyDeck: 'mail:demo-weekly-deck',
  weeklyThread: 'slack:C0DEMO2:1791496000.000500',
  moa57: 'jira:LEDGER-57',
  newsletter: 'mail:demo-newsletter',
  blog: 'user:demo-blog',
};

export const todos = [
  { id: IDS.slackQ, title: '팀원 질문 답장 — 결제 화면 오류 재현 방법', source: 'slack', link: `${SLACK}/C0DEMO1/p1791500000000100`, priority: 1, description: '#notes-dev 에서 팀원이 결제 화면 오류를 어떻게 재현하는지 물었어요. 아직 답하지 않았어요.' },
  { id: IDS.okr, title: '분기 OKR 셀프 리뷰 제출 (오늘 18시 마감)', source: 'mail', link: 'https://mail.example.com/inbox/okr-review', priority: 1, description: '인사팀 메일 — 오늘 18시까지 셀프 리뷰를 내야 해요.' },
  { id: IDS.haru142, title: 'NOTE-142 오프라인 동기화 충돌 수정', source: 'jira', link: 'https://jira.example.com/browse/NOTE-142', priority: 1, progress: '충돌 테스트 2개 남음', description: '비행기 모드에서 쓴 메모가 다시 연결될 때 덮어써지는 버그. 오늘 커밋 2개로 거의 끝났어요.' },
  { id: IDS.pr128, title: 'PR #128 리뷰 코멘트 반영', source: 'session', priority: 2, description: '리뷰어이 남긴 리뷰 코멘트 3개(이름 바꾸기·테스트 추가·로그 정리)가 남아 있어요.' },
  { id: IDS.weekly, title: '주간회의 준비 — 지난주 액션아이템 정리', source: 'slack', link: `${SLACK}/C0DEMO2/p1791499000000200`, priority: 2, description: '#team-weekly 에 매주 목요일 올리는 액션아이템 표.' },
  { id: IDS.qa, title: '디자인 QA 피드백 정리', source: 'slack', link: `${SLACK}/C0DEMO3/p1791498000000300`, priority: 2, description: '디자이너이 설정 화면 QA 결과 12건을 스레드에 올렸어요.' },
  { id: IDS.apiKey, title: '리뷰어에게 API 키 회전 일정 공유', source: 'slack', link: `${SLACK}/D0DEMO4/p1791497000000400`, priority: 2, description: 'DM으로 다음 주 API 키 회전 날짜를 알려 달라고 했어요.' },
  { id: IDS.sync, title: '디자인 싱크 전에 시안 3종 비교표 만들기', source: 'calendar', priority: 2, description: '15:00 디자인 싱크 — 시안 A/B/C 비교표를 먼저 공유하면 좋아요.' },
  { id: IDS.weeklyDeck, title: '주간회의 발표 자료 숫자 업데이트', source: 'mail', priority: 3, description: '팀원 메일 — 지난주 지표로 슬라이드 4–6쪽 갱신.' },
  { id: IDS.weeklyThread, title: '목요일 주간회의 안건 스레드에 의견 달기', source: 'slack', link: `${SLACK}/C0DEMO2/p1791496000000500`, priority: 3, description: '안건 3개에 의견을 남겨 달라는 요청.' },
  { id: IDS.moa57, title: 'LEDGER-57 영수증 OCR 정확도 리포트 읽기', source: 'jira', link: 'https://jira.example.com/browse/LEDGER-57', priority: 3, description: '동료이 올린 OCR 정확도 리포트(인식률 94.2%).' },
  { id: IDS.newsletter, title: '팀 뉴스레터 10월호 훑어보기', source: 'mail', priority: 4, appliedRule: { id: 'rule:seed0', text: '앞으로 뉴스레터는 백로그로' }, description: '읽을거리 — 급하지 않아요.' },
  { id: IDS.blog, title: '개발 블로그 글감 메모 — 오프라인 동기화 이야기', source: 'user', priority: 4, description: '이번 충돌 처리 경험을 글로 남기면 좋겠다고 적어 둠.' },
];

// GET /todos/:id/detail 원본
export const origins = {
  [IDS.slackQ]: { description: todos[0].description, source: { kind: 'slack', ref: IDS.slackQ, author: '팀원', channel: '#notes-dev', at: ago(95), excerpt: '혹시 결제 화면에서 "다시 시도" 누르면 빈 화면 뜨는 거 재현 방법 아세요? 안드로이드에서만 그런 것 같아요 🙏', permalink: `${SLACK}/C0DEMO1/p1791500000000100` } },
  [IDS.okr]: { description: todos[1].description, source: { kind: 'mail', ref: 'mail:demo-okr', title: '[안내] 3분기 OKR 셀프 리뷰 제출 (오늘 18:00 마감)', author: '인사팀', at: ago(60 * 7), permalink: 'https://mail.example.com/inbox/okr-review' } },
  [IDS.haru142]: { description: todos[2].description, source: { kind: 'jira', ref: 'jira:NOTE-142', title: 'NOTE-142 오프라인 편집 후 동기화 시 메모 덮어씀', author: '리뷰어', at: ago(60 * 26), permalink: 'https://jira.example.com/browse/NOTE-142' } },
  [IDS.pr128]: { description: todos[3].description, source: { kind: 'commit', ref: IDS.pr128, repo: `${HOME}/notes-app`, sha: '9f3c2a1e77d0', author: '나', at: ago(14), title: 'fix(sync): 오프라인 편집 충돌 시 마지막 수정 보존', excerpt: 'fix(sync): 오프라인 편집 충돌 시 마지막 수정 보존\n\n- 충돌 나면 서버 버전을 따로 보관하고 사용자에게 고르게 함\n- 리뷰: 리뷰어' } },
  [IDS.weekly]: { description: todos[4].description, source: { kind: 'slack', ref: IDS.weekly, author: '팀원', channel: '#team-weekly', at: ago(60 * 20), excerpt: '이번 주도 목요일 오전까지 액션아이템 표 업데이트 부탁드려요!', permalink: `${SLACK}/C0DEMO2/p1791499000000200` } },
  [IDS.qa]: { description: todos[5].description, source: { kind: 'slack', ref: IDS.qa, author: '디자이너', channel: '#design-qa', at: ago(60 * 3), excerpt: '설정 화면 QA 끝났어요. 12건 중 3건은 꼭 이번 배포 전에 봐주세요 (저장 버튼 상태, 토글 간격, 다크모드 구분선)', permalink: `${SLACK}/C0DEMO3/p1791498000000300` } },
  [IDS.apiKey]: { description: todos[6].description, source: { kind: 'slack', ref: IDS.apiKey, author: '리뷰어', channel: 'DM', at: ago(60 * 5), excerpt: 'API 키 회전 다음 주 언제 하는지 알려주실 수 있나요? 배포 일정이랑 겹치는지 보려고요', permalink: `${SLACK}/D0DEMO4/p1791497000000400` } },
  [IDS.sync]: { description: todos[7].description, source: { kind: 'calendar', ref: 'cal:demo-sync', title: '디자인 싱크 (15:00–15:45)', at: ago(-60) } },
  [IDS.weeklyDeck]: { description: todos[8].description, source: { kind: 'mail', ref: 'mail:demo-weekly-deck', title: 'Re: 주간회의 자료 업데이트 요청', author: '팀원', at: ago(60 * 9) } },
  [IDS.weeklyThread]: { description: todos[9].description, source: { kind: 'slack', ref: IDS.weeklyThread, author: '한지우', channel: '#team-weekly', at: ago(60 * 22), excerpt: '목요일 안건: ① 릴리스 일정 ② 온콜 순번 ③ 회고 방식 — 의견 달아주세요', permalink: `${SLACK}/C0DEMO2/p1791496000000500` } },
  [IDS.moa57]: { description: todos[10].description, source: { kind: 'jira', ref: 'jira:LEDGER-57', title: 'LEDGER-57 영수증 OCR 정확도 리포트', author: '동료', at: ago(60 * 30), permalink: 'https://jira.example.com/browse/LEDGER-57' } },
  [IDS.newsletter]: { description: todos[11].description, source: { kind: 'mail', ref: 'mail:demo-newsletter', title: '팀 뉴스레터 10월호', author: '팀 커뮤니케이션', at: ago(60 * 48) } },
  [IDS.blog]: { description: todos[12].description, source: { kind: 'user', ref: IDS.blog } },
};

// 최근 완료 — Slack 대화를 보고 자동으로 끝낸 것("자동" 칩)
export const autoDone = [
  {
    id: 'slack:D0DEMO5:1791490000.000900', title: '디자인 에이전시 견적서 회신', source: 'slack', priority: 1, userEdited: false, doneBy: 'auto',
    autoReason: "DM에서 '견적서 회신 보냈어요'라고 말함", autoEvidence: `${SLACK}/D0DEMO5/p1791490500000900`, doneAt: ago(25),
  },
  {
    id: 'mail:demo-badge', title: '출입증 재발급 신청', source: 'mail', priority: 3, userEdited: false, doneBy: 'auto',
    autoReason: '총무팀 메일에 "신청 완료" 회신', autoEvidence: `${SLACK}/C0DEMO6/p1791480000001000`, doneAt: ago(60 * 5),
  },
];

export const proposals = [
  { id: 'p-demo-1', title: '설정 화면 저장 버튼 정리', repo: '노트앱', status: 'running', result: '' },
  { id: 'p-demo-2', title: '위키 봇 로그 레벨을 환경변수로', repo: '위키 봇', status: 'pending', result: '' },
  { id: 'p-demo-0', title: '보조 텍스트 대비 4.5:1', repo: '디자인 토큰', status: 'done', result: 'https://github.com/example-team/design-tokens/pull/41' },
];

export const briefing = {
  at: ago(32),
  bubble: '회의 3개, P1 3개, 답장할 스레드 2개.',
  replyMd: [
    '## 지금 챙길 것',
    '1. **OKR 셀프 리뷰** — :red[오늘 18:00 마감]',
    '2. `NOTE-142` 오프라인 동기화 충돌 — 커밋 2개로 ==거의 끝==',
    '3. 팀원 질문 답장 (#notes-dev)',
    '',
    '## 오늘 일정',
    '| 시간 | 회의 | 준비 |',
    '|---|---|---|',
    '| 11:00 | 노트앱 스탠드업 | — |',
    '| 15:00 | 디자인 싱크 | 시안 비교표 |',
    '| 17:00 | 1:1 (팀원) | 이번 분기 회고 |',
    '',
    '> [!TIP]',
    '> 14시–15시가 비어 있어~요. 리뷰 코멘트 반영하기 좋은 시간이에요!',
  ].join('\n'),
};

export const history = [
  { role: 'user', text: '오늘 뭐부터 하면 돼?', at: ago(58) },
  {
    role: 'assistant', at: ago(57),
    text: [
      '**P1 세 개**부터 해 봐요~',
      '',
      '| 순서 | 할 일 | 왜 |',
      '|---|---|---|',
      '| 1 | OKR 셀프 리뷰 | :red[오늘 18시 마감] |',
      '| 2 | NOTE-142 마무리 | 테스트만 남음 |',
      '| 3 | 팀원 답장 | 2시간째 대기 중 |',
      '',
      '> [!NOTE]',
      '> 디자인 싱크(15:00) 전에 ==시안 비교표==도 잊지 마세요!',
    ].join('\n'),
  },
  { role: 'user', text: '어제 내가 뭐 했지?', at: ago(41) },
  {
    role: 'assistant', at: ago(40),
    text: '어제는 커밋이 **6개**였어~요. 노트앱 4개, 가계부 2개예요. (뿌듯한 시사)\n- :green[동기화 충돌 테스트 6개 추가]\n- :blue[OCR 후처리 규칙] 초안\n- 위키 봇 요약을 세 줄로 줄였어요',
  },
];

// 할 일 규칙(하나는 미리 있음)
export const rules = [
  { text: '앞으로 뉴스레터는 백로그로', match: { keywords: ['뉴스레터'], description: '제목에 뉴스레터' }, effect: { backlog: true, priority: 4 }, hits: 3 },
];

export const meetings = () => [
  { id: 'demo-meet1', subject: '디자인 싱크', start: new Date(Date.now() + 10 * 60e3).toISOString(), end: new Date(Date.now() + 55 * 60e3).toISOString(), link: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_DEMO%40thread.v2/0' },
  { id: 'demo-meet2', subject: '1:1 (팀원)', start: new Date(Date.now() + 130 * 60e3).toISOString(), end: new Date(Date.now() + 160 * 60e3).toISOString() },
];

// 연결 상태(가상)
export const connectors = () => [
  { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'Slack Web API (사용자 토큰)', doc: 'docs/connect/slack.md' },
  { cap: 'calendar', label: '캘린더', mode: 'api', ready: true, detail: 'ICS 1개', doc: 'docs/connect/calendar.md' },
  { cap: 'mail', label: '메일', mode: 'off', ready: false, detail: '연결 안 됨', doc: 'docs/connect/mail.md' },
  { cap: 'issues', label: '이슈', mode: 'mcp', ready: true, detail: 'MCP github (github)', doc: 'docs/connect/issues.md' },
];

export const today = {
  date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()),
  asked: true,
  items: [
    { id: 'd1', title: '디자인 싱크 전에 시안 비교표', done: false },
    { id: 'd2', title: '오프라인 동기화 테스트 마무리', done: false },
    { id: 'd3', title: '주간회의 안건 적기', done: false },
  ],
};

// ---- 작업 세션(runs) — fake-runs.mjs 와 같은 계약, 데모 대본으로. 데모가 /demo/run/start 로 시작한다 ----
export const RUN_TITLE = '설정 화면 저장 버튼 정리';
const WT = '/Users/demo/.cy-agent/worktrees/notes-app-7f2c';
const RUN_SCRIPT = [
  { type: 'system', text: `세션 시작 · claude-opus · ${WT}` },
  { type: 'assistant', text: 'QA 피드백 3건부터 볼게요. 저장 버튼 상태 처리가 어디 있는지 찾아볼게요.' },
  { type: 'tool_use', name: 'Grep', input: 'saveState in src/settings', id: 1 },
  { type: 'tool_result', id: 1, output: 'src/settings/SettingsPage.tsx:41:  const [saveState, setSaveState] = useState("idle");\nsrc/settings/SaveButton.tsx:8:export function SaveButton({ saveState }) {' },
  { type: 'tool_use', name: 'Read', input: `${WT}/src/settings/SaveButton.tsx`, id: 2 },
  { type: 'tool_result', id: 2, output: 'export function SaveButton({ saveState }) {\n  return <button disabled={saveState === "saving"}>저장</button>;\n}\n' },
  { type: 'assistant', text: '저장 중·저장됨·실패 상태가 버튼에 안 보여요. **라벨과 아이콘**을 상태별로 나눌게요.' },
  {
    type: 'tool_use', name: 'Edit', input: `${WT}/src/settings/SaveButton.tsx`, id: 3,
    diff: [{
      file: 'src/settings/SaveButton.tsx',
      old: 'export function SaveButton({ saveState }) {\n  return <button disabled={saveState === "saving"}>저장</button>;\n}',
      new: 'const LABEL = { idle: "저장", saving: "저장 중…", saved: "저장됨 ✓", error: "다시 시도" };\n\nexport function SaveButton({ saveState }) {\n  return (\n    <button disabled={saveState === "saving"} data-state={saveState}>\n      {LABEL[saveState] ?? LABEL.idle}\n    </button>\n  );\n}',
    }],
  },
  { type: 'tool_result', id: 3, output: 'The file src/settings/SaveButton.tsx has been updated.' },
  {
    type: 'tool_use', name: 'Edit', input: `${WT}/src/settings/settings.css`, id: 4,
    diff: [{ file: 'src/settings/settings.css', old: '.toggle-row { gap: 6px; }\n.divider { border-color: #2a2a2a; }', new: '.toggle-row { gap: 12px; }\n.divider { border-color: var(--line-strong); }' }],
  },
  { type: 'tool_result', id: 4, output: 'The file src/settings/settings.css has been updated.' },
  { type: 'tool_use', name: 'Bash', input: 'npm test -- settings', id: 5 },
  { type: 'tool_result', id: 5, output: '> notes-app@2.4.0 test\n> vitest run settings\n\n ✓ SaveButton.test.tsx (6)\n ✓ SettingsPage.test.tsx (14)\n\n Test Files  2 passed (2)\n      Tests  20 passed (20)' },
  { type: 'assistant', text: 'QA 3건(저장 버튼 상태·토글 간격·다크모드 구분선) 반영했고 테스트 20개 통과했어요. 커밋·PR은 데몬이 올려요.' },
];
const SEED_RUNS = [
  ['fix', '보조 텍스트 대비 4.5:1', 60 * 26, [
    { type: 'user', text: '다음 변경을 이 레포에 구현해.\n\n제목: 보조 텍스트 대비 4.5:1' },
    { type: 'assistant', text: '토큰 파일에서 보조 텍스트 색을 찾을게요.' },
    { type: 'tool_use', name: 'Grep', input: 'text-secondary', toolUseId: 's1' },
    { type: 'tool_result', toolUseId: 's1', output: 'tokens/color.json:18:  "text-secondary": "#8a8a8a",' },
    { type: 'tool_use', name: 'Edit', input: 'tokens/color.json', toolUseId: 's2', diff: [{ file: 'tokens/color.json', old: '"text-secondary": "#8a8a8a",', new: '"text-secondary": "#6b6b6b",' }] },
    { type: 'tool_result', toolUseId: 's2', output: 'The file tokens/color.json has been updated.' },
    { type: 'result', text: '완료', costUsd: 0.18 },
  ], { costUsd: 0.18 }],
  ['briefing', '아침 브리핑', 35, [
    { type: 'user', text: '(브리핑 맥락 …)' },
    { type: 'tool_use', name: 'mcp__demo__calendar_today', input: 'today', toolUseId: 'b1' },
    { type: 'tool_result', toolUseId: 'b1', output: '{"events": 3}' },
    { type: 'assistant', text: '회의 3개, P1 3개, 답장할 스레드 2개.' },
    { type: 'result', text: 'ok', costUsd: 0.05 },
  ], { costUsd: 0.05 }],
  ['slack-ingest', 'Slack 수집', 18, [
    { type: 'user', text: '(본문 640자 — 기록 안 함)', size: 640 },
    { type: 'tool_use', name: 'mcp__demo__slack_history', toolUseId: 'c1', size: 52 },
    { type: 'tool_result', toolUseId: 'c1', size: 12873 },
    { type: 'result', text: '(본문 4자 — 기록 안 함)', size: 4 },
  ], { costUsd: 0.003 }],
];

export function createRuns(emit, { onActive = () => {} } = {}) {
  const stepMs = Math.round((Number(process.env.DEMO_RUN_STEP_MS) || 1700) * PACE);
  const runs = new Map();
  const summary = (r) => ({ ...r.run, events: r.events.length, dropped: 0, interactive: r.run.status === 'running' && r.run.kind === 'fix' && !r.closing });
  const active = () => [...runs.values()].filter((r) => r.run.status === 'running').map(summary);
  const changed = (r) => { emit('runs', { run: summary(r), active: active() }); onActive(active()); };
  const log = (r, ev) => {
    const seq = r.events.length + 1;
    const event = { seq, at: new Date().toISOString(), ...ev };
    r.events.push(event);
    emit('run', { id: r.run.id, seq, event });
  };
  const end = (r, status) => {
    clearTimeout(r.timer);
    r.run.status = status;
    r.run.endedAt = new Date().toISOString();
    log(r, { type: 'status', text: status });
    changed(r);
  };
  for (const [kind, title, minAgo, events, extra] of SEED_RUNS) {
    const r = { run: { id: randomUUID(), kind, title, model: kind === 'fix' ? 'claude-opus' : 'claude-sonnet', startedAt: ago(minAgo), endedAt: ago(minAgo - 3), status: 'done', cwd: kind === 'fix' ? '/Users/demo/.cy-agent/worktrees/design-tokens-41' : '/Users/demo/.cy-agent/brain', sdkSessionId: 'sess-demo', ...extra }, events: [] };
    events.forEach((e, i) => r.events.push({ seq: i + 1, at: ago(minAgo - i * 0.1), ...e }));
    r.events.push({ seq: r.events.length + 1, at: r.run.endedAt, type: 'status', text: 'done' });
    runs.set(r.run.id, r);
  }

  function step(r) {
    if (r.run.status !== 'running') return;
    if (r.queue.length) {
      const text = r.queue.shift();
      log(r, { type: 'assistant', text: `좋아요 — "${text}" 반영할게요.` });
      const tid = `q${r.events.length}`;
      log(r, { type: 'tool_use', name: 'Edit', input: `${WT}/src/settings/SaveButton.tsx`, toolUseId: tid, diff: [{ file: 'src/settings/SaveButton.tsx', old: 'saved: "저장됨 ✓"', new: 'saved: "저장 완료 ✓"' }] });
      log(r, { type: 'tool_result', toolUseId: tid, output: 'The file src/settings/SaveButton.tsx has been updated.' });
    } else if (r.i < RUN_SCRIPT.length) {
      const { id, ...ev } = RUN_SCRIPT[r.i++];
      log(r, id ? { ...ev, toolUseId: `${r.run.id.slice(0, 4)}-${id}` } : ev);
    } else {
      r.closing = true;
      r.run.costUsd = 0.42;
      log(r, { type: 'result', text: '완료', costUsd: 0.42 });
      return end(r, 'done');
    }
    r.timer = setTimeout(() => step(r), stepMs);
  }
  function start(title = RUN_TITLE) {
    const r = { run: { id: randomUUID(), kind: 'fix', title, model: 'claude-opus', startedAt: new Date().toISOString(), status: 'running', cwd: WT, ref: 'p-demo-1' }, events: [], queue: [], i: 0 };
    runs.set(r.run.id, r);
    changed(r);
    log(r, { type: 'user', text: `다음 변경을 이 레포에 구현해.\n\n제목: ${title}\n계획:\n- 저장 버튼 상태(저장 중·저장됨·실패) 표시\n- 토글 간격 12px\n- 다크모드 구분선 색` });
    r.timer = setTimeout(() => step(r), stepMs);
    return r;
  }
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  function handle(req, res, url, body) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/runs') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const status = url.searchParams.get('status');
      let list = [...runs.values()].map(summary);
      if (status) list = list.filter((r) => r.status === status);
      list.sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.startedAt.localeCompare(a.startedAt));
      json(res, 200, { runs: list.slice(0, limit) });
      return true;
    }
    const g = req.method === 'GET' && p.match(/^\/runs\/([\w-]+)$/);
    if (g) {
      const r = runs.get(g[1]);
      if (!r) { json(res, 404, { error: 'no such run' }); return true; }
      const since = Number(url.searchParams.get('since') ?? 0);
      json(res, 200, { run: summary(r), events: r.events.filter((e) => e.seq > since) });
      return true;
    }
    if (req.method !== 'POST') return false;
    if (p === '/fake/runs/start') { const r = start(body?.title || undefined); json(res, 200, { ok: true, id: r.run.id }); return true; }
    const c = p.match(/^\/runs\/([\w-]+)\/(message|interrupt|stop)$/);
    if (!c) return false;
    const r = runs.get(c[1]);
    if (!r) { json(res, 404, { error: 'no such run' }); return true; }
    if (r.run.status !== 'running' || r.closing) { json(res, 409, { error: 'run is not running (read-only)' }); return true; }
    if (c[2] === 'message') {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 8000) { json(res, 400, { error: 'text required' }); return true; }
      r.queue.push(text);
      log(r, { type: 'user', text, injected: true });
      clearTimeout(r.timer);
      r.timer = setTimeout(() => step(r), Math.min(900, stepMs));
    } else if (c[2] === 'interrupt') {
      clearTimeout(r.timer);
      log(r, { type: 'system', text: '사용자가 중단(interrupt)했어' });
    } else {
      log(r, { type: 'system', text: '사용자가 정지(stop)했어' });
      end(r, 'stopped');
    }
    json(res, 200, { ok: true });
    return true;
  }
  return { handle, active, start, snapshot: () => ({ active: active() }) };
}

// ---- 채팅: 단계 몇 개 → 답(마크다운). show 가 있으면 패널을 그 탭으로 ----
const RISK_MD = [
  '이번 주 릴리스(**노트앱 2.5**) 기준으로 정리했어요.',
  '',
  '| 항목 | 상태 | 담당 | 메모 |',
  '|---|---|---|---|',
  '| 오프라인 동기화 충돌 | :green[수정 완료] | 나 | 테스트 6개 추가 |',
  '| 결제 화면 빈 화면 | :red[재현 중] | 팀원 | 안드로이드만 |',
  '| 설정 화면 QA 12건 | :blue[진행 중] | 디자이너 | 필수 3건 남음 |',
  '| API 키 회전 | :orange[일정 미정] | 리뷰어 | 배포일과 겹칠 수도 |',
  '',
  '> [!WARNING]',
  '> 결제 화면 오류는 ==원인 미확인==이에요. 금요일 배포 전에 재현이 안 되면 기능 플래그로 꺼 두는 걸 추천해요. (걱정하는 시사)',
  '',
  '> [!TIP]',
  '> QA 필수 3건은 지금 돌고 있는 수정 작업에 넣어 둘게요. 끝나면 머지할지 여쭤볼게요!',
  '',
  '**한 줄 요약**: :red[위험 1개], :orange[주의 1개], 나머지는 :green[순조로워~요].',
].join('\n');
const MEET_MD = '오늘은 회의가 **3개**에~요.\n1. 11:00 노트앱 스탠드업 — 끝났어요\n2. **15:00 디자인 싱크** — 시안 비교표를 먼저 공유하면 좋아요\n3. 17:00 1:1 (팀원) — 분기 회고 메모 챙기세요\n\n14–15시는 비어 있어서 리뷰 코멘트 반영하기 딱 좋아요! (스이시~사)';

let chatSeq = 0;
export function chat(text, focus, { emit, history }) {
  const chatId = `demo-c${++chatSeq}`;
  const at = () => new Date().toISOString();
  history.push({ role: 'user', text, at: at(), ...(focus ? { todoId: focus.id, todoTitle: focus.title } : {}) });
  let steps, reply, show = null;
  if (/위험|릴리스|정리/.test(text)) {
    steps = ['slack.slack_search_messages', 'jira.search_issues', 'git.log', 'store.recent_sessions'];
    reply = RISK_MD;
  } else if (/프로젝트|현황|커밋/.test(text)) {
    steps = ['git.log', 'store.recent_sessions'];
    reply = `오늘 커밋은 **${projects.reduce((n, p) => n + p.commitsToday, 0)}개**예요 — 노트앱 4 · 가계부 2 · 지도앱 1. 프로젝트 탭 열어 둘게요~`;
    show = 'projects';
  } else if (/회의|일정/.test(text)) {
    steps = ['google-calendar.list-events', 'store.todos'];
    reply = MEET_MD;
  } else {
    steps = ['store.todos', 'slack.slack_search_messages'];
    reply = `"${text}" — 알겠어요, 기억해 둘게요.`;
  }
  later(() => emit('chat', { chatId, status: 'thinking' }), 200);
  steps.forEach((step, i) => later(() => emit('chat', { chatId, status: 'step', step }), 900 + i * 1100));
  later(() => {
    history.push({ role: 'assistant', text: reply, at: at() });
    while (history.length > 50) history.shift();
    emit('chat', { chatId, status: 'done', text: reply, show });
    if (show) emit('open_panel', { section: show });
  }, 900 + steps.length * 1100 + 500);
  return chatId;
}

// ---- 데모 전용 경로: 드라이버(demo-driver.mjs)가 부른다 ----
// POST /demo/emit {event,data} · /demo/mood {mood} · /demo/brain {ready, provider?} · /demo/run/start {title} · /demo/merge {title} · /demo/focus/backdate {ms}
// POST /demo/disconnect {ms} — SSE 를 끊고 ms 동안 다시 못 붙게(캐릭터가 흐려지고 잠든 모습)
// /proposals/demo-*/merge|decline-merge|ask — 데모 PR 머지 승인(✓/✗/추가질문)
const merges = new Map();
let downUntil = 0;
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}
const MODELS = [{ id: 'claude-opus-5-5', label: 'Opus' }, { id: 'claude-sonnet-5-5', label: 'Sonnet' }, { id: 'claude-haiku-5-5', label: 'Haiku' }];
function demoSettings() {
  return {
    models: { quick: 'claude-sonnet-5-5', general: 'claude-sonnet-5-5', code: 'claude-opus-5-5', light: 'claude-haiku-5-5' },
    modelRoles: [{ role: 'quick', label: '빠른 대화(더블클릭)' }, { role: 'general', label: '브리핑·채팅' }, { role: 'code', label: '코드 고치기' }, { role: 'light', label: '가벼운 일' }],
    modelOptions: MODELS, envLocked: [],
    briefing: { exclude: ['mail'], sources: [{ id: 'mail', label: '메일' }, { id: 'calendar', label: '일정' }, { id: 'slack', label: 'Slack' }, { id: 'issues', label: '이슈' }, { id: 'sessions', label: '최근 작업 세션' }] },
    phrases: [
      { key: 'greet', group: '인사', label: '아침 인사', vars: [], default: ['좋은 아침이에요!'], value: null },
      { key: 'meeting_alert', group: '일정', label: '일정 알림', vars: ['mins', 'title', 'time', 'where'], default: ['일정 {mins}분 전이에요! 〈{title}〉 {time}{where}'], value: null },
    ],
    autoMerge: ['example-team/notes-app'],
    brain: { provider: 'claude-code', model: 'claude-sonnet-5-5', keys: { gemini: false, openai: false, anthropic: false } },
    user: { name: '길동' }, repoRoots: ['/Users/demo/code'], configPath: '~/.cy-agent/config.json',
  };
}
function demoConnRows() {
  const at = new Date().toISOString();
  const row = (id, label, group, state, detail, extra = {}) => ({ id, label, group, state, detail, check: 'local', checkedAt: at, ...extra });
  return [
    row('brain', '뇌(브리핑·채팅 모델)', 'core', 'ok', 'Claude Code'),
    row('claude', 'Claude 로그인', 'core', 'ok', '로그인됨', { check: 'claude' }),
    row('connector:slack', 'Slack', 'service', 'ok', 'Slack Web API (사용자 토큰)', { summary: 'api' }),
    row('connector:calendar', '캘린더', 'service', 'ok', 'ICS 1개', { summary: 'api' }),
    row('connector:mail', '메일', 'service', 'off', '연결 안 됨', { summary: 'off', doc: 'docs/connect/mail.md' }),
    row('connector:issues', '이슈', 'service', 'ok', 'MCP github (github)', { summary: 'mcp' }),
    row('slack-ingest', 'Slack 수집', 'local', 'ok', '5분 전에 수집했어요'),
    row('sessions', '작업 세션(Claude Code·Codex 기록)', 'local', 'ok', '로컬 기록을 읽어요'),
  ];
}

export async function route(req, res, url, ctx) {
  const p = url.pathname;
  const { emit, json, clients } = ctx;
  if (p === '/events' && Date.now() < downUntil) { req.socket.destroy(); return true; }
  // 설정 창(⚙)용: 가짜 데몬의 빈 설정 대신 그럴듯한 모델·출처·문구·연결 상태(전부 지어낸 값)
  if (req.method === 'GET' && p === '/settings') { json(res, 200, demoSettings()); return true; }
  if (req.method === 'GET' && p === '/connections') { json(res, 200, { rows: demoConnRows(), checkedAt: new Date().toISOString() }); return true; }
  if (req.method === 'POST' && p === '/connections/check') { json(res, 200, { rows: demoConnRows(), checkedAt: new Date().toISOString() }); return true; }
  const isDemo = p.startsWith('/demo/');
  const mg = p.match(/^\/proposals\/(demo-[\w-]+)\/(merge|decline-merge|ask)$/);
  if (!isDemo && !mg) return false;
  if (req.method !== 'POST' || req.headers['x-cy-agent'] !== '1' || req.headers.origin) { json(res, 403, { error: 'forbidden' }); return true; }
  const body = await readBody(req);

  if (p === '/demo/emit') { emit(body.event, body.data ?? {}); json(res, 200, { ok: true }); return true; }
  if (p === '/demo/brain') { ctx.brain?.({ ready: body.ready !== false, provider: body.provider }); json(res, 200, { ok: true }); return true; } // 뇌 연결 끊기·붙이기
  if (p === '/demo/mood') { ctx.mood(body.mood ?? 'idle'); json(res, 200, { ok: true }); return true; }
  if (p === '/demo/focus/backdate') { json(res, 200, { ok: true, focus: ctx.focus?.backdate(Number(body.ms) || 0) ?? null }); return true; } // 집중 중인 것을 앞당겨 시작한 셈 치기
  if (p === '/demo/run/start') { const r = ctx.runs.start(body.title || RUN_TITLE); json(res, 200, { ok: true, id: r.run.id }); return true; }
  if (p === '/demo/disconnect') {
    downUntil = Date.now() + (Number(body.ms) || 6000);
    for (const c of [...clients]) c.destroy?.() ?? c.socket?.destroy();
    json(res, 200, { ok: true, until: downUntil });
    return true;
  }
  if (p === '/demo/merge') {
    const pid = body.pid || `demo-pr${merges.size + 1}`;
    const rec = { state: 'asking', prUrl: body.link || 'https://github.com/example-team/notes-app/pull/131', title: body.title || RUN_TITLE };
    merges.set(pid, rec);
    emit('bubble', { id: `merge:${pid}`, text: `PR 올렸어요 — '${rec.title}' 머지할까요?`, kind: 'proposal', proposalId: pid, actions: 'merge', image: 'merge', link: rec.prUrl });
    json(res, 200, { ok: true, pid });
    return true;
  }
  if (mg) {
    const rec = merges.get(mg[1]);
    if (!rec) { json(res, 404, { ok: false, error: '머지할 PR을 못 찾았어' }); return true; }
    const id = `merge:${mg[1]}`;
    if (mg[2] === 'ask') {
      if (rec.state !== 'asking') { json(res, 409, { ok: false, error: '이미 끝났어' }); return true; }
      later(() => {
        const reply = '파일 3개(+41/−9) 바꿨고 테스트 20개 다 통과했어요. UI 문구·간격만 바뀌어서 위험도는 낮아요 👍 (자신 있는 시사)';
        emit('bubble', { id, text: reply, kind: 'proposal', proposalId: mg[1], actions: 'merge', link: rec.prUrl });
        json(res, 200, { ok: true, reply });
      }, 1800);
      return true;
    }
    if (mg[2] === 'decline-merge') {
      rec.state = 'declined';
      emit('bubble', { id, text: '알겠어요, 머지는 안 할게요. PR은 열어 둘게요', kind: 'info', ttlMs: 6000, link: rec.prUrl });
      json(res, 200, { ok: true, state: 'declined' });
      return true;
    }
    if (rec.state === 'merged') { json(res, 200, { ok: true, state: 'merged', already: true }); return true; }
    rec.state = 'merging';
    emit('bubble', { id, text: '머지하는 중이에요…', kind: 'info', ttlMs: 120000, link: rec.prUrl });
    later(() => {
      rec.state = 'merged';
      const pr = proposals.find((x) => x.id === 'p-demo-1');
      if (pr) Object.assign(pr, { status: 'done', result: rec.prUrl });
      emit('bubble', { id, text: '머지했어요 🎉 (스이시~사)', kind: 'done', image: 'merge_complete', ttlMs: 16000, link: rec.prUrl, detail: '✓ Squash and merge — #131\n✓ 배포 파이프라인 시작 (스테이징)' });
      emit('dashboard', {});
      json(res, 200, { ok: true, state: 'merged' });
    }, 1600);
    return true;
  }
  json(res, 404, { error: 'unknown demo route' });
  return true;
}
