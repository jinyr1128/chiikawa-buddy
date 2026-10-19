// 사용자가 다른 에이전트에게 주는 규칙(AGENTS.md·CLAUDE.md)을 cy-agent도 그대로 따르게 프롬프트에 넣는다.
// Claude Code는 CLAUDE.md만 자동으로 읽으므로 AGENTS.md는 여기서 명시적으로 붙인다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_EACH = 12_000;

function read(path: string): string | undefined {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t ? (t.length > MAX_EACH ? t.slice(0, MAX_EACH) + "\n…(생략)" : t) : undefined;
  } catch {
    return undefined;
  }
}

// repo가 주어지면 레포 AGENTS.md까지. 같은 내용은 한 번만.
export function loadInstructions(repo?: string, home = homedir()): string {
  const files = [join(home, "AGENTS.md"), join(home, ".claude", "CLAUDE.md"), ...(repo ? [join(repo, "AGENTS.md")] : [])];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of files) {
    const t = read(f);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(`<instructions source="${f}">\n${t}\n</instructions>`);
  }
  return parts.length ? `# 사용자 작업 규칙 (반드시 따른다)\n${parts.join("\n\n")}` : "";
}
