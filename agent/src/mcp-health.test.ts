import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHealth, classify, connectorServerUrls, connectorServers, healthNote, overall, serverUrls } from "./mcp-health.ts";
import { resolveConnectors } from "./connectors.ts";

test("classify: VPN 안내 리다이렉트·오류·정상 응답", () => {
  assert.equal(classify({ status: 302, location: "https://vpn-guide.ax.example.com/" }), "vpn");
  assert.equal(classify({ status: 302, location: "https://login.example.com/" }), "down");
  assert.equal(classify({ status: 502 }), "down");
  assert.equal(classify(new Error("ECONNREFUSED")), "down");
  for (const s of [200, 401, 405, 406]) assert.equal(classify({ status: s }), "ok");
});

test("overall: 하나라도 vpn이면 vpn, 서버 없으면 ok", () => {
  assert.equal(overall({}), "ok");
  assert.equal(overall({ a: "ok", b: "vpn" }), "vpn");
  assert.equal(overall({ a: "down", b: "ok" }), "down");
});

test("McpHealth.check: 서버별 상태 모으기", async () => {
  const h = new McpHealth({
    urls: () => ({ "mail": "https://g/mcp", issues: "https://f/mcp" }),
    fetch: async (u) => ({ status: u.includes("g/") ? 302 : 406, headers: { get: () => "https://vpn-guide.x/" } }),
  });
  const r = await h.check();
  assert.deepEqual(r.servers, { "mail": "vpn", issues: "ok" });
  assert.equal(r.state, "vpn");
  assert.match(healthNote(r)!, /VPN이 꺼져 있어서 MCP 서버\(mail\)/);
});

test("serverUrls: 커넥터가 쓰는 서버의 ~/.claude.json url만(stdio 서버·안 쓰는 서버는 빠짐)", () => {
  const d = mkdtempSync(join(tmpdir(), "cy-h-"));
  const p = join(d, "c.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { mail: { type: "http", url: "https://g/mcp" }, other: { url: "https://x" }, issues: { command: "x" } } }));
  assert.deepEqual(serverUrls(["mail", "issues"], p), { mail: "https://g/mcp" });
  assert.deepEqual(serverUrls(["mail"], join(d, "none.json")), {});
  const conns = resolveConnectors({}, { connectors: { mail: { mode: "mcp", server: "mail" }, calendar: { mode: "mcp", server: "mail" }, issues: { mode: "mcp", server: "issues" } } });
  assert.deepEqual(connectorServers(conns), ["mail", "issues"]);
  assert.deepEqual(connectorServerUrls(conns, p), { mail: "https://g/mcp" });
});

test("한 번 실패로는 끊김 처리 안 함, 연속 2번이면 반영", async () => {
  let fail = true;
  const h = new McpHealth({
    urls: () => ({ "mail": "https://g/mcp", issues: "https://f/mcp" }),
    fetch: async (u) => { if (u.includes("f/") && fail) throw new Error("timeout"); return { status: 401, headers: { get: () => null } }; },
  });
  let r = await h.check();
  assert.equal(r.servers.issues, "ok"); // 첫 실패는 이전 상태 유지
  r = await h.check();
  assert.equal(r.servers.issues, "down");
  assert.equal(r.state, "down");
  assert.match(healthNote(r)!, /MCP 서버\(issues\)에 연결할 수 없어요/);
  fail = false;
  r = await h.check();
  assert.equal(r.servers.issues, "ok");
});
