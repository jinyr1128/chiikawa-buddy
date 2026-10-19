// npm test — macOS·Linux·Windows 공용(POSIX 의 `TZ=… CY_AGENT_HOME=… node --test` 를 대신한다. 새 의존성 없음).
// 1) tsc -p .(typecheck)  2) TZ=Asia/Seoul · CY_AGENT_HOME=<임시>/cy-agent-test-home-XXXXXX(실행마다 새로) 으로 node --test 'src/**/*.test.ts'
// TZ: Node 는 Windows 에서도 TZ 환경 변수를 ICU 로 따른다(IANA 이름 Asia/Seoul 그대로) — 자식 프로세스 시작 때 넘기므로 확실히 먹는다.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args, env = process.env) => {
  const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status ?? 1;
};

// typescript 의 bin(셸 껍데기 tsc.cmd 를 거치지 않고 node 로 바로)
const tsPkg = join(root, "node_modules", "typescript");
const tscBin = JSON.parse(readFileSync(join(tsPkg, "package.json"), "utf8")).bin.tsc;
const tsc = run([join(tsPkg, tscBin), "-p", "."]);
if (tsc !== 0) process.exit(tsc);

// 테스트 홈은 실행마다 새 임시 폴더(<임시>/cy-agent-test-home-XXXXXX). 예전처럼 고정 폴더 하나를 쓰면
// 여러 워크트리에서 npm test 를 동시에 돌릴 때 서로의 config.json·cy.db 를 읽어 가끔 흔들렸다. 끝나면 지운다
const home = mkdtempSync(join(tmpdir(), "cy-agent-test-home-"));
const env = { ...process.env, TZ: "Asia/Seoul", CY_AGENT_HOME: home };
// node --test 는 glob 을 스스로 푼다(셸 없이 그대로 넘긴다). 뒤에 붙인 인자(npm test -- …)는 node --test 로
const status = run(["--test", ...process.argv.slice(2), "src/**/*.test.ts"], env);
try { rmSync(home, { recursive: true, force: true }); } catch { /* 못 지워도 결과는 그대로 */ }
process.exit(status);
