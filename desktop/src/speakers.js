// 둘 이상이 주고받는 대사(「카니와 모몽가」: "모몽가: … / 카니: …")를 한 줄에 한 사람씩, 캐릭터 대표 색으로.
// 대표 색(사용자가 정함): 치이카와 흰색 · 우사기 개나리 노랑 · 하치와레 하늘 · 시사 주황 · 쿠리만쥬 초록 · 랏코 회색 · 카니 분홍 · 모몽가 연보라
export const SPEAKER_COLORS = Object.freeze({
  치이카와: '#ffffff',
  우사기: '#ffd43b',
  하치와레: '#74c0fc',
  시사: '#ff922b',
  쿠리만쥬: '#69db7c',
  랏코: '#adb5bd',
  카니: '#f783ac',
  모몽가: '#c5b3ff',
  짭몽가: '#c5b3ff',
  찐몽가: '#c5b3ff',
});

const NAMES = Object.keys(SPEAKER_COLORS).sort((a, b) => b.length - a.length).join('|');
const SPLIT = new RegExp(`\\s+/\\s+(?=(?:${NAMES}):)`);
const HEAD = new RegExp(`^(${NAMES}):\\s*([\\s\\S]*)$`);

// "모몽가: 뭐어?! / 카니: 헤헤..." → [{ name, text, color }] · 「이름:」으로 시작하지 않으면 null(보통 대사)
export function speakerLines(text) {
  if (typeof text !== 'string' || !HEAD.test(text.trimStart())) return null;
  return text.trim().split(SPLIT).map((part) => {
    const m = HEAD.exec(part);
    return m ? { name: m[1], text: m[2].trim(), color: SPEAKER_COLORS[m[1]] } : { name: null, text: part, color: null };
  });
}

// 요소 안을 주고받기 줄로 채운다. 보통 대사면 아무것도 안 하고 false
export function renderSpeech(el, text, doc = globalThis.document) {
  const lines = speakerLines(text);
  if (!lines || !el || !doc) return false;
  // 색 글자가 잘 보이게 말풍선·카드를 어두운 바탕으로(밝은 화면 모드에서도) — style.css .speech-box
  el.closest?.('.bubble, #doing, .toast')?.classList.add('speech-box');
  el.replaceChildren(...lines.map((l) => {
    const row = doc.createElement('span');
    row.className = 'speech-line';
    if (l.color) row.style.color = l.color;
    if (l.name) {
      const who = doc.createElement('b');
      who.textContent = `${l.name}: `;
      row.append(who);
    }
    row.append(doc.createTextNode(l.text));
    return row;
  }));
  return true;
}

// 기본 캐릭터 id → 대표 색(사용자 캐릭터는 이름, 없으면 바탕이 된 캐릭터 from 의 색: 세이렌 → 하치와레, 아노코 → 카니)
export const BASE_COLORS = Object.freeze({
  chiikawa: SPEAKER_COLORS.치이카와, usagi: SPEAKER_COLORS.우사기, hachi: SPEAKER_COLORS.하치와레, shisa: SPEAKER_COLORS.시사,
  kuri: SPEAKER_COLORS.쿠리만쥬, rakko: SPEAKER_COLORS.랏코, kani: SPEAKER_COLORS.카니, momonga: SPEAKER_COLORS.모몽가,
});
// c: { id, name?, from? } → 색 | null
export function characterColor(c) {
  if (!c) return null;
  if (c.name && SPEAKER_COLORS[c.name]) return SPEAKER_COLORS[c.name];
  if (BASE_COLORS[c.id]) return BASE_COLORS[c.id];
  const inName = c.name && Object.keys(SPEAKER_COLORS).find((n) => c.name.includes(n));
  if (inName) return SPEAKER_COLORS[inName];
  return BASE_COLORS[c.from] ?? null;
}

// 혼자 하는 말: 글자를 그 캐릭터 색으로, 말풍선·카드는 어두운 바탕으로. color 가 없으면 원래대로
export function paintSpeaker(el, color) {
  const box = el?.closest?.('.bubble, #doing, .toast');
  if (!el) return;
  el.style.color = color || '';
  if (color) box?.classList.add('speech-box');
}
