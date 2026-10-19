// 패널 머리의 ⚙ → 설정 창. panel.js 와 따로 둔 작은 모듈(버튼 하나만 다룬다)
const btn = document.getElementById('open-settings');
if (btn) {
  if (!window.cy?.openSettings) btn.hidden = true;
  else btn.addEventListener('click', () => window.cy.openSettings());
}
