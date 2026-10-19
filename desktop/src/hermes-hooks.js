// Hermes Agent 연동 켜고 끄기: ~/.hermes/config.yaml 에 셸 hook 블록을 넣고(우리 표시 줄 사이만), Hermes 승인 목록
// (~/.hermes/shell-hooks-allowlist.json)에 우리 스크립트 하나만 승인으로 남긴다(Hermes 는 처음 보는 hook 을 터미널에서 묻는데, 데스크톱 앱엔 물을 곳이 없다).
// 스크립트(~/.cy-agent/hooks/hermes-hook.sh)는 받은 신호를 치이카와 매니저(POST /hermes/hook)에 넘기기만 하고, 앱이 꺼져 있어도 1초 안에 조용히 끝난다.
// 고치기 전 원본은 .bak-<시각> 으로 남긴다. 사용자가 직접 쓴 hooks: 가 이미 있으면 건드리지 않고 알려 준다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HERMES_EVENTS = ['pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call', 'api_request_error', 'on_session_end'];
const START = '# chiikawa-buddy:hermes-start (치이카와 매니저 연동 — 이 블록을 지우면 연동이 꺼져요)';
const END = '# chiikawa-buddy:hermes-end';

export function hermesPaths(home = os.homedir()) {
  return {
    hermes: path.join(home, '.hermes'),
    config: path.join(home, '.hermes', 'config.yaml'),
    allow: path.join(home, '.hermes', 'shell-hooks-allowlist.json'),
    script: path.join(home, '.cy-agent', 'hooks', 'hermes-hook.sh'),
  };
}
export const hermesAvailable = (home) => fs.existsSync(hermesPaths(home).config);

export function hookBlock(script) {
  const lines = [START, 'hooks:'];
  for (const ev of HERMES_EVENTS) lines.push(`  ${ev}:`, `    - command: ${script}`, '      timeout: 5');
  lines.push(END);
  return lines.join('\n') + '\n';
}
const stripBlock = (text) => text.replace(new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`), '\n');

export function isInstalled(home) {
  const p = hermesPaths(home);
  try { return fs.readFileSync(p.config, 'utf8').includes(START) && fs.existsSync(p.script); } catch { return false; }
}

const backup = (f) => { if (fs.existsSync(f)) { const b = `${f}.bak-${Date.now()}`; fs.copyFileSync(f, b); fs.chmodSync(b, 0o600); } };
const writeAtomic = (f, text, mode) => { const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, text, { mode }); fs.renameSync(t, f); };

// 반환: { ok, error? }
export function setInstalled(on, port, home) {
  const p = hermesPaths(home);
  try {
    if (!fs.existsSync(p.config)) return { ok: false, error: 'Hermes 가 이 맥에 없어요(~/.hermes/config.yaml).' };
    const cur = fs.readFileSync(p.config, 'utf8');
    const without = stripBlock(cur);
    if (on && /^hooks:/m.test(without)) return { ok: false, error: 'Hermes config.yaml 에 직접 넣은 hooks: 가 이미 있어서 건드리지 않았어요. 그 블록에 우리 스크립트를 추가해 주세요: ' + p.script };
    // 1) 스크립트
    if (on) {
      fs.mkdirSync(path.dirname(p.script), { recursive: true });
      writeAtomic(p.script, `#!/bin/sh\n# 치이카와 매니저: Hermes hook 신호를 앱에 넘긴다(앱이 꺼져 있어도 조용히 끝)\ncurl -s -m 1 -X POST -H 'x-cy-agent: 1' -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hermes/hook >/dev/null 2>&1\nexit 0\n`, 0o755);
    }
    // 2) config.yaml
    backup(p.config);
    const body = without.replace(/\n*$/, '\n');
    writeAtomic(p.config, on ? body + hookBlock(p.script) : body, 0o600);
    // 3) 승인 목록(우리 스크립트만 넣고 빼기)
    let allow = { approvals: [] };
    if (fs.existsSync(p.allow)) { try { allow = JSON.parse(fs.readFileSync(p.allow, 'utf8')); } catch { return { ok: false, error: 'Hermes 승인 목록 파일 형식이 깨져 있어서 건드리지 않았어요.' }; } backup(p.allow); }
    const rest = (Array.isArray(allow.approvals) ? allow.approvals : []).filter((e) => e?.command !== p.script);
    const mtime = on ? new Date(fs.statSync(p.script).mtimeMs).toISOString() : null;
    allow.approvals = on ? [...rest, ...HERMES_EVENTS.map((event) => ({ event, command: p.script, approved_at: new Date().toISOString(), script_mtime_at_approval: mtime }))] : rest;
    writeAtomic(p.allow, JSON.stringify(allow, null, 2) + '\n', 0o600);
    if (!on) fs.rmSync(p.script, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
