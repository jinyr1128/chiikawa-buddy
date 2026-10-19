// Claude Code 연동 켜고 끄기: ~/.claude/settings.json 의 hooks 에 "지금 이거 해요" 신호 명령을 넣거나 뺀다.
// hook = Claude Code 가 일할 때(질문 받음·도구 쓰기 전후·알림·끝) 자동으로 실행하는 짧은 명령.
// 여기 넣는 명령은 데몬(POST /claude/hook)에 신호만 보낸다. 앱이 꺼져 있어도 1초 안에 조용히 끝나 Claude 를 막지 않는다.
// 다른 hook 은 건드리지 않고 MARK 가 붙은 우리 것만 넣고 뺀다. 고치기 전 원본을 settings.json.bak-<시각> 으로 남긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARK = 'chiikawa-buddy';
export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export function settingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

export function hookCommand(port) {
  return `curl -s -m 1 -X POST -H 'x-cy-agent: 1' -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/claude/hook >/dev/null 2>&1 || true # ${MARK}`;
}

const ours = (h) => String(h?.command ?? '').includes(MARK);

// 순수 함수: settings 객체 → 우리 hook 을 넣은(on) / 뺀(off) 새 객체
export function withHooks(settings, on, port) {
  const next = { ...(settings ?? {}) };
  const hooks = { ...(next.hooks ?? {}) };
  for (const ev of HOOK_EVENTS) {
    const groups = (Array.isArray(hooks[ev]) ? hooks[ev] : [])
      .map((g) => ({ ...g, hooks: (Array.isArray(g?.hooks) ? g.hooks : []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (on) groups.push({ ...(MATCHER_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: hookCommand(port), timeout: 3 }] });
    if (groups.length) hooks[ev] = groups; else delete hooks[ev];
  }
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

export function hooksInstalled(settings, port) {
  const cmd = hookCommand(port);
  return HOOK_EVENTS.every((ev) => (settings?.hooks?.[ev] ?? []).some((g) => (g?.hooks ?? []).some((h) => h?.command === cmd)));
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')); // 깨진 파일이면 던진다 — 덮어쓰지 않게
}

export function isInstalled(port, file = settingsPath()) {
  try { return hooksInstalled(readSettings(file), port); } catch { return false; }
}

// 반환: { ok, error? }
export function setInstalled(on, port, file = settingsPath()) {
  try {
    const cur = readSettings(file);
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(withHooks(cur, on, port), null, 2) + '\n');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof SyntaxError ? `${file} 형식이 깨져 있어서 건드리지 않았어요` : String(e?.message ?? e) };
  }
}
