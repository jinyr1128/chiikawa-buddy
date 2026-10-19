// 같은 일인가 — 브리핑 모델이 같은 일을 매번 다른 key 로 올려서(other:jira-reconnect → session:jira-mcp-reconnect …)
// 휴지통에 넣은 일·끝낸 일·사용자가 고친 열린 일이 새 id 로 되살아나던 것을 막는 결정적 비교(모델 없음).
//  1) 참조 키: id·source_ref·링크를 정규화해 같으면 같은 일(slack ts 의 점 유무, Slack·GitHub·Jira 링크 → 키).
//     session:·other:·user: 처럼 거친(한 세션에서 여러 일이 나오는) 키는 비교하지 않는다.
//  2) 제목: 글자 바이그램 Dice ≥ DEDUPE.similarity, 그리고 제목 속 숫자(날짜·PR 번호·시각)가 똑같을 때만
//     — "오늘(10/9) 스크럼"과 "오늘(10/10) 스크럼"은 다른 일.

export const DEDUPE = {
  similarity: 0.7, // 제목 비슷함 문턱(실데이터: 같은 VPN 재수집 할 일끼리 0.73~0.84, 다른 일 ≤ 0.55)
  trashDays: 30,   // 이 기간 안에 휴지통에 넣은(영구 삭제 포함) 일과 비교
  doneDays: 2,     // 이 기간 안에 끝낸 일과 비교(매일 반복되는 일은 날짜가 제목에 들어가 숫자로 갈린다)
};

const COARSE = new Set(["session", "other", "user"]); // 한 출처에서 여러 할 일이 나오는 키

export function normTitle(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function grams(s: string): Set<string> {
  const n = normTitle(s);
  const g = new Set<string>();
  if (n.length === 1) g.add(n);
  for (let i = 0; i < n.length - 1; i++) g.add(n.slice(i, i + 2));
  return g;
}
// 0..1 (글자 바이그램 Dice)
export function titleSimilarity(a: string, b: string): number {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let k = 0;
  for (const x of A) if (B.has(x)) k++;
  return (2 * k) / (A.size + B.size);
}
const numbers = (s: string) => [...new Set(s.match(/\d+/g) ?? [])].map((x) => String(Number(x))).sort().join(",");
export function sameNumbers(a: string, b: string): boolean {
  return numbers(a) === numbers(b);
}
export function similarTitle(a: string, b: string, th = DEDUPE.similarity): boolean {
  return sameNumbers(a, b) && titleSimilarity(a, b) >= th;
}

// 비교용 참조 키. 거친 키·모르는 모양은 undefined
export function normRef(ref: string | undefined | null): string | undefined {
  const r = String(ref ?? "").trim();
  if (!r) return undefined;
  const m = /^([a-z0-9-]+):(.+)$/i.exec(r);
  if (!m) return undefined;
  const kind = m[1].toLowerCase();
  if (COARSE.has(kind)) return undefined;
  const slack = /^([A-Z0-9]+):(\d+)\.?(\d*)$/i.exec(m[2]);
  if (kind === "slack" && slack) return `slack:${slack[1].toUpperCase()}:${slack[2]}${slack[3]}`;
  return `${kind}:${m[2].trim().toLowerCase()}`;
}

// 링크 → 참조 키(Slack 메시지·GitHub PR/이슈·Jira 이슈만). 나머지는 undefined
export function linkRef(link: string | undefined | null): string | undefined {
  const l = String(link ?? "");
  const s = /\/archives\/([A-Z0-9]+)\/p(\d{7,})/.exec(l);
  if (s) return `slack:${s[1]}:${s[2]}`;
  const g = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/i.exec(l);
  if (g) return `gh:${g[1].toLowerCase()}#${g[2]}`;
  const j = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(l);
  if (j) return `jira:${j[1].toLowerCase()}`;
  return undefined;
}

export type MatchItem = { id: string; title: string; titles?: string[]; sourceRef?: string; link?: string };
export function refsOf(t: MatchItem): Set<string> {
  return new Set([normRef(t.id), normRef(t.sourceRef), linkRef(t.link)].filter((x): x is string => !!x));
}

// 새 할 일(a)이 기존 것(b)과 같은 일인가. 왜 같은지("ref"|"title") 또는 undefined
export function sameItem(a: MatchItem, b: MatchItem, th = DEDUPE.similarity): "ref" | "title" | undefined {
  const ra = refsOf(a);
  for (const r of refsOf(b)) if (ra.has(r)) return "ref";
  for (const t of [b.title, ...(b.titles ?? [])]) if (t && similarTitle(a.title, t, th)) return "title";
  return undefined;
}
