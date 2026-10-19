// 연결 관리 화면용: 연결마다 지금 상태를 한 번에(GET /connections/overview) + Slack 을 앱 안에서 바로 연결(POST /connectors/slack)
// 열쇠·비밀번호는 돌려주지 않는다(연결됨 여부·계정 이름·권한만).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readConfigObject } from "./mail-connect.ts";
import { writeFileAtomic } from "./fs-atomic.ts";

export type SlackInfo = { connected: boolean; team?: string; user?: string; canReply?: boolean; error?: string };
let slackCache: { token: string; at: number; v: SlackInfo } | null = null;

export async function slackInfo(token: string | undefined, f: typeof fetch = fetch): Promise<SlackInfo> {
  if (!token) return { connected: false };
  if (slackCache && slackCache.token === token && Date.now() - slackCache.at < 5 * 60e3) return slackCache.v;
  let v: SlackInfo;
  try {
    const r = await f("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15e3) });
    const j: any = await r.json();
    v = j.ok ? { connected: true, team: j.team, user: j.user, canReply: /(^|,)\s*chat:write(\s*,|$)/.test(r.headers.get("x-oauth-scopes") ?? "") } : { connected: true, error: `Slack 이 열쇠를 받지 않았어요(${j.error}). 다시 연결해 주세요.` };
  } catch (e: any) { v = { connected: true, error: "Slack 에 닿지 못했어요(인터넷 확인)." }; }
  slackCache = { token, at: Date.now(), v };
  return v;
}

// Slack 연결: 사용자 토큰(xoxp-)을 확인하고 config.json connectors.slack 에 저장
export async function connectSlack(configPath: string, b: unknown, f: typeof fetch = fetch): Promise<{ ok: boolean; error?: string } & Partial<SlackInfo>> {
  const token = typeof (b as any)?.token === "string" ? (b as any).token.trim() : "";
  if (!/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) return { ok: false, error: "xoxp- 로 시작하는 User OAuth Token 을 붙여 주세요(xoxb- 봇 토큰이 아니에요)." };
  slackCache = null;
  const info = await slackInfo(token, f);
  if (info.error) return { ok: false, error: info.error };
  const cfg = (readConfigObject(configPath) as any) ?? {};
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileAtomic(configPath, JSON.stringify({ ...cfg, connectors: { ...(cfg.connectors ?? {}), slack: { mode: "api", userToken: token } } }, null, 2) + "\n", { mode: 0o600 });
  return { ok: true, ...info };
}
export function disconnectSlack(configPath: string): { ok: boolean } {
  const cfg = (readConfigObject(configPath) as any) ?? {};
  const connectors = { ...(cfg.connectors ?? {}) };
  delete connectors.slack;
  writeFileAtomic(configPath, JSON.stringify({ ...cfg, connectors }, null, 2) + "\n", { mode: 0o600 });
  slackCache = null;
  return { ok: true };
}

// GitHub: gh 로그인 상태(계정 이름)
export function githubInfo(): Promise<{ installed: boolean; loggedIn: boolean; user?: string }> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 10e3, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, out, errOut) => {
      const text = `${out}\n${errOut}`;
      if (err && (err as any).code === "ENOENT") return resolve({ installed: false, loggedIn: false });
      const m = /Logged in to github\.com (?:account|as) ([\w-]+)/.exec(text);
      resolve({ installed: true, loggedIn: !!m, ...(m ? { user: m[1] } : {}) });
    });
  });
}
export const codexInfo = () => ({ available: existsSync(join(homedir(), ".codex", "sessions")) });
