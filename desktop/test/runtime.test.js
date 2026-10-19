// 앱(dmg·Setup.exe)은 데몬을 Electron 에 든 Node 로 띄운다(ELECTRON_RUN_AS_NODE). 그래서 agent 가 적은 Node(engines)·
// 타입(@types/node)·desktop 이 적은 Node 는 모두 그 Node 의 major 와 같아야 한다 — 다르면 tsc 는 통과하는데 앱에서만 터진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const agentPkg = readJson(join(desktop, '..', 'agent', 'package.json'));
const desktopPkg = readJson(join(desktop, 'package.json'));
const floorMajor = (range) => Number(/^>=\s*(\d+)/.exec(range ?? '')?.[1]);
const AGENT_NODE = floorMajor(agentPkg.engines?.node);

test('런타임: agent engines·@types/node·desktop engines 가 같은 Node major', () => {
  assert.ok(AGENT_NODE > 0, `agent engines.node 를 못 읽음: ${agentPkg.engines?.node}`);
  // ^24.x 처럼 그 major 안에서만 오르는 범위여야 25+ API 가 타입에 안 들어온다
  assert.match(agentPkg.devDependencies['@types/node'], new RegExp(`^[\\^~]${AGENT_NODE}\\.`));
  assert.equal(floorMajor(desktopPkg.engines?.node), AGENT_NODE);
});

// Electron 실행 파일은 npm install 뒤 처음 쓸 때 받는다 — 없으면(받기 전) 건너뛴다. require('electron') 은 그때 받으러 가므로 직접 찾는다
const electronDir = join(desktop, 'node_modules', 'electron');
const electronBin = existsSync(join(electronDir, 'path.txt')) ? join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8')) : null;

test('런타임: 앱에 든 Electron 의 Node major 가 agent engines 와 같다', { skip: !(electronBin && existsSync(electronBin)) && 'Electron 실행 파일이 아직 없음' }, () => {
  const r = spawnSync(electronBin, ['-p', 'process.versions.node'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const shipped = r.stdout.trim();
  assert.equal(Number(shipped.split('.')[0]), AGENT_NODE, `Electron ${desktopPkg.devDependencies.electron} 은 Node ${shipped} — agent/package.json engines·@types/node·desktop engines·ops/install.sh 를 같이 맞춘다`);
});
