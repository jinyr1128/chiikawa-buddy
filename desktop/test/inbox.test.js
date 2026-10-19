import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, badgeTitle, inboxSourceLabel } from '../src/inbox.js';
import { SECTIONS, SECTION_LABELS } from '../src/dashboard.js';

test('알림함 배지: 0 은 숨김, 99 넘으면 99+, 툴팁은 출처별 개수', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(120), '99+');
  assert.equal(badgeTitle({ mail: 3, slack: 2, claude: 0 }), '안 읽은 알림: 메일 3 · Slack 2 — 눌러서 보기');
  assert.equal(badgeTitle({}), '');
  assert.equal(inboxSourceLabel('calendar'), '캘린더');
});

test('패널에 알림 탭이 있다', () => {
  assert.ok(SECTIONS.includes('inbox'));
  assert.equal(SECTION_LABELS.inbox, '알림');
});
