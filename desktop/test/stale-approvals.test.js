// 어제 결정한 승인 카드가 오늘 대화 맨 아래(새 말·답보다 아래)에 박히던 문제 — 카드 자리는 자기 턴·자기 시각, 결정된 여럿은 한 줄로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActions, placeActions, aroundAnswer, foldApprovals, approvalSummary, approvalKind } from '../src/actions.js';
import { placeSessions } from '../src/agents.js';

const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 12, h, m)).toISOString();
const today = (h, m = 0) => new Date(Date.UTC(2026, 9, 13, h, m)).toISOString();
const perm = (id, o = {}) => ({ id, type: 'tool_permission', status: 'done', toolName: 'Bash', card: { icon: '🖥️', title: '셸 명령 실행' }, created: at(8, 40), result: { ok: true, message: '허용했어요' }, ...o });
const ids = (xs) => (xs ?? []).map((a) => a.id);

// 실제 대화 모양: 어제 n=68 답에 붙은 셸 카드들 — 패널은 마지막 100개만 불러와 n=68 이 위로 잘렸다(moreAbove)
const window = [
  { n: 120, role: 'user', text: '아까 거', at: at(13, 0) },
  { n: 121, role: 'assistant', text: '답', at: at(13, 1) },
  { n: 190, role: 'user', text: '운영에 만든 인프라 봐봐', at: today(1, 16) },
  { n: 191, role: 'assistant', text: '인프라 PR 두 개예요', at: today(1, 17) },
];
const stale = normalizeActions([
  perm('s1', { msgN: 68 }), perm('s2', { msgN: 68 }),
  perm('w1', { msgN: 68, toolName: 'Write', card: { icon: '✏️', title: '파일 쓰기 — MEETEE.md' } }),
  perm('x1', { msgN: 61, status: 'expired', card: { icon: '🖥️', title: '클론 결과와 구조 확인' }, result: { ok: false, message: '응답이 없어 취소했어요' } }),
]);

test('위로 잘린 답의 결정된 카드는 맨 아래로 오지 않는다 — 새 말·답이 늘 맨 아래', () => {
  const p = placeActions(stale, window, { moreAbove: true });
  assert.deepEqual(p.orphans, []);
  assert.equal(p.byMsg.size, 0);
  assert.equal(p.before.size, 0); // "이전 말 더 보기"로 그 답을 불러오면 그 답 위에 나온다
  // 그 답까지 불러오면 제자리(그 답 위)
  const older = [{ n: 67, role: 'user', text: 'md 써봐', at: at(8, 31) }, { n: 68, role: 'assistant', text: '정리했어요', at: at(8, 47) }, ...window];
  const q = placeActions(stale, older, { moreAbove: true });
  assert.deepEqual(ids(aroundAnswer(q.byMsg.get(68)).before), ['s1', 's2', 'w1']);
  assert.deepEqual(q.orphans, []); // n=61 은 아직 위로 잘림 — 숨김
});

test('패널을 다시 열어도(같은 데이터) 새 사용자 말은 옛 카드보다 아래 — 붙을 말을 못 찾으면 자기 시각 자리', () => {
  // moreAbove 가 아니어도(예: 붙을 말이 지워짐) 맨 아래가 아니라 시각 자리
  const p = placeActions(stale, window, { moreAbove: false });
  assert.deepEqual(p.orphans, []);
  assert.deepEqual(ids(p.before.get(0)), ['s1', 's2', 'w1', 'x1']); // 어제 08:40 → 어제 13:00 말 앞
  // 새 말을 보낸 뒤(낙관적 사본)에도 그 말은 카드보다 아래
  const sent = [...window, { role: 'user', text: '또 물어볼게', at: today(2, 0), local: true }];
  const r = placeActions(stale, sent, { moreAbove: false });
  assert.deepEqual(r.orphans, []);
  assert.ok([...r.before.keys()].every((i) => i < sent.length - 1));
});

test('답이 안 붙은 카드: 지금 도는 턴(뒤 말 없음)만 맨 아래, 그 뒤 말이 오면 자기 시각 자리로', () => {
  const msgs = [{ n: 1, role: 'user', text: '해줘', at: today(1, 0) }];
  const live = normalizeActions([perm('p', { status: 'pending', created: today(1, 1) }), perm('d', { created: today(1, 1) })]);
  assert.deepEqual(ids(placeActions(live, msgs).orphans), ['p', 'd']);
  const later = [...msgs, { n: 3, role: 'user', text: '다음 말', at: today(2, 0) }, { n: 4, role: 'assistant', text: '답', at: today(2, 1) }];
  const p = placeActions(live, later);
  assert.deepEqual(p.orphans, []);
  assert.deepEqual(ids(p.before.get(1)), ['p', 'd']); // '다음 말' 바로 앞
});

test('답 없이 끝난 턴의 시스템 줄("답을 끝내지 못했어요 …")에 붙은 카드는 그 줄 위', () => {
  const msgs = [{ n: 1, role: 'user', text: '봐봐', at: at(9) }, { n: 2, role: 'system', text: '답을 끝내지 못했어요 — 앱을 다시 켜서 끊겼어요. 다시 물어봐 주세요', at: at(10) }, { n: 3, role: 'user', text: '다시', at: today(1) }];
  const p = placeActions(normalizeActions([perm('a', { msgN: 2 })]), msgs);
  assert.deepEqual(ids(aroundAnswer(p.byMsg.get(2)).before), ['a']);
  assert.deepEqual(p.orphans, []);
});

test('결정된 승인 여럿은 한 줄로: 「🔐 셸 명령 N번 · 파일 쓰기 1번 허용 · 1번 취소」, 기다리는 카드·하나뿐이면 그대로', () => {
  const many = normalizeActions([
    ...Array.from({ length: 14 }, (_, i) => perm(`b${i}`)),
    perm('w', { toolName: 'Write', card: { icon: '✏️', title: '파일 쓰기 — MEETEE.md' } }),
    perm('e', { status: 'expired', card: { icon: '🖥️', title: '클론 결과와 구조 확인' } }),
    perm('p', { status: 'pending' }),
  ]);
  const f = foldApprovals(many);
  assert.equal(f.group.length, 16);
  assert.equal(f.summary, '🔐 셸 명령 14번 · 파일 쓰기 1번 허용 · 1번 취소');
  assert.deepEqual(ids(f.rest), ['p']);
  assert.equal(foldApprovals(normalizeActions([perm('one')])).group, null);
  assert.equal(approvalKind(normalizeActions([perm('k', { toolName: 'mcp__mail__send_mail', card: { icon: '✉️', title: 'mail · send_mail' } })])[0]), 'mail · send_mail');
  assert.equal(approvalSummary(normalizeActions([perm('c', { status: 'cancelled' }), perm('c2', { status: 'cancelled' })])), '🔐 2번 거부');
  // 머지 카드는 묶지 않는다(드물고 중요)
  const m = foldApprovals(normalizeActions([{ id: 'm1', type: 'pr_merge', status: 'done', card: { title: '#1' }, created: at(9) }, perm('q1'), perm('q2')]));
  assert.deepEqual(ids(m.rest), ['m1']);
});

test('작업 세션 카드(askedAt): 답 없이 끝난 턴이면 그 턴의 시스템 줄 아래, 줄도 없으면 다음 사용자 말 앞 — 다음 턴 답 밑·맨 아래로 안 감', () => {
  const s = { runId: 'r', askedAt: at(9, 0, 30), startedAt: at(9, 1), status: 'done', title: 't', last: '' };
  const withLine = [{ role: 'user', text: '고쳐', at: at(9) }, { role: 'system', text: '답을 끝내지 못했어요 — …', at: at(9, 5) }, { role: 'user', text: '다음', at: today(1) }, { role: 'assistant', text: '다음 답', at: today(1, 1) }];
  assert.deepEqual(placeSessions([s], withLine).after.get(1)?.map((x) => x.runId), ['r']);
  const noLine = [{ role: 'user', text: '고쳐', at: at(9) }, { role: 'user', text: '다음', at: today(1) }, { role: 'assistant', text: '다음 답', at: today(1, 1) }];
  const p = placeSessions([s], noLine);
  assert.deepEqual(p.after.get(0)?.map((x) => x.runId), ['r']);
  assert.deepEqual(p.tail, []);
});
