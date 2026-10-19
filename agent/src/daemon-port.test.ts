// 데몬 시작·포트: 포트를 먼저 잡고(이미 쓰이면 EXIT_PORT_TAKEN 으로 끝, cy.db 는 열지 않음) · GET /status 의 daemon·pid·stopping
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bus, DAEMON_ID, EXIT_PORT_TAKEN, type BusHandlers } from "./bus.ts";

const handlers = (extra: Partial<BusHandlers> = {}): BusHandlers => ({
  approve: async () => {}, hold: async () => {}, briefing: async () => {}, dashboard: async () => ({}),
  todoDone: () => true, chat: () => "c1", chatHistory: () => [], ...extra,
});

async function occupy(): Promise<Server> {
  const s = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/plain" }); r.end("not shisa"); });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return s;
}

test("bind: 포트를 이미 누가 쓰면 EADDRINUSE 로 거부(데몬이 죽지 않고 main 이 EXIT_PORT_TAKEN 으로 끝낸다)", async () => {
  const other = await occupy();
  const port = (other.address() as AddressInfo).port;
  try {
    const bus = new Bus();
    await assert.rejects(bus.bind(port), (e: any) => e?.code === "EADDRINUSE");
    assert.equal(bus.server, undefined);
    assert.equal(EXIT_PORT_TAKEN, 75);
  } finally {
    other.close();
  }
});

test("bind 먼저 → 처리기는 나중에: 그 사이 요청은 처리기가 붙을 때까지 기다린다", async () => {
  const bus = new Bus();
  await bus.bind(0);
  const base = `http://127.0.0.1:${(bus.server!.address() as AddressInfo).port}`;
  try {
    const pending = fetch(`${base}/status`);
    await new Promise((r) => setTimeout(r, 50));
    await bus.listen(0, handlers({ status: () => ({ brain: { provider: "local" } }) }));
    const r = await pending;
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.daemon, DAEMON_ID);
    assert.equal(body.pid, process.pid);
    assert.equal(body.brain.provider, "local");
    assert.equal(body.stopping, undefined);
    bus.stopping = true;
    assert.equal((await (await fetch(`${base}/status`)).json()).stopping, true);
  } finally {
    bus.close();
  }
});

test("main.ts: 포트가 이미 쓰이면 cy.db 를 열거나 끊긴 턴을 닫기 전에 EXIT_PORT_TAKEN 으로 끝난다", { timeout: 60_000 }, async () => {
  const other = await occupy();
  const port = (other.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), "cy-port-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CY_AGENT_HOME: home, CY_AGENT_PORT: String(port) };
    delete env.CY_AGENT_DB;
    delete env.CY_AGENT_SUPERVISED;
    const main = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
    const child = spawn(process.execPath, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((ok) => child.on("exit", (c) => ok(c)));
    assert.equal(code, EXIT_PORT_TAKEN, out);
    assert.match(out, /포트 \d+ 를 이미/);
    assert.doesNotMatch(out, /at .*bus\.ts/); // 스택 없이 한 줄
    assert.equal(existsSync(join(home, "cy.db")), false);
  } finally {
    other.close();
    rmSync(home, { recursive: true, force: true });
  }
});
