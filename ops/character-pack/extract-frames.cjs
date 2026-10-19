// 영상(webm) → 장면 PNG 들. Electron(크로미엄)이 webm 을 풀 수 있어서 이걸로 뽑는다
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'); const path = require('path');
const [src, outDir, fps] = process.argv.slice(-3);
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  ipcMain.on('frame', (_e, i, data) => fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(data.split(',')[1], 'base64')));
  ipcMain.on('done', (_e, n, dur) => { console.log('frames', n, 'dur', dur); app.quit(); });
  const html = `<video id=v muted src="file://${src}"></video><canvas id=c></canvas><script>
  const {ipcRenderer}=require('electron'); const v=document.getElementById('v'), c=document.getElementById('c');
  v.addEventListener('loadeddata', async()=>{ c.width=v.videoWidth; c.height=v.videoHeight; const x=c.getContext('2d'); const step=1/${Number(fps)}; let i=0;
    for(let t=0;t<v.duration-0.001;t+=step){ await new Promise(r=>{v.onseeked=r; v.currentTime=t;}); x.clearRect(0,0,c.width,c.height); x.drawImage(v,0,0); ipcRenderer.send('frame',i++,c.toDataURL('image/png')); }
    ipcRenderer.send('done',i,v.duration); });
  </script>`;
  fs.writeFileSync(path.join(outDir, '..', 'p.html'), html);
  w.loadFile(path.join(outDir, '..', 'p.html'));
});
