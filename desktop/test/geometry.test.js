import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPosition, restorePosition } from '../src/geometry.js';

const size = { width: 360, height: 420 };
const wa = { x: 0, y: 25, width: 1440, height: 800 };

test('기본 위치: 오른쪽 아래, 독 위', () => {
  assert.deepEqual(defaultPosition(wa, size), { x: 1440 - 360 - 16, y: 25 + 800 - 420 });
});

test('저장 위치 복원', () => {
  assert.deepEqual(restorePosition({ x: 100, y: 100 }, [wa], size), { x: 100, y: 100 });
});

test('화면 밖이거나 깨진 값이면 null', () => {
  assert.equal(restorePosition({ x: 5000, y: 100 }, [wa], size), null);
  assert.equal(restorePosition({ x: 'a', y: 1 }, [wa], size), null);
  assert.equal(restorePosition(undefined, [wa], size), null);
});

test('보조 모니터 위 위치', () => {
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(restorePosition({ x: 2000, y: 300 }, [wa, second], size), { x: 2000, y: 300 });
});
