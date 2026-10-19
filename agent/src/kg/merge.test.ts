import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Resolver } from "./merge.ts";
import { defaultSelfNames, displayUserName } from "../config.ts";

test("defaultSelfNames: 설정 별칭 + env CY_AGENT_USER_NAME + git 이름·이메일 아이디 + 계정 이름(중복·빈 값 빼고)", () => {
  const names = defaultSelfNames({
    aliases: ["홍길동", "Gildong"],
    env: { CY_AGENT_USER_NAME: " GD " },
    git: { name: "Gildong", email: "gildong.hong@example.com" },
    username: "ghong",
  });
  assert.deepEqual(names, ["홍길동", "Gildong", "GD", "gildong.hong", "ghong"]);
  assert.deepEqual(defaultSelfNames({ aliases: [], env: {}, git: {}, username: null }), []);
});

test("displayUserName: 설정 user.name > env CY_AGENT_USER_NAME > git 이름, 없으면 undefined", () => {
  assert.equal(displayUserName({ name: "홍길동" }, { CY_AGENT_USER_NAME: "GD" }, { name: "Gildong" }), "홍길동");
  assert.equal(displayUserName({ name: "  " }, { CY_AGENT_USER_NAME: "GD" }, { name: "Gildong" }), "GD");
  assert.equal(displayUserName(undefined, {}, { name: "Gildong" }), "Gildong");
  assert.equal(displayUserName(undefined, {}, {}), undefined);
});

test("Resolver: 나를 가리키는 이름(대명사·selfNames·뒤집은 영문 이름)은 모두 나 노드로", () => {
  const store = new Store(":memory:");
  const r = new Resolver(store, { selfNames: ["Gildong Hong", "ghong"] });
  for (const n of ["me", "나", "사용자", "gildonghong", "honggildong", "ghong"]) assert.equal(r.persons.get(n), r.me, n);
  assert.equal(r.persons.get("someoneelse"), undefined);
});
