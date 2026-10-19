// 가짜 데몬용 할 일 규칙(agent/src/todo-rules.ts 흉내, 간단히). 키워드만, 규칙 저장·미리보기·적용·새 할 일 적용.
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
const PRIO_KO = { 1: 'P1 오늘 꼭', 2: 'P2 이번 주', 3: 'P3 참고', 4: '언젠가·백로그(P4)' };

export function createFakeRules(seed = []) {
  let rules = seed.map((r, i) => ({ id: `rule:seed${i}`, enabled: true, created: new Date(Date.now() - (seed.length - i) * 864e5).toISOString(), hits: 0, ...r }));
  let n = 0;
  const summary = (r) => `제목에 ${r.match.keywords.map((k) => `"${k}"`).join('·')} → ${[r.effect.skip ? '자동으로 만들지 않음' : '', r.effect.priority ? PRIO_KO[r.effect.priority] : ''].filter(Boolean).join(', ')}`;
  const matches = (r, t) => r.match.keywords.some((k) => norm(t.title).includes(k));

  return {
    // "앞으로 모든 X는 …" → 규칙 제안. 아니면 null
    proposal(text, focus) {
      if (!/앞으로|항상|모든|다 |이런 건/.test(text)) return null;
      const kw = /모든\s*(\S+?)(?:는|은|들은|들는)?\s/.exec(`${text} `)?.[1] ?? /[A-Za-z]{2,}/.exec(focus.title)?.[0] ?? focus.title.split(/\s+/)[0];
      const low = /낮|백로그|언젠가|안 ?중요|신경/.test(text);
      return {
        text: text.replace(/^야\s*/, '').slice(0, 200),
        match: { keywords: [norm(kw)], description: `제목에 ${kw}` },
        effect: low ? { backlog: true, priority: 4 } : { priority: 3 },
      };
    },
    // 맞는 열린 할 일 전부의 전/후. handled: ops가 이미 다루는 할 일 id
    preview(rule, todos, handled = []) {
      const changes = [], skipped = [];
      for (const t of todos) {
        if (handled.includes(t.id) || !matches(rule, t) || t.priority === rule.effect.priority) continue;
        changes.push({ id: t.id, title: t.title, before: { priority: t.priority, note: t.note ?? null }, after: { priority: rule.effect.priority, note: t.note ?? null } });
      }
      return { proposal: rule, summary: summary(rule), changes, skipped };
    },
    // 저장 + 맞는 기존 할 일 적용. 바뀐 id 목록
    add(rule, todos) {
      const r = { id: `rule:f${++n}`, ...rule, enabled: true, created: new Date().toISOString(), hits: 0 };
      rules.push(r);
      const changed = [];
      for (const t of todos) if (matches(r, t) && r.effect.priority && t.priority !== r.effect.priority) { t.priority = r.effect.priority; t.appliedRule = { id: r.id, text: r.text }; changed.push(t.id); }
      r.hits += changed.length;
      return { rule: r, changed };
    },
    // 새 할 일에 적용(최근 규칙이 이김)
    applyToNew(t) {
      const r = [...rules].reverse().find((x) => x.enabled && matches(x, t) && x.effect.priority);
      if (!r) return t;
      r.hits++;
      return { ...t, priority: r.effect.priority, appliedRule: { id: r.id, text: r.text } };
    },
    list: () => rules.map((r) => ({ id: r.id, text: r.text, summary: summary(r), enabled: r.enabled, hits: r.hits, created: r.created })),
    edit(id, patch) {
      const r = rules.find((x) => x.id === id);
      if (!r) return null;
      if (typeof patch.enabled === 'boolean') r.enabled = patch.enabled;
      if (typeof patch.text === 'string' && patch.text.trim()) r.text = patch.text.trim();
      return r;
    },
    remove(id) {
      const before = rules.length;
      rules = rules.filter((x) => x.id !== id);
      return rules.length < before;
    },
  };
}
