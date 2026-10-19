// 채팅 슬래시 명령(Claude Code 처럼 `/code-review high`). 목록은 SDK 가 알려 준 것(사용자·프로젝트 명령·스킬·플러그인·MCP 프롬프트).
// 목록을 얻을 땐 모델 턴을 쓰지 않는다: 입력을 기다리는 스트리밍 query 를 띄워 supportedCommands() 만 읽고 바로 닫는다.
// 터미널 UI 에만 뜻이 있는 명령(model·clear·config…)은 뺀다 — 그런 `/말`은 모르는 명령처럼 보통 채팅으로 간다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HOME_DIR } from "./config.ts";

export type SlashCommand = { name: string; description: string; argumentHint: string };
type SdkCommand = { name: string; description?: string; argumentHint?: string; aliases?: string[]; builtin?: boolean };
export type LoadCommands = () => Promise<SdkCommand[]>;

// 터미널·세션 화면 전용이라 채팅에선 뜻이 없는 것(한 번 묻고 끝나는 세션이라 세션 상태를 바꾸는 것도)
export const EXCLUDED = new Set([
  "model", "permissions", "resume", "continue", "login", "logout", "exit", "quit", "clear", "reset", "new", "config", "settings",
  "theme", "vim", "terminal-setup", "statusline", "ide", "doctor", "help", "color", "focus", "heapdump", "compact", "context",
  "rename", "reload-plugins", "reload-skills", "fast", "effort", "autocompact", "output-style", "advisor", "mcp", "import",
  "agents", "add-dir", "memory", "hooks", "plugin", "plugins", "status", "cost", "usage", "stats", "extra-usage", "usage-credits",
  "recap", "goal", "rewind", "export", "copy", "release-notes", "bug", "feedback", "privacy-settings", "upgrade",
  "install-github-app", "install-slack-app", "migrate-installer", "keybindings", "sandbox", "todos", "tasks", "bashes",
  "auto-mode-setup", "list-agents", "debug", "loop", "workflow-launch-exec", "skill-doctor",
]);

// MCP 프롬프트는 이름 끝에 " (MCP)" 가 붙어 온다 — 입력하는 이름은 그 앞까지
const cleanName = (n: string) => n.replace(/\s*\(MCP\)\s*$/, "").trim();

// SDK 목록 → 채팅에서 쓸 것만(이름 겹치면 Claude Code 것 먼저, 그다음 먼저 온 것)
export function usableCommands(raw: SdkCommand[], terminal: string[] = []): { commands: SlashCommand[]; names: Set<string> } {
  const skip = new Set([...EXCLUDED, ...terminal.map((t) => t.toLowerCase())]);
  const sorted = [...raw].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin));
  const seen = new Map<string, SlashCommand>(), names = new Set<string>();
  for (const c of sorted) {
    const name = typeof c?.name === "string" ? cleanName(c.name) : "";
    const key = name.toLowerCase();
    if (!name || /\s/.test(name) || name.startsWith("_") || skip.has(key) || seen.has(key)) continue;
    seen.set(key, { name, description: String(c.description ?? "").trim(), argumentHint: String(c.argumentHint ?? "").trim() });
    names.add(key);
    for (const a of c.aliases ?? []) if (typeof a === "string" && !skip.has(a.toLowerCase())) names.add(cleanName(a).toLowerCase());
  }
  // 보여 줄 순서는 SDK 가 준 순서
  const order = raw.map((c) => (typeof c?.name === "string" ? cleanName(c.name).toLowerCase() : ""));
  const commands = [...seen.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, c]) => c);
  return { commands, names };
}

// `/이름` 으로 시작하면 그 이름(뒤는 공백·줄바꿈이거나 끝). 아니면 null
export function slashName(text: string): string | null {
  const m = /^\/([\w][\w:.-]*)(?=\s|$)/.exec(text.trimStart());
  return m ? m[1] : null;
}

// 목록 캐시: 처음 물을 때 한 번 불러오고 10분 지나면 다음 요청 때 다시. 불러오기 실패면 예전 것(없으면 빈 목록)
export class SlashCommands {
  private cache?: { at: number; commands: SlashCommand[]; names: Set<string> };
  private loading?: Promise<void>;
  private load: LoadCommands;
  private ttlMs: number;
  private now: () => number;
  constructor(load: LoadCommands, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.load = load; this.ttlMs = opts.ttlMs ?? 10 * 60_000; this.now = opts.now ?? Date.now;
  }

  private async fresh() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache;
    this.loading ??= this.load()
      .then((raw) => { this.cache = { at: this.now(), ...usableCommands(Array.isArray(raw) ? raw : []) }; })
      .catch((e) => {
        console.error("[cy-agent] 슬래시 명령 목록 실패:", e?.message ?? e);
        if (this.cache) this.cache.at = this.now(); // 실패해도 10분은 예전 것으로(매 요청마다 다시 띄우지 않게)
      })
      .finally(() => { this.loading = undefined; });
    await this.loading;
    return this.cache;
  }

  async list(): Promise<SlashCommand[]> {
    return (await this.fresh())?.commands ?? [];
  }

  // 채팅 말이 아는 명령으로 시작하면 그 이름, 아니면 null(보통 채팅)
  async match(text: string): Promise<string | null> {
    const name = slashName(text);
    if (!name) return null;
    const c = await this.fresh();
    return c?.names.has(name.toLowerCase()) ? name : null;
  }
}

type SdkQuery = typeof query;

// SDK 에게 명령 목록만 묻는다 — 프롬프트를 보내지 않으니 모델 턴(토큰)이 없다. cwd·설정은 슬래시 채팅과 같게
export async function loadCommands(opts: { cwd?: string; query?: SdkQuery; timeoutMs?: number } = {}): Promise<SdkCommand[]> {
  const cwd = opts.cwd ?? join(HOME_DIR, "brain");
  mkdirSync(cwd, { recursive: true });
  const ac = new AbortController();
  const stopped = new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true }));
  async function* idle(): AsyncGenerator<SDKUserMessage> { await stopped; } // 입력을 끝내 보내지 않는다
  const q = (opts.query ?? query)({ prompt: idle(), options: { cwd, settingSources: ["user", "project"], abortController: ac, permissionMode: "dontAsk" } });
  const drain = (async () => { try { for await (const _ of q) { /* 훅 알림 등 — 버린다 */ } } catch {} })();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("명령 목록 시간 초과")), opts.timeoutMs ?? 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch {}
    ac.abort();
    await drain;
  }
}
