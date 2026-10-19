// 설정 창 「행동 지침」 — 사용자가 정한 비서의 말투·답 모양·일하는 법(데몬 agent/src/guidelines.ts).
// 순수 로직(IPC 인자 거르기·목록 다듬기) + 그리기(document 를 받아서 — 시험은 가짜 DOM).
// 데몬 GET/POST /guidelines · PUT/DELETE /guidelines/:id (docs/contract.md "행동 지침").

export const SCOPES = ['all', 'chat', 'briefing', 'code'];
export const SCOPE_LABEL = { all: '어디서나', chat: '대화', briefing: '브리핑', code: '코드 작업' };

const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (v) => str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
export const okGuidelineId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const okText = (t) => t.length > 0;

// ---- IPC 인자 거르기(메인) ----
// 추가: { text, scope? } → { text, scope } | null
export function sanitizeGuidelineAdd(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => k !== 'text' && k !== 'scope')) return null;
  const text = oneLine(v.text);
  if (!okText(text)) return null;
  const scope = v.scope === undefined ? 'all' : v.scope;
  return SCOPES.includes(scope) ? { text, scope } : null;
}
// 고치기: { text?, scope?, active? } 중 하나 이상
export function sanitizeGuidelinePatch(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => !['text', 'scope', 'active'].includes(k))) return null;
  const out = {};
  if (v.text !== undefined) {
    const t = oneLine(v.text);
    if (!okText(t)) return null;
    out.text = t;
  }
  if (v.scope !== undefined) {
    if (!SCOPES.includes(v.scope)) return null;
    out.scope = v.scope;
  }
  if (v.active !== undefined) {
    if (typeof v.active !== 'boolean') return null;
    out.active = v.active;
  }
  return Object.keys(out).length ? out : null;
}

// GET /guidelines 의 guidelines → 그릴 것. 프롬프트와 같은 순서(오래된 → 최근, 같으면 id) — 부딪치면 아래쪽이 이긴다
export function shapeGuidelines(list) {
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && typeof g === 'object' && okGuidelineId(g.id) && str(g.text))
    .map((g) => ({ id: g.id, text: g.text, scope: SCOPES.includes(g.scope) ? g.scope : 'all', active: g.active !== false, updated: str(g.updated), fromChat: !!g.sourceThread }))
    .sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
}

export function countText(list) {
  const on = list.filter((g) => g.active).length;
  return list.length ? (on === list.length ? `${on}개` : `${on}/${list.length}개 켜짐`) : '';
}

// ---- 그리기 ----
// doc: document · cy: 프리로드(getGuidelines·addGuideline·editGuideline·deleteGuideline) · flash(text, err?): 저장 알림
// 화면: #gl-list(목록) · #gl-count · #gl-add-text · #gl-add-scope · #gl-add(추가 버튼)
export function mountGuidelines(doc, cy, flash = () => {}) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  let list = [];
  let editing = null; // 고치는 중인 지침 id

  const scopeSelect = (value, onChange) => {
    const sel = el('select', 'gl-scope');
    for (const s of SCOPES) {
      const o = el('option', null, SCOPE_LABEL[s]);
      o.value = s;
      o.selected = s === value;
      sel.append(o);
    }
    sel.value = value;
    if (onChange) sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };

  async function apply(promise, okText) {
    const r = await promise.catch(() => null);
    if (!r?.ok) {
      flash(r?.data?.error ? `저장 못 했어요: ${r.data.error}` : '저장 못 했어요 — 치이카와 매니저에 연결되지 않았어요', true);
      render();
      return false;
    }
    if (Array.isArray(r.data?.guidelines)) list = shapeGuidelines(r.data.guidelines);
    flash(okText);
    render();
    return true;
  }

  function rowEl(g) {
    const row = el('div', `gl-row${g.active ? '' : ' off'}`);
    row.dataset.id = g.id;
    const cb = el('input', 'gl-active');
    cb.type = 'checkbox';
    cb.checked = g.active;
    cb.title = g.active ? '켜짐 — 끄면 프롬프트에 안 넣어요' : '꺼짐';
    cb.setAttribute('aria-label', `${g.text} 켜기`);
    cb.addEventListener('change', () => { cb.disabled = true; apply(cy.editGuideline(g.id, { active: cb.checked }), cb.checked ? '켰어요' : '껐어요'); });
    const main = el('div', 'gl-main');
    if (editing === g.id) {
      const input = el('input', 'gl-edit');
      input.type = 'text';
      input.value = g.text;
      input.setAttribute('aria-label', '지침 고치기');
      const save = () => {
        const p = sanitizeGuidelinePatch({ text: input.value });
        if (!p) { flash('지침을 적어 주세요', true); return; }
        editing = null;
        apply(cy.editGuideline(g.id, p), '고쳤어요');
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { editing = null; render(); }
      });
      const ok = el('button', 'small primary', '저장');
      ok.type = 'button';
      ok.addEventListener('click', save);
      const cancel = el('button', 'small ghost', '취소');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { editing = null; render(); });
      main.append(input, ok, cancel);
    } else {
      const text = el('span', 'gl-text', g.text);
      text.title = '눌러서 고치기';
      text.tabIndex = 0;
      const startEdit = () => { editing = g.id; render(); };
      text.addEventListener('click', startEdit);
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter') startEdit(); });
      main.append(text);
      if (g.fromChat) main.append(el('span', 'gl-src', '대화에서'));
    }
    const scope = scopeSelect(g.scope, (v) => apply(cy.editGuideline(g.id, { scope: v }), `${SCOPE_LABEL[v]}에 적용해요`));
    scope.setAttribute('aria-label', '적용 범위');
    const del = el('button', 'small ghost gl-del', '삭제');
    del.type = 'button';
    del.addEventListener('click', () => { del.disabled = true; apply(cy.deleteGuideline(g.id), '지웠어요'); });
    row.append(cb, main, scope, del);
    return row;
  }

  function render() {
    const box = $('gl-list');
    if (!box) return;
    box.replaceChildren(...(list.length ? list.map(rowEl) : [el('div', 'gl-empty', '아직 없어요. 채팅에서 "앞으로 답은 짧게 해"처럼 말하거나 아래에서 직접 넣어요.')]));
    const c = $('gl-count');
    if (c) c.textContent = countText(list);
    if (editing) box.querySelector?.('.gl-edit')?.focus?.();
  }

  async function load() {
    const r = await cy.getGuidelines().catch(() => null);
    if (r?.ok) { list = shapeGuidelines(r.data?.guidelines); render(); }
    return !!r?.ok;
  }

  const addBtn = $('gl-add'), addText = $('gl-add-text'), addScope = $('gl-add-scope');
  if (addScope && !addScope.children?.length) for (const s of SCOPES) { const o = el('option', null, SCOPE_LABEL[s]); o.value = s; addScope.append(o); }
  async function add() {
    const p = sanitizeGuidelineAdd({ text: addText?.value ?? '', scope: addScope?.value || 'all' });
    if (!p) { flash('지침을 적어 주세요', true); return; }
    if (addBtn) addBtn.disabled = true;
    const ok = await apply(cy.addGuideline(p), '지침에 넣었어요 — 다음 대화부터 따라요');
    if (addBtn) addBtn.disabled = false;
    if (ok && addText) addText.value = '';
  }
  addBtn?.addEventListener('click', add);
  addText?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });

  render();
  return { load, render, add, get list() { return list; }, set editing(id) { editing = id; } };
}
