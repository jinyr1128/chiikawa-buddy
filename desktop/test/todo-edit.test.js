// 할 일 줄 그 자리 고치기(제목·설명): 처음 값 · 늦게 온 설명 채우기 · 키 · 바뀐 것만 패치
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openEdit, fillDescription, editKey, editPatch } from '../src/todo-edit.js';

const T = { id: 'mail:1', title: '견적 회신', description: '줄 설명' };

test('openEdit: 설명은 불러온 상세가 먼저, 없으면 줄 설명, 그것도 없으면 빈칸', () => {
  assert.deepEqual(openEdit(T, { status: 'ok', data: { description: '상세 설명' } }),
    { id: 'mail:1', title: '견적 회신', desc: '상세 설명', descBase: '상세 설명', descTouched: false });
  assert.equal(openEdit(T, { status: 'loading' }).desc, '줄 설명');
  assert.equal(openEdit(T, { status: 'ok', data: { description: '' } }).desc, '줄 설명');
  assert.equal(openEdit(T, null).desc, '줄 설명');
  assert.equal(openEdit({ id: 'a', title: 't' }).desc, '');
  assert.equal(openEdit({ id: '' }), null);
  assert.equal(openEdit(null), null);
});

test('fillDescription: 상세가 늦게 오면 설명을 안 건드렸을 때만 채운다', () => {
  const s = openEdit({ id: 'a', title: 't' });
  const filled = fillDescription(s, '도착한 설명');
  assert.deepEqual([filled.desc, filled.descBase], ['도착한 설명', '도착한 설명']);
  const touched = { ...s, desc: '내가 쓴 것', descTouched: true };
  assert.equal(fillDescription(touched, '도착한 설명'), touched);
  assert.equal(fillDescription(s, ''), s);
  assert.equal(fillDescription(null, 'x'), null);
  // 제목을 고치던 중이어도 설명만 채운다
  assert.equal(fillDescription({ ...s, title: '새 제목' }, 'd').title, '새 제목');
});

test('editKey: 제목 칸 Enter 저장, 설명 칸 Enter·⌘Enter 저장·Shift+Enter 줄바꿈, Esc 취소, 한글 조합 중엔 무시', () => {
  assert.equal(editKey({ key: 'Enter' }, 'title'), 'save');
  assert.equal(editKey({ key: 'Enter', shiftKey: true }, 'title'), 'save');
  assert.equal(editKey({ key: 'Enter', metaKey: true }, 'title'), 'save');
  assert.equal(editKey({ key: 'Enter' }, 'desc'), 'save');
  assert.equal(editKey({ key: 'Enter', metaKey: true }, 'desc'), 'save');
  assert.equal(editKey({ key: 'Enter', ctrlKey: true }, 'desc'), 'save');
  assert.equal(editKey({ key: 'Enter', shiftKey: true }, 'desc'), null);
  assert.equal(editKey({ key: 'Escape' }, 'desc'), 'cancel');
  assert.equal(editKey({ key: 'Escape' }), 'cancel');
  assert.equal(editKey({ key: 'Enter', isComposing: true }, 'title'), null);
  assert.equal(editKey({ key: 'Escape', keyCode: 229 }, 'desc'), null);
  assert.equal(editKey({ key: 'a' }, 'title'), null);
  assert.equal(editKey(null), null);
});

test('editPatch: 바뀐 필드만, 제목은 공백 정리, 빈 제목은 원래대로 두고 안내, 설명 지우면 null', () => {
  const s = openEdit(T);
  assert.deepEqual(editPatch(T, s), { patch: null, notice: null });
  assert.deepEqual(editPatch(T, { ...s, title: '  견적\n 회신 ' }), { patch: null, notice: null });
  assert.deepEqual(editPatch(T, { ...s, title: '견적 회신 보내기' }), { patch: { title: '견적 회신 보내기' }, notice: null });
  assert.deepEqual(editPatch(T, { ...s, desc: '새 설명\r\n둘째 줄' }), { patch: { description: '새 설명\n둘째 줄' }, notice: null });
  assert.deepEqual(editPatch(T, { ...s, title: '새 제목', desc: '새 설명' }), { patch: { title: '새 제목', description: '새 설명' }, notice: null });
  assert.deepEqual(editPatch(T, { ...s, desc: '   ' }), { patch: { description: null }, notice: null });
  const empty = editPatch(T, { ...s, title: '   ', desc: '새 설명' });
  assert.deepEqual(empty.patch, { description: '새 설명' }, '빈 제목이어도 설명은 저장');
  assert.match(empty.notice, /원래 제목/);
  assert.deepEqual(editPatch(T, { ...s, title: '' }).patch, null);
  // 상세에서 불러온 설명이 원래 값: 그대로면 패치 없음
  const fromDetail = openEdit(T, { status: 'ok', data: { description: '상세 설명' } });
  assert.deepEqual(editPatch(T, fromDetail).patch, null);
  assert.deepEqual(editPatch(null, s), { patch: null, notice: null });
});

test('패널: 줄을 두 번 누르거나 Shift+Enter 면 그 자리 편집기, 할 일 팝오버는 없다', () => {
  const p = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(p, /onDouble: \(id\) => startTodoEdit\(id\)/);
  assert.match(p, /if \(e\.shiftKey\) startTodoEdit\(t\.id\)/);
  assert.doesNotMatch(p, /todo-ask\.js|ask-pop|showAsk|todoAsk|todoApply|todoReject/);
  const css = readFileSync(new URL('../renderer/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.ask-pop|\.ask-diff/);
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(pre, /todo-ask|todo-apply|todo-reject/);
});
