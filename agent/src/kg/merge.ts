// 추출 결과 → 지식그래프 병합. 결정적이고 멱등이다(같은 청크를 다시 병합해도 근거가 두 번 쌓이지 않는다).
//
// - id: project는 이름이 로컬 레포(project:<경로> 노드)의 basename과 맞으면 그 노드로, 사람은 Slack person:<id>와
//   이름·별칭·이메일로 맞추고, 나머지는 <kind>:<정규화 이름>. 사용자 본인(ME)은 person:<내 Slack id> 또는 person:me.
// - 별칭 테이블(kg_alias)이 한 번 맞춘 이름을 기억한다. 근거(kg_evidence)는 (대상, 청크)당 하나.
// - 이슈 상태·결정 내용은 근거 시각이 최신인 것이 이긴다. 이전 값은 history에 남긴다.
// - 기존 노드는 지우지도 덮어쓰지도 않는다(세션·Slack 수집이 쓰는 노드의 props는 그대로). KG 속성은 kg_entities에 따로 둔다.
import { basename } from "node:path";
import { IS_WIN, LOCAL_PROJECT_SQL, isAbsPath, isLocalProjectId } from "../plat.ts";
import { defaultSelfNames, displayUserName, userAliases } from "../config.ts";
import type { Store } from "../store.ts";
import type { Chunk } from "./chunks.ts";
import type { EntityType, Extraction, Relation } from "./extract.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kg_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, evidence INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS kg_entities_kind ON kg_entities(kind, last_seen);
CREATE TABLE IF NOT EXISTS kg_alias (alias TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (alias, kind));
CREATE TABLE IF NOT EXISTS kg_evidence (target TEXT NOT NULL, chunk TEXT NOT NULL, src TEXT NOT NULL, at TEXT NOT NULL, link TEXT, PRIMARY KEY (target, chunk));
CREATE INDEX IF NOT EXISTS kg_evidence_src ON kg_evidence(src);
CREATE TABLE IF NOT EXISTS kg_rels (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  evidence INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (src, rel, dst));
CREATE INDEX IF NOT EXISTS kg_rels_dst ON kg_rels(dst, rel);
`;

export function ensureMergeTables(store: Store) {
  store.db.exec(SCHEMA);
  // refine(엔티티 합치기)가 남기는 표시: 지우지 않고 merged_into에 살아남은 id를 적는다
  const cols = (store.db.prepare("PRAGMA table_info(kg_entities)").all() as any[]).map((c) => c.name);
  if (!cols.includes("merged_into")) store.db.exec("ALTER TABLE kg_entities ADD COLUMN merged_into TEXT");
}

// 합쳐진 id면 살아남은 id로(사슬도 따라간다)
export function canonical(store: Store, id: string): string {
  let cur = id;
  for (let i = 0; i < 8; i++) {
    const r = store.db.prepare("SELECT merged_into m FROM kg_entities WHERE id = ?").get(cur) as any;
    if (!r?.m || r.m === cur) return cur;
    cur = r.m;
  }
  return cur;
}

export type Evidence = { src: string; at: string; link?: string; chunk: string };
export type StatusEntry = { status: string; at: string; src: string };
export type HistoryEntry = { description: string; date?: string; at: string; src: string };
export type EntityProps = {
  description?: string; descAt?: string; aliases: string[];
  status?: string; statusAt?: string; statusHistory?: StatusEntry[];
  date?: string; url?: string; history?: HistoryEntry[];
};
export type KgEntity = { id: string; kind: EntityType; name: string; props: EntityProps; firstSeen: string; lastSeen: string; evidence: number };

// 표시용 슬러그(id)와 비교용 키
export function slug(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/^[#@]+/, "").replace(/[\p{P}\p{S}\s]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
export function normKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// "나"를 가리키는 이름: 기본 대명사 + 설정(user.name · user.aliases) + 이 PC 의 git 이름·계정 이름(config.ts defaultSelfNames)
const SELF_GENERIC = ["me", "나", "사용자"];

export function meId(store: Store): string {
  try {
    const me = (store.db.prepare("SELECT value FROM slack_meta WHERE key = 'me'").get() as any)?.value;
    if (me) return `person:${me}`;
  } catch { /* slack 테이블 없음 */ }
  return "person:me";
}

export function readEntity(store: Store, id: string): KgEntity | undefined {
  const r = store.db.prepare("SELECT * FROM kg_entities WHERE id = ?").get(id) as any;
  return r ? { id: r.id, kind: r.kind, name: r.name, props: JSON.parse(r.props), firstSeen: r.first_seen, lastSeen: r.last_seen, evidence: r.evidence } : undefined;
}

// 이름 → 기존 노드 인덱스(사람: Slack 이름 조각·이메일, 프로젝트: 경로 basename). 병합 한 번에 한 번 만든다.
export class Resolver {
  store: Store;
  me: string;
  persons = new Map<string, string>();
  projects = new Map<string, string>();

  // selfNames: 나를 가리키는 이름들(시험은 직접 넣는다). 기본은 설정 + 이 PC 의 git 이름·계정 이름
  constructor(store: Store, opts: { selfNames?: string[] } = {}) {
    ensureMergeTables(store);
    this.store = store;
    this.me = meId(store);
    for (const n of SELF_GENERIC) this.persons.set(normKey(n), this.me);
    for (const n of opts.selfNames ?? defaultSelfNames()) for (const k of [normKey(n), ...personVariants(n, {})]) if (k) this.persons.set(k, this.me);
    const rows = store.db.prepare("SELECT id, label, props FROM nodes WHERE kind IN ('person', 'project')").all() as any[];
    // 경로가 짧은(대표) 레포가 먼저 자리를 잡게
    rows.sort((a, b) => a.id.length - b.id.length);
    for (const r of rows) {
      const p = JSON.parse(r.props ?? "{}");
      if (p.kg) continue; // KG가 만든 노드는 별칭 테이블로 찾는다
      if (r.id.startsWith("person:")) {
        if (p.bot) continue;
        const keys = personVariants(r.label, p);
        if (p.isMe) for (const k of keys) this.persons.set(k, r.id);
        else for (const k of keys) if (!this.persons.has(k)) this.persons.set(k, r.id);
      } else if (isLocalProjectId(r.id)) {
        const k = normKey(basename(String(p.path ?? r.id.slice(8))));
        if (k && !this.projects.has(k)) this.projects.set(k, r.id);
      }
    }
  }

  alias(key: string, kind: string): string | undefined {
    return (this.store.db.prepare("SELECT id FROM kg_alias WHERE alias = ? AND kind = ?").get(key, kind) as any)?.id;
  }

  resolve(kind: EntityType, names: string[], hint: { cwd?: string } = {}): string {
    return canonical(this.store, this.resolveRaw(kind, names, hint));
  }

  private resolveRaw(kind: EntityType, names: string[], hint: { cwd?: string } = {}): string {
    const keys = [...new Set(names.map(normKey).filter((k) => k.length >= 2))];
    for (const k of keys) { const id = this.alias(k, kind); if (id) return id; }
    if (kind === "person") {
      for (const k of keys) { const id = this.persons.get(k); if (id) return id; }
    }
    if (kind === "project") {
      for (const k of keys) { const id = this.projects.get(k); if (id) return id; }
      // 경로 자체가 이름에 들어 있는 경우
      for (const n of names) if (isAbsPath(n)) { const id = this.projects.get(normKey(basename(n))); if (id) return id; }
      if (hint.cwd && keys.includes(normKey(basename(hint.cwd)))) return `project:${hint.cwd}`;
    }
    return `${kind}:${slug(names[0]) || keys[0] || "unknown"}`;
  }

  // 레포 엔티티가 로컬 프로젝트 노드와 같은 이름이면 그 프로젝트
  projectFor(names: string[]): string | undefined {
    for (const n of names) {
      const id = this.projects.get(normKey(isAbsPath(n) || n.includes("/") || (IS_WIN && n.includes("\\")) ? basename(n.replace(/\.git$/, "")) : n));
      if (id) return canonical(this.store, id);
    }
    return undefined;
  }

  remember(kind: string, names: string[], id: string) {
    const put = this.store.db.prepare("INSERT OR IGNORE INTO kg_alias (alias, kind, id) VALUES (?, ?, ?)");
    for (const k of new Set(names.map(normKey))) if (k.length >= 2) put.run(k, kind, id);
  }
}

function personVariants(label: string, props: any): string[] {
  const out = new Set<string>();
  const add = (s: unknown) => { const k = normKey(String(s ?? "")); if (k.length >= 2) out.add(k); };
  add(label);
  for (const part of String(label).split(/[()\[\]/,|·]/)) add(part);
  // "Jiwoo Kim" ↔ "Kim Jiwoo"
  const words = String(label).replace(/\(.*?\)/g, "").trim().split(/\s+/);
  if (words.length === 2) add(`${words[1]} ${words[0]}`);
  if (props.email) add(String(props.email).split("@")[0]);
  if (props.name) add(props.name);
  if (props.realName) add(props.realName);
  return [...out];
}

export type MergeResult = {
  entities: { id: string; kind: string; name: string; isNew: boolean }[];
  relations: { src: string; rel: Relation; dst: string }[];
};

const KG_KINDS_WITH_SOURCE_LINK = new Set(["project", "issue", "decision", "topic", "doc", "repo"]);

// chunks[i]가 추출 응답의 조각 번호 i+1
export function mergeExtraction(store: Store, ex: Extraction, chunks: Chunk[], resolver = new Resolver(store)): MergeResult {
  const res: MergeResult = { entities: [], relations: [] };
  const ids = new Map<string, string>([["ME", resolver.me]]);
  const db = store.db;
  const tx = (fn: () => void) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };

  tx(() => {
    ensureSelf(store, resolver.me);
    for (const e of ex.entities) {
      const c = chunks[e.chunk - 1];
      if (!c) continue;
      const names = [e.name, ...e.aliases];
      const id = resolver.resolve(e.type, names, { cwd: c.meta.cwd as string | undefined });
      ids.set(e.key, id);
      resolver.remember(e.type, names, id);
      if (id === resolver.me) continue;
      const at = c.end || c.start;
      const ev: Evidence = { src: c.ref, at, link: c.link, chunk: c.id };
      const isNew = upsertEntity(store, id, e.type, e.name, {
        description: e.description, aliases: e.aliases, status: e.status, date: e.date, url: e.url,
      }, ev);
      res.entities.push({ id, kind: e.type, name: e.name, isNew });
      if (KG_KINDS_WITH_SOURCE_LINK.has(e.type)) {
        const where = sourceNode(store, c);
        if (where) addRelation(store, id, "discussed_in", where, ev);
      }
      if (e.type === "repo") {
        const p = resolver.projectFor([e.name, ...e.aliases, ...(e.url ? [e.url] : [])]);
        if (p) addRelation(store, id, "relates_to", p, ev);
      }
    }
    for (const r of ex.relations) {
      const src = ids.get(r.from), dst = ids.get(r.to), c = chunks[r.chunk - 1];
      if (!src || !dst || !c || src === dst) continue;
      addRelation(store, src, r.rel, dst, { src: c.ref, at: c.end || c.start, link: c.link, chunk: c.id });
      res.relations.push({ src, rel: r.rel, dst });
    }
  });
  return res;
}

function ensureSelf(store: Store, me: string) {
  const myName = userAliases()[0] ?? displayUserName(undefined);
  if (!store.node(me)) store.upsertNode(me, "person", myName ? `${myName} (나)` : "나", { kg: true, isMe: true });
}

// 근거 출처 노드: 세션(없으면 최소 노드를 만든다 — 14일보다 오래된 세션) 또는 Slack 채널
function sourceNode(store: Store, c: Chunk): string | undefined {
  if (c.source === "sessions") {
    if (!store.node(c.ref)) store.upsertNode(c.ref, "session", c.label, { kg: true, cwd: c.meta.cwd, tool: c.meta.tool, started: c.start }, c.end || c.start);
    return c.ref;
  }
  const ch = c.meta.channel as string | undefined;
  return ch ? `channel:${ch}` : undefined;
}

function addEvidence(store: Store, target: string, ev: Evidence): boolean {
  const r = store.db.prepare("INSERT OR IGNORE INTO kg_evidence (target, chunk, src, at, link) VALUES (?, ?, ?, ?, ?)")
    .run(target, ev.chunk, ev.src, ev.at, ev.link ?? null);
  return Number(r.changes) > 0;
}

export function addRelation(store: Store, src: string, rel: string, dst: string, ev: Evidence) {
  store.link(src, rel, dst);
  addEvidence(store, `${src}|${rel}|${dst}`, ev);
  const n = Number((store.db.prepare("SELECT count(*) n FROM kg_evidence WHERE target = ?").get(`${src}|${rel}|${dst}`) as any).n);
  store.db.prepare(`INSERT INTO kg_rels (src, rel, dst, first_seen, last_seen, evidence) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(src, rel, dst) DO UPDATE SET first_seen = min(kg_rels.first_seen, excluded.first_seen),
    last_seen = max(kg_rels.last_seen, excluded.last_seen), evidence = excluded.evidence`)
    .run(src, rel, dst, ev.at, ev.at, n);
}

// 반환: 새 엔티티인지
export function upsertEntity(
  store: Store, id: string, kind: EntityType, name: string,
  x: { description?: string; aliases?: string[]; status?: string; date?: string; url?: string }, ev: Evidence,
): boolean {
  id = canonical(store, id);
  const prev = readEntity(store, id);
  const at = ev.at;
  const p: EntityProps = prev?.props ?? { aliases: [] };
  // 이름: 처음 것을 유지하고, 다른 표기는 별칭으로
  const display = prev?.name ?? name;
  const aliases = new Set([...(p.aliases ?? []), ...(x.aliases ?? []), ...(name !== display ? [name] : [])]);
  aliases.delete(display);
  p.aliases = [...aliases].slice(0, 20);

  const newer = !p.descAt || at >= p.descAt;
  if (kind === "decision" && x.description) {
    // 결정은 내용·날짜 이력을 남기고 최신이 이긴다
    const h = p.history ?? [];
    if (!h.some((e) => e.at === at && e.description === x.description)) h.push({ description: x.description, date: x.date, at, src: ev.src });
    h.sort((a, b) => a.at.localeCompare(b.at));
    p.history = h.slice(-10);
    const last = p.history[p.history.length - 1];
    p.description = last.description; p.descAt = last.at;
    if (last.date) p.date = last.date;
  } else if (x.description && newer) {
    p.description = x.description; p.descAt = at;
  }
  if (kind === "issue" && x.status) {
    const h = p.statusHistory ?? [];
    if (!h.some((e) => e.at === at && e.status === x.status)) h.push({ status: x.status, at, src: ev.src });
    h.sort((a, b) => a.at.localeCompare(b.at));
    p.statusHistory = h.slice(-20);
    // 최신 근거가 이긴다. 단 unknown은 아는 값을 덮지 않는다
    const known = p.statusHistory.filter((e) => e.status !== "unknown");
    const cur = (known.length ? known : p.statusHistory)[(known.length ? known : p.statusHistory).length - 1];
    p.status = cur.status; p.statusAt = cur.at;
  }
  if (x.date && kind !== "decision" && !p.date) p.date = x.date;
  if (x.url && (!p.url || newer)) p.url = x.url;

  addEvidence(store, id, ev);
  const evidence = Number((store.db.prepare("SELECT count(*) n FROM kg_evidence WHERE target = ?").get(id) as any).n);
  const first = prev && prev.firstSeen < at ? prev.firstSeen : at;
  const last = prev && prev.lastSeen > at ? prev.lastSeen : at;
  store.db.prepare(`INSERT INTO kg_entities (id, kind, name, props, first_seen, last_seen, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET props = excluded.props, first_seen = excluded.first_seen, last_seen = excluded.last_seen, evidence = excluded.evidence`)
    .run(id, kind, display, JSON.stringify(p), first, last, evidence);

  // 그래프 노드: 기존(수집기가 만든) 노드는 건드리지 않고, KG 소유 노드만 갱신
  const node = store.node(id);
  if (!node || node.props.kg) {
    store.upsertNode(id, kind, display, {
      kg: true, description: p.description, aliases: p.aliases, status: p.status, date: p.date, url: p.url,
      first_seen: first, last_seen: last, evidence,
    }, last);
  }
  return !prev;
}

// stage 2 프롬프트에 넣을 "알려진 이름" — 근거가 많은 것부터, 글자 수 상한
export function knownNames(store: Store, maxChars = 1600): string {
  ensureMergeTables(store);
  const lines: string[] = [];
  let len = 0;
  const add = (l: string) => { if (len + l.length + 1 > maxChars) return false; lines.push(l); len += l.length + 1; return true; };
  const rows = store.db.prepare(`SELECT kind, name, props FROM kg_entities WHERE kind IN ('project', 'repo', 'person') AND merged_into IS NULL
    ORDER BY evidence DESC, last_seen DESC LIMIT 80`).all() as any[];
  const seen = new Set<string>();
  for (const r of rows) {
    const a = (JSON.parse(r.props).aliases ?? []).slice(0, 3);
    seen.add(normKey(r.name));
    if (!add(`- ${r.kind}: ${r.name}${a.length ? ` (${a.join(", ")})` : ""}`)) break;
  }
  // 아직 KG에 없는 로컬 레포 이름
  const projs = store.db.prepare(`SELECT id FROM nodes WHERE kind = 'project' AND ${LOCAL_PROJECT_SQL} ORDER BY updated DESC LIMIT 40`).all() as any[];
  for (const p of projs) {
    const b = basename(p.id.slice(8));
    if (seen.has(normKey(b))) continue;
    seen.add(normKey(b));
    if (!add(`- 로컬 레포: ${b}`)) break;
  }
  return lines.join("\n");
}
