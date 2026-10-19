// 창 위치 계산 — 순수 함수

// 기본 위치: 작업영역(독/메뉴바 제외) 오른쪽 아래
export function defaultPosition(workArea, size, margin = 16) {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - margin),
    y: Math.round(workArea.y + workArea.height - size.height),
  };
}

// 저장된 위치가 어느 화면에도 안 걸치면 null (모니터 뺐을 때)
export function restorePosition(saved, workAreas, size, minVisible = 80) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  for (const wa of workAreas) {
    const ox = Math.min(saved.x + size.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
    const oy = Math.min(saved.y + size.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
    if (ox >= minVisible && oy >= minVisible) return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return null;
}
