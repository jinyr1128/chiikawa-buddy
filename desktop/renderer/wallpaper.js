const scenes = new Map([
  [
    "치이카와",
    "chiikawa"
  ],
  [
    "하치와레",
    "hachi"
  ],
  [
    "우사기",
    "usagi"
  ],
  [
    "시사",
    "shisa"
  ],
  [
    "랏코",
    "rakko"
  ],
  [
    "쿠리만쥬",
    "kuri"
  ],
  [
    "카니",
    "kani"
  ],
  [
    "모몽가",
    "momonga"
  ],
  [
    "짭몽가",
    "jjap"
  ],
  [
    "찐몽가",
    "jjin"
  ],
  [
    "카니와 모몽가",
    "duo"
  ],
  [
    "세이렌",
    "siren"
  ],
  [
    "아노코",
    "anoko"
  ]
]);
const builtin = new Set(["chiikawa", "hachi", "usagi", "shisa", "rakko", "kuri", "kani", "momonga"]);
// Wallpapers are device-local and keyed by the selected character.
export function setupWallpaper(main, picker, reset, feedback) {
  let current, base, currentName, generation = 0, objectURL;
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('character-wallpapers', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function access(mode, operation) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const request = operation(tx.objectStore('images'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
  function paint(src, custom) {
    main.style.setProperty('--buddy-art', 'url(' + JSON.stringify(src) + ')');
    main.dataset.customWallpaper = String(custom);
  }
  async function select(id, portrait, name) {
    currentName = name;
    const key = scenes.get(name) || (builtin.has(id) ? id : null);
    main.style.setProperty("--buddy-scene", key ? "url(./scenes/" + key + ".webp)" : "none");
    current = id; base = portrait;
    const token = ++generation;
    paint(portrait, false);
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
    try {
      const blob = await access('readonly', store => store.get(id));
      if (token === generation && blob) { objectURL = URL.createObjectURL(blob); paint(objectURL, true); }
    } catch { /* Built-in portrait remains available. */ }
  }
  picker.onchange = async () => {
    const file = picker.files[0], id = current;
    picker.value = '';
    if (!file) return;
    try {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 12*1024*1024) throw Error('12MB 이하 PNG, JPG, WebP를 선택하세요.');
      const bitmap = await createImageBitmap(file); bitmap.close();
      await access('readwrite', store => store.put(file, id));
      if (current === id) { await select(id, base, currentName); feedback.textContent = '이 캐릭터의 배경을 저장했어요.'; }
    } catch (e) { feedback.textContent = e.message || '그림을 저장할 수 없어요.'; }
  };
  reset.onclick = async () => {
    const id = current;
    try { await access('readwrite', store => store.delete(id)); if(current === id){ await select(id,base,currentName); feedback.textContent='기본 배경으로 바꿨어요.'; } }
    catch { feedback.textContent = '배경을 바꾸지 못했어요.'; }
  };
  return select;
}
