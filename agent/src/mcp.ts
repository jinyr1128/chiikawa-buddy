// Claude Code에 등록한 사용자 범위 MCP 서버(`~/.claude.json`의 mcpServers)를 찾는다.
// 커넥터 mode: "mcp" 일 때 서버 존재 확인·경량 릴레이(캘린더 동기화)가 이 설정을 쓴다.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.claude.json 을 JSON 으로. 문자열로 만들 수 없을 만큼 큰 파일(512MB 넘음)은 읽지 않는다 —
// 앱(Electron)의 Node 는 너무 큰 파일을 readFileSync 하면 오류 대신 프로세스째 죽는다
export function readClaudeJson(path = join(homedir(), ".claude.json")): any {
  if (statSync(path).size > 0x1fffffe8) throw new Error("too large");
  return JSON.parse(readFileSync(path, "utf8"));
}

// ~/.claude.json 에 그 이름의 사용자 범위 MCP 서버가 등록돼 있는지(stdio·http 모두)
export function hasUserMcpServer(name: string): boolean {
  try {
    const j = readClaudeJson();
    return !!j?.mcpServers?.[name];
  } catch { return false; }
}

// ~/.claude.json 의 사용자 범위 MCP 서버 설정(url 이 있는 것만)
export function userMcpServer(name: string): Record<string, unknown> | undefined {
  try {
    const j = readClaudeJson();
    const s = j?.mcpServers?.[name];
    return s && typeof s === "object" && typeof s.url === "string" ? s : undefined;
  } catch { return undefined; }
}

// 경량 릴레이용 SDK 옵션: 그 서버 하나만(strict) 붙이거나, 설정을 못 찾으면 사용자 설정 전체를 읽는다
export function serverOptions(name: string, url?: string):
  | { settingSources: []; strictMcpConfig: true; mcpServers: Record<string, any> }
  | { settingSources: ["user"] } {
  const server = url ? { type: "http", url } : userMcpServer(name);
  return server
    ? { settingSources: [], strictMcpConfig: true, mcpServers: { [name]: server } }
    : { settingSources: ["user"] };
}

// ~/.claude.json 에 등록된 MCP 서버 이름 전부(사용자 범위 + 폴더별 로컬 범위). 브리핑·채팅에서 숨길 서버를 고를 때 쓴다
export function registeredMcpServerNames(path = join(homedir(), ".claude.json")): string[] {
  try {
    const j = readClaudeJson(path);
    const out = new Set<string>(Object.keys(j?.mcpServers ?? {}));
    for (const p of Object.values((j?.projects ?? {}) as Record<string, any>)) for (const k of Object.keys(p?.mcpServers ?? {})) out.add(k);
    return [...out];
  } catch { return []; }
}
