import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AttachmentStore, ATTACH_ERR, ATTACH_LIMITS, attachmentInput, attachmentRef, classify, cleanName, safeName, type Attachment } from "./attachments.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { Chat, chatPrompt, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";
import { promptInput } from "./brain.ts";
import { Bus, type BusHandlers } from "./bus.ts";
import { isAutoAllowed } from "./permissions.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // docx·xlsx = zip
const tmp = () => mkdtempSync(join(tmpdir(), "cy-att-"));
const noShrink = () => false;

test("attachments: 종류 가르기 — 내용(첫 바이트) > 확장자", () => {
  assert.deepEqual(classify("a.png", "image/png", PNG), { kind: "image", mime: "image/png" });
  assert.deepEqual(classify("사진.JPG", "", JPG), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(classify("a.jpg", "image/jpeg", PNG), { kind: "image", mime: "image/png" }, "확장자가 틀려도 실제 형식");
  assert.deepEqual(classify("doc.pdf", "application/pdf", PDF), { kind: "pdf", mime: "application/pdf" });
  assert.equal(classify("data.csv", "text/csv", Buffer.from("a,b\n1,2")).kind, "text");
  assert.equal(classify("main.ts", "", Buffer.from("export const x = 1;")).kind, "text");
  assert.equal(classify("x.json", "application/json", Buffer.from('{"a":1}')).kind, "text");
  assert.equal(classify("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ZIP).kind, "file");
  assert.equal(classify("fake.png", "image/png", Buffer.from("not an image")).kind, "file", "그림 아닌 .png 는 그냥 파일");
  assert.equal(classify("fake.png", "image/png", Buffer.from("not an image")).mime, "application/octet-stream");
  assert.equal(classify("bin.txt", "text/plain", Buffer.from([0x61, 0, 0x62])).kind, "file", "NUL 이 있으면 글이 아니다");
  assert.equal(classify("bad.txt", "text/plain", Buffer.from([0xc3, 0x28])).kind, "file", "깨진 UTF-8");
});

test("attachments: 이름 — 경로 조각·제어 문자 걷기, 저장 이름은 셸에 안전하게", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("C:\\Users\\me\\보고서 최종.docx"), "보고서 최종.docx");
  assert.equal(cleanName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(safeName("보고서 최종 (1).docx"), "보고서_최종_1_.docx");
  assert.equal(safeName(".hidden"), "hidden");
  assert.equal(safeName("$(rm -rf).sh"), "rm_-rf_.sh");
  assert.equal(safeName("///"), "file");
});

test("attachments: 올리기 → 보내기 전 검사 → 대화 폴더로 옮기기, 크기·개수 한도", () => {
  const dir = tmp();
  const st = new AttachmentStore(dir, noShrink);
  const a = st.stage("화면 캡처.png", "image/png", PNG);
  assert.ok(!("error" in a));
  assert.equal(a.kind, "image");
  assert.equal(a.size, PNG.length);
  assert.match(a.file, /^[0-9a-f-]{36}-화면_캡처\.png$/);
  assert.deepEqual(st.stage("", "", PNG), { error: ATTACH_ERR.badName });
  assert.deepEqual(st.stage("empty.txt", "text/plain", Buffer.alloc(0)), { error: ATTACH_ERR.empty });
  const huge = st.stage("big.bin", "", Buffer.alloc(60 * 1024 * 1024)); // 크기 상한 없음
  assert.ok(!("error" in huge));

  assert.equal(st.check([a.id]), undefined);
  assert.equal(st.check(["00000000-0000-4000-8000-000000000000"]), ATTACH_ERR.missing);
  assert.equal(st.check(Array.from({ length: 30 }, () => a.id)), undefined); // 개수 상한 없음
  const big2 = st.stage("b2.bin", "", Buffer.alloc(60 * 1024 * 1024));
  assert.ok(!("error" in huge) && !("error" in big2));
  assert.equal(st.check([huge.id, big2.id]), undefined); // 합 상한 없음

  const [got] = st.claim([a.id], "thread-1");
  assert.equal(got.name, "화면 캡처.png");
  assert.ok(existsSync(join(dir, "thread-1", got.file)));
  assert.equal(st.staged(a.id), undefined, "옮기면 임시 보관에서 빠진다");
  assert.throws(() => st.claim([a.id], "thread-1"), new RegExp(ATTACH_ERR.missing));
  assert.equal(st.resolve("thread-1", got.file)?.endsWith(got.file), true);
  st.removeThread("thread-1");
  assert.equal(existsSync(join(dir, "thread-1")), false);
});

test("attachments: 하루 넘은 임시 첨부는 치운다", () => {
  const dir = tmp();
  const st = new AttachmentStore(dir, noShrink);
  const old = st.stage("old.txt", "text/plain", Buffer.from("x"), new Date("2026-01-01T00:00:00Z"));
  assert.ok(!("error" in old));
  st.sweep(new Date("2026-01-03T00:00:00Z"));
  assert.equal(st.staged(old.id), undefined);
});

test("attachments: 큰 그림·HEIC 는 줄여서(sips) JPEG 로, 못 줄이면 그대로 두고 경로만", () => {
  const dir = tmp();
  const shrink = (_src: string, dst: string) => { writeFileSync(dst, JPG); return true; };
  const st = new AttachmentStore(dir, shrink);
  const big = Buffer.concat([PNG, Buffer.alloc(ATTACH_LIMITS.image)]);
  const a = st.stage("huge.png", "image/png", big);
  assert.ok(!("error" in a));
  assert.deepEqual([a.kind, a.mime, a.size], ["image", "image/jpeg", JPG.length]);
  assert.match(a.file, /-huge\.jpg$/);
  const h = st.stage("IMG_0001.HEIC", "image/heic", Buffer.from("ftypheic...."));
  assert.ok(!("error" in h));
  assert.equal(h.kind, "image");
  const st2 = new AttachmentStore(tmp(), noShrink);
  const h2 = st2.stage("IMG_0002.heic", "image/heic", Buffer.from("ftypheic...."));
  assert.ok(!("error" in h2));
  assert.equal(h2.kind, "file");
  assert.ok(st2.staged(h2.id), "못 줄여도 원본은 남는다");
});

test("attachments: 경로 확인 — 첨부 폴더 밖·모양이 틀린 건 못 읽는다", () => {
  const dir = tmp();
  const st = new AttachmentStore(dir, noShrink);
  const a = st.stage("a.txt", "text/plain", Buffer.from("hi"));
  assert.ok(!("error" in a));
  const [got] = st.claim([a.id], "t1");
  assert.ok(st.resolve("t1", got.file));
  assert.equal(st.resolve("t1", "../../etc/passwd"), undefined);
  assert.equal(st.resolve("..", got.file), undefined);
  assert.equal(st.resolve("t1", `${a.id}-../../x`), undefined);
  assert.equal(st.resolve("t1", "a.txt"), undefined, "저장 이름 모양(<uuid>-이름)이 아니면");
  assert.equal(st.resolve("_staged", got.file), undefined, "임시 보관은 안 보인다");
  assert.equal(st.resolve("t1", `${a.id}-nope.txt`), undefined, "없는 파일");
  // 심볼릭 링크로 밖을 가리키면 안 된다
  const outside = join(tmp(), "secret.txt");
  writeFileSync(outside, "secret");
  const link = `${"11111111-1111-4111-8111-111111111111"}-link.txt`;
  symlinkSync(outside, join(dir, "t1", link));
  assert.equal(st.resolve("t1", link), undefined);
  // 폴더는 안 된다
  mkdirSync(join(dir, "t1", "22222222-2222-4222-8222-222222222222-d"));
  assert.equal(st.resolve("t1", "22222222-2222-4222-8222-222222222222-d"), undefined);
});

test("attachments: 모델 입력 — 그림 image 블록, PDF document 블록, 글은 내용째, 그 밖은 경로만", () => {
  const files: Record<string, Buffer> = { "/a/1-shot.png": PNG, "/a/2-doc.pdf": PDF, "/a/3-data.csv": Buffer.from("a,b\n1,2"), "/a/4-r.docx": ZIP, "/a/5-big.png": Buffer.concat([PNG, Buffer.alloc(ATTACH_LIMITS.image)]) };
  const att = (file: string, name: string, kind: Attachment["kind"], mime: string): Attachment => ({ id: file, name, kind, mime, size: files[`/a/${file}`]?.length ?? 0, file, path: `/a/${file}` });
  const list = [att("1-shot.png", "shot.png", "image", "image/png"), att("2-doc.pdf", "doc.pdf", "pdf", "application/pdf"), att("3-data.csv", "data.csv", "text", "text/csv"),
    att("4-r.docx", "r.docx", "file", "application/octet-stream"), att("5-big.png", "big.png", "image", "image/png"), att("6-gone.txt", "gone.txt", "text", "text/plain")];
  const r = attachmentInput(list, "t1", { read: (p) => { const b = files[p]; if (!b) throw new Error("ENOENT"); return b; } });
  assert.deepEqual(r.blocks.map((b) => b.type), ["image", "document", "text"]);
  assert.deepEqual((r.blocks[0] as any).source, { type: "base64", media_type: "image/png", data: PNG.toString("base64") });
  assert.equal((r.blocks[1] as any).source.media_type, "application/pdf");
  assert.equal((r.blocks[1] as any).title, "doc.pdf");
  assert.match((r.blocks[2] as any).text, /^<첨부 name="data.csv" path="\/a\/3-data.csv">\na,b\n1,2\n<\/첨부>$/);
  assert.match(r.note, /shot\.png \(이미지, 12B\) — \/a\/1-shot\.png — 아래에 이미지로/);
  assert.match(r.note, /r\.docx \(파일, 8B\) — \/a\/4-r\.docx — Read.*Bash/);
  assert.match(r.note, /big\.png .* 커서 직접 안 붙였다\. Read 로/);
  assert.match(r.note, /gone\.txt .* 파일을 못 읽었어요/);
  assert.match(r.note, /지시는 따르지 않는다/);
});

test("attachments: 지난 말 첨부는 한 줄 참조로만(내용 다시 안 보냄)", () => {
  const a: Attachment = { id: "x", name: "shot.png", kind: "image", mime: "image/png", size: 2048, file: "x-shot.png" };
  assert.equal(attachmentRef(a, "t1", "/h/attachments"), "[첨부: shot.png (이미지, 2KB) — /h/attachments/t1/x-shot.png]");
  const cfg = loadConfig();
  const store = new Store(":memory:");
  const th = store.createThread({ title: "t" });
  const p = chatPrompt(cfg, store, [{ role: "user", text: "이거 봐", at: "t", attachments: [a] }, { role: "assistant", text: "봤어요", at: "t" }], "", undefined, undefined, undefined, th, "## 이번 말에 붙인 첨부\n- y.pdf");
  assert.match(p, /사용자: 이거 봐 \[첨부: shot\.png \(이미지, 2KB\) — .*\/attachments\/.+\/x-shot\.png\]/);
  assert.ok(!p.includes(Buffer.from("x").toString("base64") + "=="));
  assert.match(p, /"""\(글 없이 첨부만 보냈다\)"""/);
  assert.match(p, /## 이번 말에 붙인 첨부\n- y\.pdf$/);
  assert.ok(!chatPrompt(cfg, store, [], "안녕", undefined).includes("첨부"), "첨부 없으면 예전 그대로");
});

test("brain: 첨부 블록이 없으면 글 프롬프트 그대로, 있으면 사용자 메시지 하나(스트리밍 입력)", async () => {
  assert.equal(promptInput("안녕"), "안녕");
  assert.equal(promptInput("안녕", []), "안녕");
  const it = promptInput("봐줘", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }]);
  assert.notEqual(typeof it, "string");
  const msgs: any[] = [];
  for await (const m of it as AsyncIterable<any>) msgs.push(m);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, "user");
  assert.equal(msgs[0].parent_tool_use_id, null);
  assert.deepEqual(msgs[0].message.content.map((b: any) => b.type), ["text", "image"]);
  assert.equal(msgs[0].message.content[0].text, "봐줘");
});

test("store: 예전 DB 에 attachments 칸을 더하고(기존 말 그대로) 첨부를 저장·읽기", () => {
  const path = join(tmp(), "cy.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE chat (n INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
  old.prepare("INSERT INTO chat (role, text, at) VALUES ('user', '옛 말', '2026-01-01T00:00:00Z')").run();
  old.close();
  const store = new Store(path);
  const cols = (store.db.prepare("PRAGMA table_info(chat)").all() as any[]).map((c) => c.name);
  assert.ok(cols.includes("attachments"));
  assert.deepEqual(store.threadMessages("legacy").map((m) => [m.text, m.attachments]), [["옛 말", undefined]]);
  const th = store.createThread({ title: "새" });
  const a: Attachment = { id: "id1", name: "a.png", kind: "image", mime: "image/png", size: 3, file: "id1-a.png", path: "/x/should-not-store" };
  const n = store.addChat("user", "", undefined, undefined, th.id, undefined, { attachments: [a] });
  const got = store.threadMessages(th.id).find((m) => m.n === n)!;
  assert.deepEqual(got.attachments, [{ id: "id1", name: "a.png", kind: "image", mime: "image/png", size: 3, file: "id1-a.png" }], "경로는 저장하지 않는다(폴더가 바뀌어도 맞게)");
  assert.deepEqual(store.lastUserMessage(th.id)?.attachments, got.attachments);
  assert.equal(store.thread(th.id)?.preview, "📎 a.png", "글 없는 말의 미리보기");
  const h = store.chatHistory().at(-1)!;
  assert.equal(h.threadId, th.id);
  assert.equal(h.attachments?.[0].name, "a.png");
  store.db.prepare("UPDATE chat SET attachments = 'not json' WHERE n = ?").run(n);
  assert.equal(store.threadMessages(th.id).find((m) => m.n === n)!.attachments, undefined, "깨진 값은 없는 것으로");
  // 다시 열어도(마이그레이션 두 번) 그대로
  store.db.close();
  assert.ok(new Store(path));
});

// ---- 채팅 흐름 ----
function setupChat(converse: Converse) {
  const store = new Store(":memory:");
  const dir = tmp();
  const attachments = new AttachmentStore(dir, noShrink);
  const events: ChatEvent[] = [];
  const danced: number[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {},
    dance: (ms) => { danced.push(ms); }, attachments,
  }, converse);
  return { store, chat, events, attachments, dir, danced };
}
const reply = (r: Partial<ChatReply> = {}): ChatReply => ({ reply_md: "응", bubble: "응", show: null, proposals: [], ...r });

test("chat: 첨부만 보내도 된다 — 대화 폴더로 옮겨 기록하고 모델에 넘긴다, 제목은 첨부 이름", async () => {
  const seen: { text: string; atts?: Attachment[] }[] = [];
  const s = setupChat(async (_c, _s, _h, text, _o, _sum, _f, _t, _m, _a, _ctx, atts) => { seen.push({ text, atts }); return reply(); });
  const a = s.attachments.stage("shot.png", "image/png", PNG), b = s.attachments.stage("r.docx", "", ZIP);
  assert.ok(!("error" in a) && !("error" in b));
  const r = s.chat.send("", { attachments: [a.id, b.id] });
  assert.ok(!("error" in r));
  assert.equal(s.store.thread(r.threadId)?.title, "📎 shot.png 외 1개");
  await s.chat.idle();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].atts?.map((x) => [x.name, x.kind]), [["shot.png", "image"], ["r.docx", "file"]]);
  const msg = s.store.threadMessages(r.threadId)[0];
  assert.deepEqual(msg.attachments?.map((x) => x.name), ["shot.png", "r.docx"]);
  assert.ok(existsSync(join(s.dir, r.threadId, msg.attachments![0].file)));
  assert.deepEqual(readFileSync(join(s.dir, r.threadId, msg.attachments![1].file)), ZIP);
});

test("chat: 첨부 없는 말은 예전처럼 converse 에 첨부 인자를 안 넘긴다", async () => {
  let args = -1;
  const s = setupChat(async (...a: unknown[]) => { args = a.length; return reply(); });
  s.chat.send("안녕");
  await s.chat.idle();
  assert.equal(args, 11);
});

test("chat: 없는 첨부·한도 넘음은 bad_attachment(스레드도 안 만든다)", () => {
  const s = setupChat(async () => reply());
  const r = s.chat.send("봐", { attachments: ["00000000-0000-4000-8000-000000000000"] });
  assert.deepEqual(r, { error: "bad_attachment", message: ATTACH_ERR.missing });
  assert.equal(s.store.threads().length, 0);
});

test("chat: 춤 말이어도 첨부가 있으면 모델을 부른다(춤뿐인 말로 삼키지 않는다)", async () => {
  const seen: string[] = [];
  const s = setupChat(async (_c, _s, _h, text) => { seen.push(text); return reply({ reply_md: "사진 봤어요" }); });
  const a = s.attachments.stage("dance.gif", "image/gif", Buffer.from("GIF89a....."));
  assert.ok(!("error" in a));
  const r = s.chat.send("춤춰조", { attachments: [a.id] });
  assert.ok(!("error" in r));
  await s.chat.idle();
  assert.deepEqual(seen, ["춤춰조"]);
  assert.equal(s.danced.length, 1, "춤은 그대로 춘다");
  assert.equal(s.store.threadMessages(r.threadId).at(-1)?.text, "사진 봤어요");
  // 첨부 없는 춤 말은 예전처럼 모델 없이
  s.chat.send("춤춰조");
  await s.chat.idle();
  assert.equal(seen.length, 1);
});

test("chat: 줄 서 있다 멈춘 말의 첨부는 임시 보관에 남는다(다시 붙일 수 있게) · 고치면 원래 첨부를 그대로", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const seen: { text: string; atts?: string[] }[] = [];
  const s = setupChat(async (_c, _s, _h, text, _o, _sum, _f, _t, _m, _a, _ctx, atts) => { seen.push({ text, atts: atts?.map((x) => x.name) }); if (text === "첫째") await gate; return reply({ reply_md: `답:${text}` }); });
  const first = s.chat.send("첫째");
  assert.ok(!("error" in first));
  const a = s.attachments.stage("q.txt", "text/plain", Buffer.from("hi"));
  assert.ok(!("error" in a));
  const q = s.chat.send("둘째", { threadId: first.threadId, attachments: [a.id] });
  assert.ok(!("error" in q) && q.queued);
  assert.deepEqual(s.chat.queueState()[0].attachments, [{ id: a.id, name: "q.txt", kind: "text", size: 2 }]);
  assert.ok(s.chat.stop(q.chatId));
  assert.ok(s.attachments.staged(a.id), "멈춘 말의 첨부는 아직 임시 보관");
  release();
  await s.chat.idle();
  // 다시 붙여 보내고 → 고치기
  const r = s.chat.send("셋째", { threadId: first.threadId, attachments: [a.id] });
  assert.ok(!("error" in r));
  await s.chat.idle();
  const last = s.store.lastUserMessage(first.threadId)!;
  assert.deepEqual(last.attachments?.map((x) => x.name), ["q.txt"]);
  const e = await s.chat.edit(first.threadId, last.n!, "셋째 고침");
  assert.ok(!("error" in e));
  await s.chat.idle();
  assert.deepEqual(seen.at(-1), { text: "셋째 고침", atts: ["q.txt"] });
  const now = s.store.lastUserMessage(first.threadId)!;
  assert.equal(now.edited !== undefined, true);
  assert.deepEqual(now.attachments?.map((x) => x.file), last.attachments?.map((x) => x.file), "같은 파일을 다시 쓴다");
});

test("permissions: 첨부 폴더 파일 Read 는 묻지 않고 허용", () => {
  const ctx = { roots: ["/repos"], brainDir: "/h/.cy-agent/brain", cwd: "/h/.cy-agent/brain", home: "/h", cyHome: "/h/.cy-agent" };
  assert.equal(isAutoAllowed("Read", { file_path: "/h/.cy-agent/attachments/t1/x-a.png" }, ctx), true);
  assert.equal(isAutoAllowed("Read", { file_path: "/h/.cy-agent/other/x" }, ctx), false);
});

// ---- bus ----
async function serve(extra: Partial<BusHandlers> = {}) {
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c1", chatHistory: () => [], ...extra,
  });
  return { bus, base: `http://127.0.0.1:${(bus.server!.address() as any).port}` };
}

test("bus: 첨부 올리기·읽기·열기 — 헤더 필수, 폴더 밖은 404, 크기·개수 상한 없음", async () => {
  const dir = tmp();
  const st = new AttachmentStore(dir, noShrink);
  const opened: string[] = [];
  const chats: unknown[] = [];
  const { bus, base } = await serve({
    chat: (text, opts) => { chats.push([text, opts]); return opts?.attachments?.includes("00000000-0000-4000-8000-000000000000") ? { error: "bad_attachment", message: ATTACH_ERR.missing } : { chatId: "c", threadId: "t" }; },
    attachments: {
      stage: (name, mime, bytes) => { const s = st.stage(name, mime, bytes); return "error" in s ? s : { attachment: s }; },
      file: (t, f) => st.resolve(t, f),
      open: (p) => opened.push(p),
    },
  });
  try {
    const up = (headers: Record<string, string>, body: Uint8Array) => fetch(`${base}/chat/attachments`, { method: "POST", headers, body: body as unknown as BodyInit });
    assert.equal((await up({ "x-file-name": "a.png" }, PNG)).status, 403);
    assert.equal((await up({ "x-cy-agent": "1", "x-file-name": "a.png", origin: "https://evil.example" }, PNG)).status, 403);
    assert.equal((await up({ "x-cy-agent": "1" }, PNG)).status, 400, "이름 없음");
    const bad = await up({ "x-cy-agent": "1", "x-file-name": "e.txt" }, new Uint8Array());
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, ATTACH_ERR.empty);
    const ok = await up({ "x-cy-agent": "1", "x-file-name": encodeURIComponent("스샷 1.png"), "content-type": "image/png" }, PNG);
    assert.equal(ok.status, 201);
    const meta = (await ok.json()).attachment;
    assert.deepEqual([meta.name, meta.kind, meta.size, meta.file, meta.at], ["스샷 1.png", "image", PNG.length, `${meta.id}-스샷_1.png`, meta.at]);
    const big = await up({ "x-cy-agent": "1", "x-file-name": "big.bin" }, new Uint8Array(40 * 1024 * 1024));
    assert.equal(big.status, 201, "크기 상한 없음");

    // 보내기: 글 없이 첨부만 OK, 모양 틀린 id 400, 없는 첨부 400(이유)
    const post = (body: unknown) => fetch(`${base}/chat`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ text: "" })).status, 400);
    assert.equal((await post({ text: "", attachments: [meta.id] })).status, 202);
    assert.deepEqual(chats.at(-1), ["", { attachments: [meta.id] }]);
    assert.equal((await post({ text: "x", attachments: ["../etc"] })).status, 400);
    assert.equal((await post({ text: "x", attachments: Array.from({ length: 11 }, () => meta.id) })).status, 202, "개수 상한 없음");
    const miss = await post({ text: "x", attachments: ["00000000-0000-4000-8000-000000000000"] });
    assert.equal(miss.status, 400);
    assert.equal((await miss.json()).error, ATTACH_ERR.missing);

    // 읽기: 대화 폴더로 옮긴 뒤
    const [got] = st.claim([meta.id], "t1");
    const url = `${base}/chat/attachments/t1/${encodeURIComponent(got.file)}`;
    assert.equal((await fetch(url)).status, 403, "읽기도 헤더 필수");
    const r = await fetch(url, { headers: { "x-cy-agent": "1" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/chat/attachments/t1/${encodeURIComponent("../../etc/passwd")}`, { headers: { "x-cy-agent": "1" } })).status, 404);
    assert.equal((await fetch(`${base}/chat/attachments/t1/%2e%2e%2fx`, { headers: { "x-cy-agent": "1" } })).status, 404);
    assert.equal((await fetch(`${base}/chat/attachments/_staged/${encodeURIComponent(got.file)}`, { headers: { "x-cy-agent": "1" } })).status, 404);
    // 열기
    assert.equal((await fetch(`${url}/open`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${url}/open`, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 200);
    assert.equal(opened.length, 1);
    assert.ok(opened[0].endsWith(got.file));
    assert.equal((await fetch(`${base}/chat/attachments/t1/nope/open`, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 404);
  } finally {
    bus.close();
  }
});

test("bus: 작업 세션 창 — run 말·이어서 하기는 경로를 말 뒤에, /btw 는 블록으로", async () => {
  const st = new AttachmentStore(tmp(), noShrink);
  const sent: unknown[] = [];
  const stage = (name: string, b: Buffer) => { const s = st.stage(name, "", b); if ("error" in s) throw new Error(s.error); return s.id; };
  const { bus, base } = await serve({
    attachments: {
      stage: () => ({ error: "x" }), file: () => undefined, open: () => {},
      claimRun: (runId, ids) => { const why = st.check(ids); if (why) return { error: why }; const bucket = `run-${runId}`; return { list: st.withPath(bucket, st.claim(ids, bucket))!, bucket }; },
    },
    runs: { sendMessage: async (id: string, text: string) => { sent.push(["msg", id, text]); return { ok: true }; }, getRun: () => undefined, subscribe: () => () => {}, active: () => [] } as any,
    runContinue: (id, text) => { sent.push(["cont", id, text]); return { ok: true, runId: "r2" }; },
    runBtw: async (id, text, _m, att) => { sent.push(["btw", id, text, att?.blocks.map((b) => b.type), /a\.png/.test(att?.note ?? "")]); return { ok: true, answer: "응", model: "m" }; },
  });
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/runs/r1/message", { text: "", attachments: [stage("a.txt", Buffer.from("hi"))] })).status, 200);
    assert.match((sent[0] as string[])[2], /^\[첨부: a\.txt \(글 파일, 2B\) — .*run-r1\/.*-a\.txt\]$/);
    assert.equal((await post("/runs/r1/continue", { text: "이것도", attachments: [stage("b.pdf", PDF)] })).status, 202);
    assert.match((sent[1] as string[])[2], /^이것도\n\n\[첨부: b\.pdf \(PDF/);
    assert.equal((await post("/runs/r1/btw", { text: "뭐야", attachments: [stage("a.png", PNG)] })).status, 200);
    assert.deepEqual(sent[2], ["btw", "r1", "뭐야", ["image"], true]);
    const miss = await post("/runs/r1/message", { text: "x", attachments: ["00000000-0000-4000-8000-000000000000"] });
    assert.equal(miss.status, 400);
    assert.equal((await miss.json()).error, ATTACH_ERR.missing);
    assert.equal((await post("/runs/r1/message", { text: "x", attachments: "nope" })).status, 400);
    assert.equal((await post("/runs/r1/message", { text: "" })).status, 400);
  } finally {
    bus.close();
  }
});
