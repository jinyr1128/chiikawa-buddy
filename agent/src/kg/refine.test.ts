import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { loadConfig } from "../config.ts";
import { ensureChunkTables } from "./chunks.ts";
import { kgContext, kgSearch } from "./context.ts";
import { addRelation, canonical, ensureMergeTables, readEntity, Resolver, upsertEntity } from "./merge.ts";
import {
  applyStaleRule, buildClusters, mergeEntities, personKeys, projectKeys, readMergeOut, refineAll, refineIncremental, snippets, sureMerges,
} from "./refine.ts";

const cfg = { ...loadConfig({}), models: { code: "x", general: "sonnet-test", light: "haiku" }, kgModel: "haiku" };
const NOW = Date.parse("2026-10-08T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 864e5).toISOString();

function world() {
  const store = new Store(":memory:");
  ensureChunkTables(store);
  ensureMergeTables(store);
  let n = 0;
  const chunk = (at: string, text: string, updated = at) => {
    const id = `c${++n}`;
    store.db.prepare(`INSERT INTO kg_chunks (id, source, ref, part, label, text, hash, chars, start, end, meta, status, updated)
      VALUES (?, 'slack', ?, 0, 'Slack #dev', ?, 'h', ?, ?, ?, '{}', 'done', ?)`).run(id, `message:${id}`, text, text.length, at, at, updated);
    return id;
  };
  const ent = (id: string, kind: any, name: string, at: string, text: string, x: Record<string, any> = {}) => {
    const c = chunk(at, text);
    upsertEntity(store, id, kind, name, { description: `${name} 설명`, ...x }, { src: `message:${c}`, at, chunk: c });
    return c;
  };
  const rel = (s: string, r: string, d: string, at: string) => { const c = chunk(at, `${s} ${d}`); addRelation(store, s, r, d, { src: `message:${c}`, at, chunk: c }); };
  return { store, chunk, ent, rel };
}

// 가짜 Sonnet: 시스템 프롬프트로 단계를 가른다
function fakeModel(opts: { cost?: number; merge?: (prompt: string) => any; issue?: (refs: { ref: string; text: string }[]) => any[]; } = {}) {
  const calls = { merge: 0, issue: 0, summary: 0, models: new Set<string>(), options: [] as any[] };
  const query = ((p: { prompt: string; options: any }) => (async function* () {
    calls.models.add(p.options.model);
    calls.options.push(p.options);
    const sys = String(p.options.systemPrompt);
    let out: any;
    if (sys.includes("중복 판정기")) {
      calls.merge++;
      out = opts.merge ? opts.merge(p.prompt) : { results: [] };
    } else if (sys.includes("이슈 상태 정리기")) {
      calls.issue++;
      const refs = [...p.prompt.matchAll(/<issue ref="(i\d+)"[^>]*>\n([\s\S]*?)\n<\/issue>/g)].map((m) => ({ ref: m[1], text: m[2] }));
      out = { results: opts.issue ? opts.issue(refs) : refs.map((r) => ({ ref: r.ref, status: "open", reason: "살아 있음" })) };
    } else {
      calls.summary++;
      const refs = [...p.prompt.matchAll(/<project ref="(P\d+)">/g)].map((m) => m[1]);
      out = { results: refs.map((ref) => ({ ref, summary: "번역 엔진을 만든다.\n지금은 평가 중이다.", status: "active", keyPeople: [`${ref}.p1`], openIssues: [`${ref}.i1`], recentDecisions: [], nextSteps: ["평가 마무리"] })) };
    }
    yield { type: "result", subtype: "success", structured_output: out, total_cost_usd: opts.cost ?? 0.02, usage: { input_tokens: 1000, output_tokens: 100 }, result: "" };
  })()) as any;
  return { query, calls };
}
const deps = (f: ReturnType<typeof fakeModel>, extra: Record<string, unknown> = {}) =>
  ({ query: f.query, cwd: mkdtempSync(join(tmpdir(), "kg-refine-")), now: () => NOW, parallel: 2, ...extra });

test("personKeys: 호칭·괄호·영한·이메일·Slack id", () => {
  const k = personKeys("Minsu Park (박민수)", ["민수님", "ms.park@example.com", "U0TESTUSER1"]);
  assert.ok(k.keys.includes("박민수") && k.keys.includes("minsupark") && k.keys.includes("parkminsu") && k.keys.includes("민수") && k.keys.includes("mspark"));
  assert.deepEqual(k.givens, ["민수"]);
  assert.deepEqual(k.slackIds, ["U0TESTUSER1"]);
  assert.equal(personKeys("태양님").bare, "태양");
  assert.equal(personKeys("Taeyang Lee (이태양)").bare, undefined);
  assert.ok(projectKeys("repo:notes-app-main", "notes-app-main").includes("notesapp"));
  assert.ok(projectKeys("project:x", "팀 기본 용어집(team glossary)").includes("팀기본용어집"));
});

test("buildClusters: 이름만 엔티티 ↔ Slack 프로필(성+이름), 동명이인 Slack끼리는 안 묶음", () => {
  const { store, ent } = world();
  store.upsertNode("person:U1", "person", "Seojun Kim (김서준)", { slackId: "U1" });
  store.upsertNode("person:U2", "person", "Seojoon Jeon (전서준)", { slackId: "U2" });
  store.upsertNode("person:U3", "person", "Minsu Park (박민수)", { slackId: "U3" });
  store.upsertNode("person:U4", "person", "Minsu Park (박민수)", { slackId: "U4" });
  ent("person:서준", "person", "서준", daysAgo(2), "서준님이 결제했다", { aliases: ["서준님"] });
  const cs = buildClusters(store);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].members.map((m) => m.id).sort(), ["person:U1", "person:U2", "person:서준"]);
});

test("readMergeOut: Slack 프로필을 살리고, 프로필 둘은 합치지 않는다", () => {
  const c = { key: "k", family: "person" as const, members: [
    { id: "person:서준", kind: "person", name: "서준", aliases: [], inKg: true, profile: false, evidence: 3 },
    { id: "person:U1", kind: "person", name: "Seojun Kim (김서준)", aliases: [], inKg: false, profile: true, evidence: 0 },
    { id: "person:U2", kind: "person", name: "Seojoon Jeon (전서준)", aliases: [], inKg: false, profile: true, evidence: 0 },
  ] };
  const d = readMergeOut([c], { results: [{ cluster: 1, merge: [["m1", "m2"]], keepSeparate: ["m3"], reason: "같은 사람" }] });
  assert.deepEqual(d[0].groups, [{ keep: "person:U1", dups: ["person:서준"] }]);
  const d2 = readMergeOut([c], { results: [{ cluster: 1, merge: [["m2", "m3"]], keepSeparate: [], reason: "x" }] });
  assert.deepEqual(d2[0].groups, []);
});

test("mergeEntities: 근거·관계·별칭을 옮기고 merged_into — 검색·해석·병합이 따라간다", () => {
  const { store, ent, rel } = world();
  store.upsertNode("project:/r/trans-engine", "project", "trans-engine", { path: "/r/trans-engine" });
  ent("project:/r/trans-engine", "project", "TRANS 엔진", daysAgo(3), "trans-engine 작업");
  ent("repo:trans-engine", "repo", "trans-engine", daysAgo(1), "trans-engine 레포");
  ent("issue:x", "issue", "번역 오류", daysAgo(1), "번역 오류", { status: "open" });
  rel("issue:x", "relates_to", "repo:trans-engine", daysAgo(1));
  rel("repo:trans-engine", "relates_to", "project:/r/trans-engine", daysAgo(1));
  store.db.prepare("INSERT OR IGNORE INTO kg_alias (alias, kind, id) VALUES ('transengine', 'repo', 'repo:trans-engine')").run();

  assert.deepEqual(sureMerges(store), [{ keep: "project:/r/trans-engine", dup: "repo:trans-engine" }]);
  assert.equal(mergeEntities(store, "project:/r/trans-engine", ["repo:trans-engine"], { by: "rule" }), 1);
  assert.equal(canonical(store, "repo:trans-engine"), "project:/r/trans-engine");
  const keep = readEntity(store, "project:/r/trans-engine")!;
  assert.equal(keep.evidence, 2);
  assert.ok(keep.props.aliases.includes("trans-engine"));
  assert.ok(readEntity(store, "repo:trans-engine"), "지우지 않는다");
  const rels = store.db.prepare("SELECT src, rel, dst FROM kg_rels ORDER BY src").all() as any[];
  assert.deepEqual(rels.map((r) => `${r.src}|${r.rel}|${r.dst}`), ["issue:x|relates_to|project:/r/trans-engine"], "자기 고리는 버린다");
  assert.equal(Number((store.db.prepare("SELECT count(*) n FROM kg_evidence WHERE target LIKE '%repo:trans-engine%'").get() as any).n), 0);
  // 해석·검색·병합
  assert.equal(new Resolver(store).resolve("repo", ["trans-engine"]), "project:/r/trans-engine");
  const hits = kgSearch(store, "trans-engine");
  assert.ok(hits.every((h) => h.id !== "repo:trans-engine"));
  assert.equal(hits[0].id, "project:/r/trans-engine");
  // 옛 id로 들어온 새 근거도 살아남은 쪽에 붙는다
  upsertEntity(store, "repo:trans-engine", "repo", "trans-engine", {}, { src: "s", at: daysAgo(0), chunk: "new" });
  assert.equal(readEntity(store, "project:/r/trans-engine")!.evidence, 3);
});

test("snippets: 이름 주변 짧은 조각만", () => {
  const { store, ent } = world();
  ent("issue:a", "issue", "Redis 발급", daysAgo(1), `${"가".repeat(2000)} 운영용 Redis 발급 요청 ${"나".repeat(2000)}`, { status: "open" });
  const s = snippets(store, "issue:a", ["Redis 발급"]);
  assert.equal(s.length, 1);
  assert.ok(s[0].text.length <= 160 && s[0].text.includes("Redis 발급"));
});

test("refineAll: 합치기 → 이슈 상태(이력 유지, 규칙 stale) → 요약, kgContext가 요약·열린 이슈만", async () => {
  const { store, ent, rel } = world();
  store.upsertNode("person:U1", "person", "Seojun Kim (김서준)", { slackId: "U1" });
  store.upsertNode("project:/r/engine", "project", "engine", { path: "/r/engine" });
  ent("project:/r/engine", "project", "번역 엔진", daysAgo(1), "번역 엔진 작업");
  ent("project:/r/engine", "project", "번역 엔진", daysAgo(2), "번역 엔진 작업 2");
  ent("repo:engine", "repo", "engine", daysAgo(1), "engine 레포");
  ent("person:서준", "person", "서준", daysAgo(1), "서준님이 엔진 작업", { aliases: ["서준님"] });
  rel("person:서준", "works_on", "project:/r/engine", daysAgo(1));
  ent("issue:new", "issue", "평가 지표 정리", daysAgo(2), "평가 지표 정리 중", { status: "in_progress" });
  ent("issue:old", "issue", "옛 버그", daysAgo(40), "옛 버그", { status: "open" });
  ent("issue:done", "issue", "끝난 일", daysAgo(5), "끝난 일 완료", { status: "open" });
  ent("issue:dup", "issue", "평가 지표 정리하기", daysAgo(3), "평가 지표 정리하기", { status: "open" });
  for (const i of ["issue:new", "issue:old", "issue:done", "issue:dup"]) rel(i, "relates_to", "repo:engine", daysAgo(5));

  const f = fakeModel({
    merge: (p) => ({ results: [...p.matchAll(/<cluster n="(\d+)"/g)].map((m) => ({ cluster: Number(m[1]), merge: /서준/.test(p) ? [["m1", "m2"]] : [], keepSeparate: [], reason: "같은 사람" })) }),
    issue: (refs) => refs.flatMap((r) => {
      if (r.text.includes("옛 버그")) return []; // 답 누락 → 규칙(21일)
      if (r.text.includes("끝난 일")) return [{ ref: r.ref, status: "resolved", reason: "완료" }];
      if (r.text.includes("정리하기")) return [{ ref: r.ref, status: "duplicate", duplicateOf: refs.find((x) => x.text.includes("이름: 평가 지표 정리\n"))!.ref, reason: "같은 일" }];
      return [{ ref: r.ref, status: "in_progress", reason: "작업 중" }];
    }),
  });
  const before = kgContext(store, { now: new Date(NOW) });
  assert.match(before, /열린 이슈 [1-4]/);

  const rep = await refineAll(cfg, store, { budgetUsd: 5, deps: deps(f) });
  assert.equal(rep.stopped, undefined);
  assert.deepEqual(f.calls.models, new Set(["sonnet-test"]));
  for (const o of f.calls.options) {
    assert.deepEqual(o.tools, []); assert.deepEqual(o.settingSources, []); assert.equal(o.persistSession, false);
    assert.equal(o.outputFormat.type, "json_schema");
  }
  assert.equal(rep.merges.sure, 1);
  assert.equal(canonical(store, "repo:engine"), "project:/r/engine");
  assert.equal(canonical(store, "person:서준"), "person:U1");
  assert.ok(readEntity(store, "person:U1"), "Slack 프로필이 KG 엔티티가 된다");
  const st = (id: string) => readEntity(store, id)!.props;
  assert.equal(st("issue:new").status, "in_progress");
  assert.equal(st("issue:done").status, "resolved");
  assert.equal(st("issue:dup").status, "duplicate");
  assert.equal((st("issue:dup") as any).duplicateOf, "issue:new");
  assert.equal(st("issue:old").status, "stale");
  assert.ok(st("issue:done").statusHistory!.length >= 2, "이력은 남는다");
  assert.equal(rep.issues.staleByRule, 1);

  const sum = store.db.prepare("SELECT * FROM kg_project_summary").all() as any[];
  assert.equal(sum.length, 1);
  assert.equal(sum[0].id, "project:/r/engine");
  assert.deepEqual(JSON.parse(sum[0].key_people), ["person:U1"]);
  assert.equal(JSON.parse(sum[0].open_issues).length, 1);

  const ctx = kgContext(store, { now: new Date(NOW) });
  assert.match(ctx, /번역 엔진 \[진행\]: 번역 엔진을 만든다\. 지금은 평가 중이다\./);
  assert.match(ctx, /열린 이슈 1\)/);
  assert.ok(!ctx.includes("옛 버그") && !ctx.includes("끝난 일"));
  assert.ok(ctx.length < 2000);

  // 다시 돌리면(완료된 run) 새 run — 이어 하기는 미완료 run에서만
  const calls0 = f.calls.issue;
  await refineAll(cfg, store, { budgetUsd: 5, deps: deps(f) });
  assert.ok(f.calls.issue > calls0);
});

test("refineAll: 예산에 닿으면 멈추고, 다시 돌리면 이어 간다", async () => {
  const { store, ent } = world();
  for (let i = 0; i < 60; i++) ent(`issue:i${i}`, "issue", `이슈 ${i} ${"설명 ".repeat(300)}`, daysAgo(1), `이슈 ${i}`, { status: "open" });
  const f = fakeModel({ cost: 0.05 });
  const r1 = await refineAll(cfg, store, { budgetUsd: 0.08, deps: deps(f, { parallel: 1 }) });
  assert.equal(r1.stopped, "budget");
  assert.ok(r1.costUsd <= 0.1);
  const reviewed1 = r1.issues.reviewed;
  assert.ok(reviewed1 > 0 && reviewed1 < 60);
  const r2 = await refineAll(cfg, store, { budgetUsd: 5, deps: deps(f) });
  assert.equal(r2.stopped, undefined);
  assert.equal(r2.issues.reviewed, 60 - reviewed1, "이미 본 이슈는 다시 보지 않는다");
});

test("dry-run: 계획 + 단계별 샘플 한 번씩, 그래프는 그대로", async () => {
  const { store, ent, rel } = world();
  store.upsertNode("project:/r/engine", "project", "engine", { path: "/r/engine" });
  ent("project:/r/engine", "project", "번역 엔진", daysAgo(1), "번역 엔진");
  ent("project:/r/engine", "project", "번역 엔진", daysAgo(2), "번역 엔진 2");
  ent("repo:engine", "repo", "engine", daysAgo(1), "engine");
  ent("issue:a", "issue", "버그", daysAgo(1), "버그", { status: "open" });
  rel("issue:a", "relates_to", "project:/r/engine", daysAgo(1));
  const f = fakeModel({ cost: 0.03 });
  const r = await refineAll(cfg, store, { dryRun: true, deps: deps(f) });
  assert.equal(r.plan.sureMerges, 1);
  assert.equal(r.plan.issuesToReview, 1);
  assert.equal(r.plan.projectsToSummarize, 1);
  assert.equal(f.calls.issue, 1);
  assert.equal(f.calls.summary, 1);
  assert.ok(r.estimate && r.estimate.usd > 0);
  assert.equal(canonical(store, "repo:engine"), "repo:engine");
  assert.equal(readEntity(store, "issue:a")!.props.status, "open");
  assert.equal(Number((store.db.prepare("SELECT count(*) n FROM kg_project_summary").get() as any).n), 0);
});

test("refineIncremental: 처음엔 워터마크+규칙만, 그다음엔 워터마크 뒤에 근거가 붙은 것만", async () => {
  const { store, ent } = world();
  ent("issue:old", "issue", "옛 이슈", daysAgo(30), "옛 이슈", { status: "open" });
  ent("issue:a", "issue", "이슈 A", daysAgo(2), "이슈 A", { status: "open" });
  const f = fakeModel();
  const r0 = await refineIncremental(cfg, store, { deps: deps(f) });
  assert.equal(f.calls.issue, 0);
  assert.equal(r0.issues.staleByRule, 1);
  assert.equal(readEntity(store, "issue:old")!.props.status, "stale");

  // 워터마크 뒤에 처리된 청크에서 근거가 붙은 이슈만 본다
  const later = new Date(NOW + 3600e3).toISOString();
  ent("issue:b", "issue", "이슈 B", daysAgo(0), "이슈 B", { status: "open" });
  store.db.prepare("UPDATE kg_chunks SET updated = ? WHERE id IN (SELECT chunk FROM kg_evidence WHERE target = 'issue:b')").run(later);
  const f2 = fakeModel({ issue: (refs) => refs.map((r) => ({ ref: r.ref, status: "blocked", reason: "대기" })) });
  const r1 = await refineIncremental(cfg, store, { deps: deps(f2, { now: () => NOW + 2 * 3600e3 }) });
  assert.equal(f2.calls.issue, 1);
  assert.equal(r1.issues.reviewed, 1);
  assert.equal(readEntity(store, "issue:b")!.props.status, "blocked");
  assert.equal(readEntity(store, "issue:a")!.props.status, "open");
});

test("applyStaleRule: 모델이 마지막 근거 뒤에 열림이라 했으면 그대로, 막힘은 건드리지 않는다", () => {
  const { store, ent } = world();
  ent("issue:a", "issue", "A", daysAgo(30), "A", { status: "open" });
  ent("issue:b", "issue", "B", daysAgo(30), "B", { status: "blocked" });
  const e = readEntity(store, "issue:a")!;
  (e.props as any).refined = { status: "open", by: "sonnet", at: daysAgo(1) };
  store.db.prepare("UPDATE kg_entities SET props = ? WHERE id = 'issue:a'").run(JSON.stringify(e.props));
  assert.equal(applyStaleRule(store, NOW), 0);
  assert.equal(readEntity(store, "issue:b")!.props.status, "blocked");
});
