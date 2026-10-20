// 로컬 표시 설정. 데몬/계정 정보와 분리해 이 컴퓨터에만 저장한다.
export function appearance(p = {}) {
  const scale = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(50, Math.min(150, v)) : 100;
  return { characterScale: scale(p.characterScale), bubbleScale: scale(p.bubbleScale), bubblesVisible: p.bubblesVisible !== false };
}
export function overlayLayout(p = {}, area = { width: 10000, height: 10000 }) {
  const a = appearance(p);
  const largest = Math.max(a.characterScale, a.bubbleScale) / 100;
  const fit = Math.min(1, area.width / (420 * largest), area.height / (580 * largest));
  return { width: Math.floor(420 * largest * fit), height: Math.floor(580 * largest * fit),
    characterZoom: a.characterScale / 100 * fit, bubbleZoom: a.bubbleScale / 100 * fit };
}
export function resizeOverlay(bounds, size, area) {
  return { ...size,
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - size.width, bounds.x + (bounds.width - size.width) / 2))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - size.height, bounds.y + bounds.height - size.height))) };
}
