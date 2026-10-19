import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRA_MCPS, extraMcpsForPlan } from '../src/mcp-catalog.js';

const ALREADY = new Set(['slack', 'calendar', 'mail', 'gmail', 'github', 'google-calendar', 'ms-365']);

test('EXTRA_MCPS: 항목이 있고, 링크는 https만, kid 문장이 비어 있지 않다', () => {
  assert.ok(Array.isArray(EXTRA_MCPS));
  assert.ok(EXTRA_MCPS.length > 0, '목록이 비어 있음');
  const ids = new Set();
  for (const item of EXTRA_MCPS) {
    assert.equal(typeof item.id, 'string', 'id');
    assert.ok(item.id.trim(), 'id가 비어 있음');
    assert.ok(!ids.has(item.id), `id 중복: ${item.id}`);
    ids.add(item.id);
    assert.ok(!ALREADY.has(item.id), `이미 있는 연결이 들어옴: ${item.id}`);
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.trim(), `${item.id} title`);
    assert.equal(typeof item.kid, 'string');
    assert.ok(item.kid.trim(), `${item.id} kid 문장이 비어 있음`);
    assert.equal(typeof item.youCan, 'string');
    assert.ok(item.youCan.trim(), `${item.id} youCan`);
    assert.equal(item.readOnly, true, item.id);
    assert.ok(Array.isArray(item.links) && item.links.length > 0, `${item.id} links`);
    for (const link of item.links) {
      assert.equal(typeof link.href, 'string');
      assert.match(link.href, /^https:\/\//, link.href);
      assert.equal(new URL(link.href).protocol, 'https:', link.href);
      assert.equal(typeof link.text, 'string');
      assert.ok(link.text.trim(), link.href);
    }
  }
});

test('extraMcpsForPlan: 코딩 도구가 있는 플랜만 목록을 준다', () => {
  assert.equal(extraMcpsForPlan('calendar').length, 0);
  assert.equal(extraMcpsForPlan('chat').length, 0);
  assert.equal(extraMcpsForPlan('tools').length, EXTRA_MCPS.length);
  assert.equal(extraMcpsForPlan('code').length, EXTRA_MCPS.length);
  assert.equal(extraMcpsForPlan('nope').length, 0);
});
