// 도움 보내기 창 — 메인에서 받은 기록을 보여 주고, 짧은 요약 그림을 그린다. 네트워크 없음.
import { encode } from './vendor/qr.js';
import { isWindowsUA } from '../src/os-hint.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statusEl = $('status');
const speechEl = $('speech');
const canvas = $('qr');
const qrNote = $('qr-note');

// 윈도우: 단축키 안내를 Ctrl+Shift+D 로
if (isWindowsUA()) { const k = $('guide')?.querySelector('strong'); if (k) k.textContent = 'Ctrl+Shift+D'; }

function setStatus(text, err) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', !!err);
}

function drawQr(text) {
  if (!text) {
    qrNote.textContent = '그림에 넣을 요약이 없어요. 왼쪽 기록을 복사해 주세요.';
    return;
  }
  try {
    const { data, size } = encode(text, { ecc: 'M', maxVersion: 20, border: 2 });
    const px = Math.max(2, Math.floor(220 / size));
    canvas.width = size * px;
    canvas.height = size * px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[y][x]) ctx.fillRect(x * px, y * px, px, px);
      }
    }
  } catch {
    qrNote.textContent = '그림이 너무 커서 못 그렸어요. 왼쪽 기록을 복사해 주세요.';
  }
}

async function load() {
  if (!window.cy) {
    logEl.value = '창을 열지 못했어요.';
    return;
  }
  logEl.value = '기록을 모으는 중…';
  const b = await window.cy.load();
  if (!b?.ok) {
    logEl.value = '기록을 모으지 못했어요.';
    setStatus('기록을 모으지 못했어요.', true);
    return;
  }
  logEl.value = b.text || '';
  if (b.speech) speechEl.textContent = b.speech;
  drawQr(b.qr);
}

$('copy').addEventListener('click', async () => {
  const r = await window.cy.copy();
  setStatus(r?.ok ? '복사했습니다. 채팅이나 메일에 붙여 넣어 주세요.' : (r?.error || '복사하지 못했어요.'), !r?.ok);
});

$('save').addEventListener('click', async () => {
  const r = await window.cy.save();
  setStatus(r?.ok ? `바탕화면에 저장했습니다. (${r.fileName || '파일'})` : (r?.error || '저장하지 못했어요.'), !r?.ok);
});

window.cy?.onReload?.(load);
load();
