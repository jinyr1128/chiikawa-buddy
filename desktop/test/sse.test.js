import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSEParser, backoffDelay, isEventStream, createSSEGate } from '../src/sse.js';

const collect = () => {
  const out = [];
  const p = createSSEParser((e) => out.push(e));
  return { out, p };
};

test('기본 이벤트 파싱', () => {
  const { out, p } = collect();
  p.push('event: bubble\ndata: {"id":"a"}\n\n');
  assert.deepEqual(out, [{ event: 'bubble', data: '{"id":"a"}', id: '' }]);
});

test('event 없으면 message', () => {
  const { out, p } = collect();
  p.push('data: x\n\n');
  assert.equal(out[0].event, 'message');
});

test('청크 경계가 아무 데나 잘려도 OK', () => {
  const src = 'event: state\ndata: {"mood":"idle"}\n\nevent: clear\ndata: {"id":"z"}\n\n';
  for (let cut = 1; cut < src.length; cut++) {
    const { out, p } = collect();
    p.push(src.slice(0, cut));
    p.push(src.slice(cut));
    assert.equal(out.length, 2, `cut=${cut}`);
    assert.equal(out[1].data, '{"id":"z"}');
  }
});

test('CRLF, CR 줄바꿈 + CR/LF 가 청크로 갈라짐', () => {
  const { out, p } = collect();
  p.push('event: a\r\ndata: 1\r');
  p.push('\n\r\n');
  p.push('data: 2\r\r'); // 끝 \r 은 다음 청크까지 보류
  assert.equal(out.length, 1);
  p.push('data: 3\n\n');
  assert.deepEqual(out.map((e) => [e.event, e.data]), [['a', '1'], ['message', '2'], ['message', '3']]);
});

test('여러 data 줄은 \\n 으로 합침, 콜론 뒤 공백 하나만 제거', () => {
  const { out, p } = collect();
  p.push('data:  a\ndata:b\n\n');
  assert.equal(out[0].data, ' a\nb');
});

test('주석/하트비트, data 없는 블록은 무시', () => {
  const { out, p } = collect();
  p.push(': ping\n\nevent: bubble\n\n');
  assert.equal(out.length, 0);
});

test('id 와 retry', () => {
  let retry = null;
  const out = [];
  const p = createSSEParser((e) => out.push(e), { onRetry: (ms) => { retry = ms; } });
  p.push('id: 7\nretry: 2500\ndata: x\n\nretry: abc\n\n');
  assert.equal(out[0].id, '7');
  assert.equal(p.lastEventId, '7');
  assert.equal(retry, 2500);
});

test('end() 는 미완성 이벤트 버림', () => {
  const { out, p } = collect();
  p.push('data: half');
  p.end();
  p.push('\n\n');
  assert.equal(out.length, 0);
});

test('UTF-8 한글', () => {
  const { out, p } = collect();
  p.push('event: bubble\ndata: {"text":"안녕하세요"}\n\n');
  assert.equal(JSON.parse(out[0].data).text, '안녕하세요');
});

test('backoff: 지수 증가, 상한 30s', () => {
  const j = () => 0.5; // jitter 없음
  assert.equal(backoffDelay(0, { jitter: j }), 1000);
  assert.equal(backoffDelay(1, { jitter: j }), 2000);
  assert.equal(backoffDelay(3, { jitter: j }), 8000);
  assert.equal(backoffDelay(20, { jitter: j }), 30000);
  assert.ok(backoffDelay(0, { jitter: () => 0 }) >= 800);
  assert.ok(backoffDelay(0, { jitter: () => 1 }) <= 1200);
});

test('isEventStream: 2xx · 본문 · text/event-stream 이어야 SSE(그 포트의 다른 프로그램은 아님)', () => {
  assert.equal(isEventStream(true, 'text/event-stream'), true);
  assert.equal(isEventStream(true, 'Text/Event-Stream; charset=utf-8'), true);
  assert.equal(isEventStream(true, 'text/html; charset=utf-8'), false);
  assert.equal(isEventStream(true, 'application/json'), false);
  assert.equal(isEventStream(true, 'text/event-streamx'), false);
  assert.equal(isEventStream(true, null), false);
  assert.equal(isEventStream(false, 'text/event-stream'), false);
  assert.equal(isEventStream(true, 'text/event-stream', false), false);
});

test('createSSEGate: 첫 이벤트가 state 일 때 한 번만 연결됨, 아니면 끊기', () => {
  let n = 0;
  const g = createSSEGate(() => n++);
  assert.equal(g.live, false);
  assert.equal(g.check({ event: 'state', data: '{}' }), 'live');
  assert.equal(g.check({ event: 'bubble', data: '{}' }), 'live');
  assert.equal(n, 1);
  assert.equal(g.live, true);
  const other = createSSEGate(() => n++);
  assert.equal(other.check({ event: 'message', data: 'hi' }), 'reject');
  assert.equal(other.live, false);
  assert.equal(n, 1);
  // 시사 데몬이 실제로 보내는 첫 부분(retry 뒤 state) → 파서·게이트를 거치면 연결됨
  const seen = [];
  const g2 = createSSEGate(() => seen.push('live'));
  const p = createSSEParser((e) => { if (g2.check(e) === 'live') seen.push(e.event); });
  p.push('retry: 3000\n\nevent: state\ndata: {"mood":"idle"}\n\nevent: bubble\ndata: {}\n\n');
  assert.deepEqual(seen, ['live', 'state', 'bubble']);
});

test('main.js 배선: /events 가 SSE 이고 첫 state 가 와야 연결됨 — 그 전엔 setConnected(true)·refreshStatus 없음', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const loop = main.slice(main.indexOf('async function connectLoop()'), main.indexOf('function onSSE('));
  assert.ok(loop.length > 100);
  assert.match(loop, /isEventStream\(res\.ok, type, !!res\.body\)/);
  // 200 만으로 연결됨·attempt=0 하지 않는다: 둘 다 게이트의 onLive 안에서만
  assert.match(loop, /createSSEGate\(\(\) => \{ setConnected\(true\); attempt = 0; \}\)/);
  assert.equal(loop.match(/setConnected\(true\)/g).length, 1);
  assert.equal(loop.match(/attempt = 0/g).length, 1);
  assert.match(loop, /gate\.check\(ev\) === 'live'\) onSSE\(ev\); else ac\.abort\(\)/);
  assert.match(loop, /if \(!gate\?\.live\) retryOverride = null;/); // 남의 retry: 로 재연결을 앞당기지 않는다
  // refreshStatus·loadCharacters 는 setConnected(true) 에서만(연결됨이 바뀔 때)
  const sc = main.slice(main.indexOf('function setConnected(v)'), main.indexOf('async function connectLoop()'));
  assert.match(sc, /if \(v\) refreshStatus\(\);/);
  assert.match(sc, /if \(v\) loadCharacters\(\);/);
});
