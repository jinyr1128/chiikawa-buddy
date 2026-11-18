import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMeetingService} from './meeting-service.js';
import fs from 'node:fs';
import os from 'node:os';
import {bundledCodexDirs} from './codex-paths.js';
import {completeCodex, codexBin} from './llm-check.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function setupMeetings({app,BrowserWindow,ipcMain,dialog,shell,powerMonitor}) {
 let win,mutating=false;
 const service=createMeetingService({dataDir:app.getPath('userData'),helper:process.platform==='darwin'?path.join(process.resourcesPath,'bin','meeting-audio'):'',complete:(request,options)=>completeCodex(request,{...options,bin:bundledCodexDirs(os.homedir()).map(d=>path.join(d,'codex')).find(p=>fs.existsSync(p))||codexBin()})});
 function show(){if(win&&!win.isDestroyed()){win.show();win.focus();return;}win=new BrowserWindow({width:1000,height:780,minWidth:700,minHeight:500,title:'회의 녹음 · 요약',backgroundColor:'#18181c',webPreferences:{preload:path.join(root,'meeting-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(root,'meeting.html'));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.on('close',e=>{if(service.isRecording){e.preventDefault();dialog.showMessageBox(win,{message:'녹음 중입니다. 먼저 녹음 종료를 눌러 주세요.',buttons:['확인']});}});}
 ipcMain.handle('meeting',async(event,action,data={})=>{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)return {ok:false,error:'허용되지 않은 요청'};const read=['state','apps','transcript'].includes(action);if(!read&&mutating)return {ok:false,error:'앞선 작업을 마친 뒤 다시 시도하세요.'};if(!read)mutating=true;
  try{let result;switch(action){case 'state':result=await service.state();break;case 'apps':result=await service.apps();break;case 'start':result=await service.start(data);break;case 'stop':await service.stop();break;case 'transcribe':result=await service.transcribe(data.id);break;case 'summarize':result=await service.summarize(data.id,data.consent);break;case 'transcript':result=await service.transcript(data.id);break;case 'export':result=await service.export(data.id);break;
   case 'choose':{if(service.isBusy||service.isRecording)throw Error('현재 작업이 끝난 뒤 설정을 바꿔 주세요.');if(!['folder','whisper','model','ffmpeg'].includes(data.key))throw Error('설정 항목 오류');const r=await dialog.showOpenDialog(win,{title:data.key==='folder'?'옵시디언 볼트 안의 회의 요약 폴더 선택':'설정할 파일 선택',properties:data.key==='folder'?['openDirectory','createDirectory']:['openFile','showHiddenFiles']});if(!r.canceled)await service.settings({[data.key]:r.filePaths[0]});break;}
   case 'import':{const r=await dialog.showOpenDialog(win,{title:'기존 녹음 가져오기',properties:['openFile'],filters:[{name:'음성 파일',extensions:['wav','mp3','m4a','mp4','aac','caf','ogg','flac']}]});if(!r.canceled)result=await service.importAudio(r.filePaths[0],data.title);break;}
   case 'open':{const m=await service.archive.get(data.id);shell.showItemInFolder(m.exported||path.join(await service.archive.dir(data.id),'meeting.json'));break;}
   default:throw Error('지원하지 않는 요청');}return {ok:true,result};
  }catch(e){return {ok:false,error:e.message||'작업 실패'};}finally{if(!read)mutating=false;}});
 powerMonitor.on('suspend',()=>{if(service.isRecording)service.stop().catch(()=>{});});
 let stopping=false;
 function blockQuit(e){if(service.isRecording){e.preventDefault();if(!stopping){stopping=true;service.stop().finally(()=>{stopping=false;app.quit();});}return true;}if(service.isBusy){e.preventDefault();show();dialog.showMessageBox(win,{message:'회의 처리 중입니다. 작업을 마친 뒤 종료해 주세요.',buttons:['확인']});return true;}return false;}
 return {show,blockQuit};
}
