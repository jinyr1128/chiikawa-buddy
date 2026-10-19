#!/usr/bin/env node
// Slack 사용자 토큰(xoxp-…)을 치이카와 비서에 연결한다. 토큰은 화면에 보이지 않게 입력받아
// ~/.cy-agent/config.json 의 connectors.slack 에만 저장하고(권한 600), 데몬에 다시 읽으라고 알린다.
// 사용: node ops/connect-slack.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
const CONFIG = path.join(HOME, 'config.json');
const PORT = Number(process.env.CY_AGENT_PORT) || 47823;

function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf.trim()); }
        if (c === '\u0003') { process.stdout.write('\n취소했어요.\n'); process.exit(1); }
        if (c === '\u007f') { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        buf += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

const token = await askHidden('Slack 「User OAuth Token」(xoxp-로 시작)을 붙여넣고 Enter: ');
if (!/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) {
  console.error('xoxp- 로 시작하는 User OAuth Token 이 아니에요. (xoxb- 봇 토큰이 아니라 User 토큰이에요)');
  process.exit(1);
}

// 토큰이 맞는지 확인(어느 워크스페이스·누구인지만 보여 준다)
try {
  const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!j.ok) { console.error(`Slack 이 토큰을 받지 않았어요: ${j.error}`); process.exit(1); }
  console.log(`✅ 확인: ${j.team} 워크스페이스의 ${j.user}`);
} catch (e) {
  console.error('Slack 에 연결하지 못했어요(인터넷 확인):', e?.message ?? e);
  process.exit(1);
}

let cfg = {};
if (fs.existsSync(CONFIG)) {
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')); }
  catch { console.error(`${CONFIG} 형식이 깨져 있어서 건드리지 않았어요.`); process.exit(1); }
  const bak = `${CONFIG}.bak-${Date.now()}`;
  fs.copyFileSync(CONFIG, bak);
  fs.chmodSync(bak, 0o600);
}
cfg.connectors = { ...(cfg.connectors ?? {}), slack: { mode: 'api', userToken: token } };
fs.mkdirSync(HOME, { recursive: true });
const tmp = `${CONFIG}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, CONFIG);
console.log('저장했어요. 치이카와 비서가 Slack 을 다시 읽어요…');

try {
  const r = await fetch(`http://127.0.0.1:${PORT}/connectors/reload`, { method: 'POST', headers: { 'x-cy-agent': '1', 'content-type': 'application/json' }, body: '{}' });
  console.log(r.ok ? '🎉 연결 끝! 몇 분 안에 최근 3일 DM·멘션이 알림함에 들어와요.' : '앱을 한 번 껐다 켜 주세요(메뉴 막대 → 종료 → 다시 열기).');
} catch {
  console.log('치이카와 비서가 꺼져 있어요. 켜면 바로 읽어요.');
}
