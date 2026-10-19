import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDaemonHost, portFree, WATCH_MS, FAST_MS, FAST_FOR_MS, STOPPING_MS, KILL_AFTER_MS } from '../src/daemon-host.js';
import { EXIT_PORT_TAKEN } from '../src/bundle.js';

// 가짜 시계·프로세스
function harness({ alive = [false] } = {}) {
  let now = 0;
  let seq = 100;
  const timers = new Map();
  let tid = 0;
  const children = [];
  const logs = [];
  const probes = [...alive];
  const h = {
    children, logs, timers,
    get now() { return now; },
    deps: {
      spawn: () => {
        const c = new EventEmitter();
        c.pid = seq++;
        c.signals = [];
        c.kill = (sig) => { c.signals.push(sig); if (c.dieOn?.includes(sig)) setImmediate(() => c.emit('exit', null, sig)); };
        c.dieOn = ['SIGTERM', 'SIGKILL'];
        children.push(c);
        return c;
      },
      probe: async () => (probes.length > 1 ? probes.shift() : probes[0]),
      now: () => now,
      setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: now + ms, ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
      log: (m) => logs.push(m),
    },
    // 시계를 ms 만큼 돌리며 때가 된 타이머를 부른다
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      now = until;
    },
  };
  return h;
}

test('포트가 비어 있으면 띄우고, 죽으면 1·2·4초… 간격으로 다시 띄운다', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'child');
  assert.equal(h.children.length, 1);
  assert.equal(host.pid, 100);

  // 띄우자마자 죽음 → 1초, 또 → 2초, 그다음 4초
  h.children[0].emit('exit', 1, null);
  assert.equal(host.mode, 'waiting');
  assert.equal([...h.timers.values()][0].ms, 1000);
  await h.advance(1000);
  assert.equal(h.children.length, 2);
  h.children[1].emit('exit', 1, null);
  assert.equal([...h.timers.values()][0].ms, 2000);
  await h.advance(2000);
  h.children[2].emit('exit', null, 'SIGKILL');
  assert.equal([...h.timers.values()][0].ms, 4000);
  await h.advance(4000);
  assert.equal(h.children.length, 4);
  assert.equal(host.restarts, 3);

  // 오래 살다 죽음 → 다시 1초부터
  await h.advance(120_000);
  h.children[3].emit('exit', 1, null);
  assert.equal([...h.timers.values()][0].ms, 1000);
});

test('이미 그 포트에 데몬이 있으면 띄우지 않고 지켜보다(처음엔 2초마다, 1분 뒤엔 1분마다), 사라지면 그때 띄운다', async () => {
  const h = harness({ alive: [true] });
  let calls = 0;
  const probe = h.deps.probe;
  h.deps.probe = () => { calls++; return probe(); };
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'external');
  assert.equal(h.children.length, 0);
  assert.equal([...h.timers.values()][0].ms, FAST_MS);
  await h.advance(FAST_FOR_MS);
  assert.equal(calls, 1 + FAST_FOR_MS / FAST_MS);
  assert.equal([...h.timers.values()][0].ms, WATCH_MS); // 1분 지나면 느리게
  await h.advance(WATCH_MS);
  assert.equal(calls, 2 + FAST_FOR_MS / FAST_MS);
  assert.equal(host.mode, 'external');
  assert.equal(h.children.length, 0);
});

test('앱을 껐다 바로 켬: 꺼지는 중인 옛 데몬이 아직 답해도 몇 초 안에 새로 띄운다', async () => {
  // 옛 데몬: 처음 두 번은 답함(하나는 stopping 표시), 그다음 사라짐
  const h = harness({ alive: [true, 'stopping', false] });
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'external');
  await h.advance(FAST_MS);
  assert.equal(host.mode, 'external');
  assert.equal([...h.timers.values()][0].ms, STOPPING_MS); // 꺼지는 중이라고 하면 더 자주
  await h.advance(STOPPING_MS);
  assert.equal(host.mode, 'child');
  assert.equal(h.children.length, 1);
  assert.ok(h.now <= 5000);
});

test('포트를 못 잡아 끝남(EXIT_PORT_TAKEN): 충돌로 세지 않고 그 포트를 다시 지켜본다', async () => {
  const h = harness({ alive: [false] }); // 다른 프로그램이 포트를 쥐고 있어 /status 로는 시사 데몬이 아님
  const host = createDaemonHost(h.deps);
  await host.start();
  h.children[0].emit('exit', EXIT_PORT_TAKEN, null);
  assert.equal(host.mode, 'port-taken');
  assert.equal(host.failures, 0);
  assert.equal(host.restarts, 0);
  assert.equal([...h.timers.values()][0].ms, FAST_MS);
  // 계속 부딪혀도 간격이 늘지 않고, 1분 넘게 그러면 1분마다로
  for (let i = 0; i < 40; i++) {
    const t = [...h.timers.values()][0];
    await h.advance(t.ms);
    h.children.at(-1).emit('exit', EXIT_PORT_TAKEN, null);
  }
  assert.equal(host.failures, 0);
  assert.equal([...h.timers.values()][0].ms, WATCH_MS);
  assert.equal(h.logs.filter((m) => m.includes('포트를 잡지 못했어요')).length, 1);
  // 포트가 비면 제대로 뜬다 — 그 뒤에 빨리 죽으면 보통 충돌처럼 1초
  const t = [...h.timers.values()][0];
  await h.advance(t.ms);
  assert.equal(host.mode, 'child');
  h.children.at(-1).emit('exit', 1, null);
  assert.equal(host.mode, 'waiting');
  assert.equal([...h.timers.values()][0].ms, 1000);
});

test('시사 데몬이 아닌 프로그램이 포트를 쥐고 있으면(portFree false) 띄우지 않고 2초→1분마다 지켜보다, 비면 띄운다', async () => {
  const h = harness({ alive: [false] });
  let free = false, asked = 0;
  h.deps.portFree = async () => { asked++; return free; };
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'port-taken');
  assert.equal(h.children.length, 0);
  assert.equal([...h.timers.values()][0].ms, FAST_MS);
  await h.advance(FAST_FOR_MS);
  assert.equal(h.children.length, 0); // 1분 동안 하나도 안 띄움(전엔 5초마다 띄웠다가 75 로 끝)
  assert.equal(asked, 1 + FAST_FOR_MS / FAST_MS);
  assert.equal([...h.timers.values()][0].ms, WATCH_MS);
  await h.advance(WATCH_MS * 3);
  assert.equal(h.children.length, 0);
  assert.equal(host.failures, 0);
  assert.equal(h.logs.filter((m) => m.includes('다른 프로그램')).length, 1);
  // 비었다 → 다음 확인 때 띄운다
  free = true;
  await h.advance(WATCH_MS);
  assert.equal(host.mode, 'child');
  assert.equal(h.children.length, 1);
});

test('지켜보던 데몬이 사라졌는데 포트가 아직 안 비었으면(portFree false) 띄우지 않는다 · portFree 가 던지면 비었다고 본다', async () => {
  const h = harness({ alive: [true, false] });
  const answers = [false, true];
  h.deps.portFree = async () => answers.shift();
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'external');
  await h.advance(FAST_MS);
  assert.equal(host.mode, 'port-taken');
  assert.equal(h.children.length, 0);
  await h.advance(FAST_MS);
  assert.equal(host.mode, 'child');

  const h2 = harness({ alive: [false] });
  h2.deps.portFree = async () => { throw new Error('x'); };
  const host2 = createDaemonHost(h2.deps);
  await host2.start();
  assert.equal(host2.mode, 'child');
});

test('다시 띄우기 전에 누가 그 포트를 차지했으면 그쪽을 쓴다', async () => {
  const h = harness({ alive: [false, true] });
  const host = createDaemonHost(h.deps);
  await host.start();
  h.children[0].emit('exit', 0, null);
  await h.advance(1000); // 곧바로 죽음 → 1초
  assert.equal(h.children.length, 1);
  assert.equal(host.mode, 'external');
});

test('stop: SIGTERM 으로 끄고, 그 뒤로는 다시 띄우지 않는다', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  await host.stop();
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(host.mode, 'stopped');
  assert.equal(host.pid, null);
  await h.advance(600_000);
  assert.equal(h.children.length, 1);
});

test('stop: IPC 로 띄웠으면(윈도우) 신호 대신 "shutdown" 메시지, 안 꺼지면 SIGKILL', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  c.connected = true;
  c.sent = [];
  c.send = (m) => { c.sent.push(m); setImmediate(() => c.emit('exit', 0, null)); };
  await host.stop();
  assert.deepEqual(c.sent, ['shutdown']);
  assert.deepEqual(c.signals, []);
  assert.equal(host.mode, 'stopped');

  const h2 = harness();
  const host2 = createDaemonHost(h2.deps);
  await host2.start();
  const c2 = h2.children[0];
  Object.assign(c2, { connected: true, send: () => {}, dieOn: [] }); // 메시지에 안 꺼짐
  const p = host2.stop();
  await h2.advance(KILL_AFTER_MS);
  await p;
  assert.deepEqual(c2.signals, ['SIGKILL']);
});

test('stop: SIGTERM 에 안 꺼지면 기다렸다 SIGKILL', async () => {
  const h = harness();
  const host = createDaemonHost(h.deps);
  await host.start();
  const c = h.children[0];
  c.dieOn = []; // 안 꺼짐
  const p = host.stop();
  await h.advance(KILL_AFTER_MS);
  await p;
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(host.mode, 'stopped');
});

test('띄우기가 실패하면(spawn 예외·pid 없는 error) 간격을 두고 다시 해 본다', async () => {
  const h = harness();
  let fail = 1;
  const spawn = h.deps.spawn;
  h.deps.spawn = () => { if (fail-- > 0) throw new Error('EACCES'); return spawn(); };
  const host = createDaemonHost(h.deps);
  await host.start();
  assert.equal(host.mode, 'waiting');
  await h.advance(2000);
  assert.equal(host.mode, 'child');
  // pid 없이 error 만 오는 경우
  const c = h.children[0];
  c.pid = undefined;
  c.emit('error', new Error('ENOENT'));
  assert.equal(host.mode, 'waiting');
  assert.ok(h.logs.some((m) => m.includes('ENOENT')));
});

test('stop 은 아무것도 안 띄웠어도 바로 끝난다', async () => {
  const h = harness({ alive: [true] });
  const host = createDaemonHost(h.deps);
  await host.start();
  await host.stop();
  assert.equal(host.mode, 'stopped');
  await h.advance(WATCH_MS * 3);
  assert.equal(h.children.length, 0);
});

test('portFree: 누가 listen 중이면 false, 닫힌 포트면 true', async () => {
  const net = await import('node:net');
  const srv = net.createServer((c) => c.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    assert.equal(await portFree(port), false);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(await portFree(port), true);
});

test('main.js 배선: portFree 를 데몬 호스트에 넘긴다', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /^import \{ createDaemonHost, portFree \} from '\.\/src\/daemon-host\.js';$/m);
  const host = main.slice(main.indexOf('daemonHost = createDaemonHost({'));
  assert.match(host.slice(0, 400), /probe: daemonAlive,\s*portFree: \(\) => portFree\(PORT\),/);
});
