import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_ERRORS, admitFiles, filesFromTransfer, hasFiles, pastedName, downscaleTarget, normAttachments, attachUrl, resolveAttachUrl,
  chipView, sendable, attachSummary, cleanAttachIds, cleanUpload, guessKind, okStoredName, fmtSize,
} from '../src/attachments.js';
import { mergeMessages, appendLocal, dropLocal, isDoubleSend } from '../src/threads.js';
import { initialChat, chatReducer, queuedChats } from '../src/chat.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const F = (name, size, type = '', lastModified = 1) => ({ name, size, type, lastModified });

test('attachments: 종류 추측·크기 글·저장 이름 모양', () => {
  assert.equal(guessKind('a.PNG'), 'image');
  assert.equal(guessKind('x', 'image/heic'), 'image');
  assert.equal(guessKind('r.pdf'), 'pdf');
  assert.equal(guessKind('data.csv'), 'text');
  assert.equal(guessKind('main.tsx'), 'text');
  assert.equal(guessKind('보고서.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'file');
  assert.equal(guessKind('a.zip'), 'file');
  assert.deepEqual([fmtSize(10), fmtSize(2048), fmtSize(3 * 1024 * 1024)], ['10B', '2KB', '3.0MB']);
  assert.equal(okStoredName(`${ID}-스샷_1.png`), true);
  assert.equal(okStoredName(`${ID}-../x`), false);
  assert.equal(okStoredName(`${ID}-a/b.png`), false);
  assert.equal(okStoredName('a.png'), false);
  assert.equal(okStoredName(`${ID}-a b.png`), false, '공백은 저장 이름에 없다');
});

test('admitFiles: 크기·합·개수 상한 없음, 빈 파일·같은 파일 두 번만 빼고, 이유는 사용자 글로', () => {
  const GB = 1024 ** 3;
  const r = admitFiles([], [F('a.png', 10, 'image/png'), F('a.png', 10, 'image/png'), F('empty.txt', 0), F('big.mov', 3 * GB)]);
  assert.deepEqual(r.add.map((x) => [x.name, x.kind]), [['a.png', 'image'], ['big.mov', 'file']]);
  assert.deepEqual(r.errors, [ATTACH_ERRORS.empty('empty.txt')]);
  const many = Array.from({ length: 40 }, (_, i) => ({ sig: `s${i}`, size: GB }));
  const r2 = admitFiles(many, [F('x.txt', 1), F('y.txt', 1), F('z.txt', 1)]);
  assert.deepEqual([r2.add.map((x) => x.name), r2.errors], [['x.txt', 'y.txt', 'z.txt'], []]);
  // 이미 붙인 것(sig 같음)은 조용히 건너뛴다
  const sig = r.add[0].sig;
  assert.deepEqual(admitFiles([{ sig, size: 10 }], [F('a.png', 10, 'image/png')]), { add: [], errors: [] });
});

test('filesFromTransfer·hasFiles: 파일만, 폴더는 세서 빼고, items 없으면 files', () => {
  const file = (n) => ({ name: n });
  const item = (f, dir = false) => ({ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: dir }) });
  const dt = { items: [item(file('a.png')), { kind: 'string', getAsFile: () => null }, item(file('dir'), true)] };
  assert.deepEqual(filesFromTransfer(dt), { files: [file('a.png')], folders: 0 + 1 });
  assert.deepEqual(filesFromTransfer({ files: [file('b.pdf')] }), { files: [file('b.pdf')], folders: 0 });
  assert.deepEqual(filesFromTransfer(null), { files: [], folders: 0 });
  assert.equal(hasFiles({ types: ['text/plain', 'Files'] }), true);
  assert.equal(hasFiles({ types: ['text/uri-list'] }), false);
  assert.equal(hasFiles(null), false);
});

test('pastedName: 클립보드 스크린샷(image.png)은 시각 이름, 원래 이름이 있으면 그대로', () => {
  const now = new Date(2026, 9, 13, 14, 2, 5);
  assert.equal(pastedName({ name: 'image.png', type: 'image/png' }, now), '스크린샷 2026-10-13 14.02.05.png');
  assert.equal(pastedName({ name: '', type: 'image/jpeg' }, now), '스크린샷 2026-10-13 14.02.05.jpg');
  assert.equal(pastedName({ name: '회의록.pdf', type: 'application/pdf' }, now), '회의록.pdf');
});

test('downscaleTarget: 긴 변 2000px·3.5MB 넘는 PNG/JPEG/WebP 만, 비율 유지', () => {
  assert.equal(downscaleTarget(1200, 800, 500_000, 'image/png'), null);
  assert.deepEqual(downscaleTarget(4000, 3000, 500_000, 'image/jpeg'), { width: 2000, height: 1500 });
  assert.deepEqual(downscaleTarget(1000, 3000, 100, 'image/webp'), { width: 667, height: 2000 });
  assert.deepEqual(downscaleTarget(1500, 1000, 5 * 1024 * 1024, 'image/png'), { width: 1500, height: 1000 }, '작아도 너무 무거우면 다시 인코딩');
  assert.equal(downscaleTarget(4000, 3000, 9e6, 'image/gif'), null, 'GIF 는 그대로(움직이는 그림)');
  assert.equal(downscaleTarget(0, 0, 9e6, 'image/png'), null);
});

test('normAttachments: 모양이 틀린 건 버리고 id·저장 이름·blob 미리보기만 믿는다', () => {
  const list = normAttachments([
    { id: ID, name: 'a.png', kind: 'image', size: 10, file: `${ID}-a.png`, path: '/x/y' },
    { id: 'nope', name: 'b.txt', kind: 'weird', size: '3', file: '../../etc/passwd', localUrl: 'https://evil/x' },
    { name: 'c.png', kind: 'image', size: 1, localUrl: 'blob:file:///abc' },
    null, { kind: 'image' },
  ]);
  assert.deepEqual(list, [
    { name: 'a.png', kind: 'image', size: 10, id: ID, file: `${ID}-a.png` },
    { name: 'b.txt', kind: 'file', size: 3 },
    { name: 'c.png', kind: 'image', size: 1, localUrl: 'blob:file:///abc' },
  ]);
  assert.deepEqual(normAttachments('x'), []);
});

test('attachUrl·resolveAttachUrl: cy-attach://chat/<대화>/<저장 이름>, 경로 조작은 null', () => {
  const file = `${ID}-스샷_1.png`;
  const url = attachUrl('3b0a-thread', file);
  assert.equal(url, `cy-attach://chat/3b0a-thread/${encodeURIComponent(file)}`);
  assert.deepEqual(resolveAttachUrl(url), { threadId: '3b0a-thread', file });
  assert.equal(attachUrl('../x', file), null);
  assert.equal(attachUrl('t1', 'a.png'), null);
  assert.equal(resolveAttachUrl(`cy-attach://chat/t1/${encodeURIComponent(`${ID}-../../x`)}`), null);
  assert.equal(resolveAttachUrl(`cy-attach://chat/t1/a/${encodeURIComponent(file)}`), null, '조각이 더 있으면');
  assert.equal(resolveAttachUrl(`cy-attach://chat/_staged/${encodeURIComponent(file)}`), null, '임시 보관은 안 된다');
  assert.equal(resolveAttachUrl(`cy-attach://other/t1/${encodeURIComponent(file)}`), null);
  assert.equal(resolveAttachUrl(`cy-attach://chat/t1/${encodeURIComponent(file)}?x=1`), null);
  assert.equal(resolveAttachUrl(`cy-asset://chat/t1/${encodeURIComponent(file)}`), null);
  assert.equal(resolveAttachUrl('cy-attach://chat/t1/%E0%A4%A'), null, '깨진 인코딩');
  assert.equal(resolveAttachUrl('not a url'), null);
});

test('chipView·sendable·attachSummary: 칩 글, 보낼 수 있나, 대기 중 풍선 글', () => {
  assert.deepEqual(chipView({ name: 'a.pdf', kind: 'pdf', size: 2048, status: 'ready' }), { icon: '📕', name: 'a.pdf', size: '2KB', state: '', title: 'a.pdf\nPDF · 2KB' });
  assert.equal(chipView({ name: 'x', kind: 'file', size: 1, status: 'uploading' }).state, '올리는 중…');
  assert.equal(chipView({ name: 'x', kind: 'file', size: 1, status: 'error', error: '너무 커요' }).state, '너무 커요');
  assert.deepEqual(sendable([{ status: 'ready', id: ID }, { status: 'uploading' }, { status: 'error' }, { status: 'ready', id: 'bad' }]), { ids: [ID], waiting: 1, failed: 1 });
  assert.equal(attachSummary([{ name: 'a.png' }]), '📎 a.png');
  assert.equal(attachSummary([{ name: 'a.png' }, { name: 'b' }, { name: 'c' }]), '📎 a.png 외 2개');
  assert.equal(attachSummary([]), '');
});

test('cleanAttachIds·cleanUpload: 메인 IPC 검사', () => {
  assert.deepEqual(cleanAttachIds(undefined), []);
  assert.deepEqual(cleanAttachIds([ID, ID, ID2]), [ID, ID2]);
  assert.equal(cleanAttachIds([ID, '../x']), null);
  assert.equal(cleanAttachIds('x'), null);
  assert.deepEqual(cleanAttachIds(Array.from({ length: 30 }, (_, i) => `${ID.slice(0, -2)}${String(i).padStart(2, '0')}`)).length, 30); // 개수 상한 없음
  const bytes = new Uint8Array([1, 2]);
  assert.deepEqual(cleanUpload(' a.png ', 'image/png', bytes), { name: 'a.png', mime: 'image/png', bytes });
  assert.equal(cleanUpload('a.bin', 'bad mime;x', bytes).mime, 'application/octet-stream');
  assert.equal(cleanUpload('', 'image/png', bytes), null);
  assert.equal(cleanUpload('a', '', new Uint8Array()), null);
  assert.equal(cleanUpload('a', '', [1, 2]), null, '바이트가 아니면');
  assert.equal(cleanUpload('a', '', { length: 5, byteLength: 5 }), null);
});

test('threads: 글 없이 첨부만 보낸 말도 말이다 — 로컬 사본(미리보기)·서버 기록(저장 이름)·취소하면 첨부도 돌려받는다', () => {
  const local = appendLocal([], { role: 'user', text: '', at: '2026-10-13T00:00:00Z', clientId: 'c1', attachments: [{ id: ID, name: 'a.png', kind: 'image', size: 5, localUrl: 'blob:file:///1' }] });
  assert.equal(local.length, 1);
  assert.deepEqual(local[0].attachments, [{ name: 'a.png', kind: 'image', size: 5, id: ID, localUrl: 'blob:file:///1' }]);
  const tagged = local.map((m) => ({ ...m, chatId: 'k1' }));
  assert.equal(dropLocal(tagged, 'k1').dropped.attachments[0].id, ID);
  const merged = mergeMessages(local, [{ n: 1, role: 'user', text: '', at: '2026-10-13T00:00:01Z', clientId: 'c1', attachments: [{ id: ID, name: 'a.png', kind: 'image', size: 5, file: `${ID}-a.png` }] }]);
  assert.deepEqual(merged.map((m) => [m.n, !!m.local, m.attachments?.[0].file]), [[1, false, `${ID}-a.png`]]);
  assert.equal(mergeMessages([], [{ n: 2, role: 'user', text: ' ', at: 't' }]).length, 0, '글도 첨부도 없으면 버린다');
  assert.equal(mergeMessages([], [{ n: 3, role: 'assistant', text: '', at: 't', attachments: [{ name: 'x' }] }]).length, 0, '답에는 첨부가 없다');
  assert.equal(isDoubleSend(local, ''), false, '첨부만 보낸 말은 글로 두 번 보냄을 가리지 않는다');
});

test('chat 리듀서: 줄 선 말의 첨부(이름·크기)를 들고 있다 — 대기 중 풍선·취소 때 돌려놓기', () => {
  let s = initialChat();
  s = chatReducer(s, { type: 'accepted', chatId: 'q1', threadId: 't1', queued: true, text: '' });
  s = chatReducer(s, { type: 'event', ev: { chatId: 'q1', threadId: 't1', status: 'queued', text: '봐줘', queuedAt: '2026-10-13T00:00:00Z', position: 1, attachments: [{ id: ID, name: 'a.pdf', kind: 'pdf', size: 9 }] } });
  assert.deepEqual(queuedChats(s, 't1')[0].attachments, [{ name: 'a.pdf', kind: 'pdf', size: 9, id: ID }]);
  s = chatReducer(s, { type: 'event', ev: { chatId: 'q1', threadId: 't1', status: 'queued', text: '봐줘', position: 2 } });
  assert.equal(queuedChats(s, 't1')[0].attachments[0].name, 'a.pdf', '다음 queued 에 없으면 앞의 것 그대로');
  s = chatReducer(s, { type: 'queue', queue: [{ chatId: 'q2', threadId: 't1', text: 'x', queuedAt: '2026-10-13T00:00:01Z', position: 2, attachments: [{ id: ID2, name: 'b.png', kind: 'image', size: 1 }] }], running: [] });
  assert.equal(queuedChats(s, 't1').find((p) => p.chatId === 'q2').attachments[0].id, ID2);
});

test('IPC 배선: 첨부 올리기·열기·cy-attach 프로토콜·CSP — 메인은 모양만 거르고 데몬으로', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\('chat-attach', \(e, name, mime, bytes\) => \{\n\s+const u = fromOurs\(e\) \? cleanUpload\(name, mime, bytes\) : null;/);
  assert.match(main, /'X-CY-Agent': '1', 'Content-Type': mime, 'X-File-Name': encodeURIComponent\(name\)/);
  assert.match(main, /ipcMain\.handle\('attachment-open', \(e, threadId, file\) => \(fromOurs\(e\) && okThreadId\(threadId\) && okStoredName\(file\)/);
  assert.match(main, /const atts = cleanAttachIds\(o\.attachments\);/);
  assert.match(main, /\{ scheme: ATTACH_SCHEME, privileges: \{ standard: true, secure: true \} \}/);
  assert.match(main, /const a = req\.method === 'GET' \? resolveAttachUrl\(req\.url\) : null;/);
  assert.match(main, /headers: \{ 'X-CY-Agent': '1' \}/); // 데몬 첨부 읽기도 헤더 필수
  for (const p of ['preload-panel.cjs', 'preload-session.cjs', 'preload.cjs']) assert.match(read(p), /chatAttach: \(name, mime, bytes\) => ipcRenderer\.invoke\('chat-attach'/, p);
  assert.match(read('preload-panel.cjs'), /openAttachment: \(threadId, file\) => ipcRenderer\.invoke\('attachment-open'/);
  assert.match(read('renderer/panel.html'), /img-src 'self' data: blob: cy-asset: cy-attach:;/);
  for (const p of ['renderer/panel.html', 'renderer/session.html', 'renderer/index.html']) assert.match(read(p), /<link rel="stylesheet" href="attach\.css">/, p);
});
