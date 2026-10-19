// 개요 > 권한: [항상 허용] 규칙 정리·표시
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePermissionRules, kindOf, ruleUsage, withoutPending, okRuleId } from '../src/permissions.js';

test('규칙 정리: 잘못된 건 버리고, 종류 아이콘·라벨·사용 횟수', () => {
  const rules = normalizePermissionRules([
    { id: 'r1', tool: 'mcp__docs__upload_document', scope: 'docs.upload_document', label: 'docs upload_document', created: '2026-10-12T00:00:00Z', hits: 3, lastUsed: '2026-10-12T03:00:00Z' },
    { id: 'r2', tool: 'Bash', scope: 'npm test', label: '', hits: -1 },
    { id: '../x', tool: 'Bash' }, { id: 'r3' }, null, 'x',
  ]);
  assert.deepEqual(rules.map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(rules[0].kind, { icon: '🔧', name: '연결한 도구' });
  assert.equal(rules[1].label, 'Bash');
  assert.equal(rules[1].hits, 0);
  assert.match(ruleUsage(rules[0]), /^3번 썼어요 · 마지막 10\/12$/);
  assert.equal(ruleUsage(rules[1]), '아직 안 썼어요');
  assert.deepEqual([kindOf('Edit').name, kindOf('Read').name, kindOf('mcp__notion__x').name, kindOf('WebFetch').name], ['파일 편집', '파일 읽기', '연결한 도구', '도구']);
  assert.deepEqual(withoutPending(rules, new Set(['r1'])).map((r) => r.id), ['r2']);
  assert.equal(normalizePermissionRules(undefined).length, 0);
  assert.equal(okRuleId('abc_1'), true);
  assert.equal(okRuleId('a/b'), false);
});
