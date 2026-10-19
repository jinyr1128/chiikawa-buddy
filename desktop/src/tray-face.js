// 메뉴 막대 아이콘 = 지금 캐릭터 얼굴(이모티콘처럼). 대기 그림(eyes_open)에서 투명하지 않은 부분을 찾아
// 머리가 다 들어가는 정사각형을 잘라 낸다. 키 큰 캐릭터(우사기 귀)는 조금 아래로. 배경이 꽉 찬 그림은 가운데 위쪽.
// bitmap: BGRA(nativeImage.toBitmap) 또는 RGBA — 알파는 4번째 바이트라 둘 다 같다
export function faceBox(bitmap, width, height, threshold = 40) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (bitmap[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const side = Math.max(1, Math.floor(Math.min(w, h) * 0.95));
  const cx = x0 + Math.floor(w / 2);
  const top = h <= w * 1.15 ? y0 : y0 + Math.floor((h - side) * 0.45);
  const x = Math.max(0, Math.min(width - side, cx - Math.floor(side / 2)));
  const y = Math.max(0, Math.min(height - side, top));
  return { x, y, width: Math.min(side, width), height: Math.min(side, height) };
}
