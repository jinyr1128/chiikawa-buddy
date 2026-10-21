import {createCalendarSlackStatus} from "./calendar-slack-status.js";
import {createGroupware} from "./groupware-connect.js";
import path from 'node:path';
import {createWorkHub} from './work-hub.js';
import {createTeams} from './teams-connect.js';
export function setupWorkConnections({app,ipcMain,dialog,shell,clipboard,safeStorage,powerMonitor,Notification,fromOurs,request}) {
  const data=path.join(app.getPath('userData'),'work-connections');
  const teams=createTeams({data,encrypt:text=>{if(!safeStorage.isEncryptionAvailable()||(safeStorage.getSelectedStorageBackend?.()==='basic_text'))throw Error('운영체제 보안 저장소를 사용할 수 없어 Teams 토큰을 저장하지 않습니다.');return safeStorage.encryptString(text).toString('base64');},decrypt:text=>safeStorage.decryptString(Buffer.from(text,'base64'))});
  const hub=createWorkHub({data,request,teams,groupware:()=>groupware.status()});
  const slackStatus=createCalendarSlackStatus({data,request});
  const groupware=createGroupware({data,notify:count=>{if(Notification.isSupported())new Notification({title:"치이카와 · 그룹웨어",body:`새 알림 ${count}건`}).show();}});
  void groupware.init().catch(()=>{});
  let queue=Promise.resolve();
  ipcMain.handle('work-connections',async(e,action,arg)=>{
    if(!fromOurs(e))return {ok:false,error:'허용되지 않은 창'};
    const run=async()=>{try{
      let result;
      if(action==='status')result={notes:await hub.status(),teams:await teams.status(),slackStatus:await slackStatus.status(),groupware:groupware.status(),calendars:(await request("GET","/connectors/calendar")).data?.calendars||[]};
      else if(action==='pick-vault'||action==='pick-root'){
        const pick=await dialog.showOpenDialog({title:action==='pick-vault'?'본인 옵시디언 볼트 폴더 선택':'업무 자료 폴더 선택',properties:['openDirectory']});if(pick.canceled)return {ok:true,cancelled:true};
        const current=await hub.status();result=await hub.configure(action==='pick-vault'?{vault:pick.filePaths[0]}:{roots:[...new Set([...current.roots,pick.filePaths[0]])]});
      }else if(action==='configure'){
        if(!arg||Object.keys(arg).some(k=>!['folder','template','enabled'].includes(k)))throw Error('설정을 확인하세요.');result=await hub.configure(arg);
      }else if(action==='remove-root'){const current=await hub.status();result=await hub.configure({roots:current.roots.filter(p=>p!==arg)});}
      else if(action==='search')result=await hub.search(String(arg??''));
      else if(action==='select')result=await hub.select(arg.path,!!arg.on);
      else if(action==='open'){await shell.openExternal(await hub.open(String(arg)));result=true;}
      else if(action==='save')result=await hub.save(arg);
      else if(action==='run'){await hub.tick(true);result={started:true};}
      else if(action==='teams-start')result=await teams.start(arg);
      else if(action==='teams-login'){await shell.openExternal('https://microsoft.com/devicelogin');result=true;}
      else if(action==='teams-poll')result=await teams.poll();
      else if(action==='teams-disconnect'){await teams.disconnect();result=true;}
      else if(action==='teams-today')result=await teams.snapshot((await hub.status()).day);
      else if(action==='teams-prepare')result=await teams.prepare(arg);
      else if(action==='teams-send')result=await teams.send(String(arg));
      else if(action==='teams-cancel'){teams.cancel();result=true;}
      else if(action==="slack-status-configure")result=await slackStatus.configure(arg);
      else if(action==="slack-status-check")result=await slackStatus.inspect();
      else if(action==="groupware-configure")result=await groupware.configure(arg);
      else if(action==="groupware-pair"){clipboard.writeText(groupware.pairing().key);result={copied:true};}
      else throw Error('지원하지 않는 동작');
      return {ok:true,data:result};
    }catch(error){return {ok:false,error:error.message||'업무 연결 확인 필요'};}};
    const result=queue.then(run);queue=result.catch(()=>{});return result;
  });
  const tick=()=>{const run=queue.then(async()=>{await hub.tick();await slackStatus.tick();});queue=run.catch(()=>{});};
  const timer=setInterval(tick,60000);timer.unref?.();
  const initial=setTimeout(tick,30000);initial.unref?.();
  powerMonitor.on('resume',tick);
  app.on('before-quit',()=>{clearInterval(timer);clearTimeout(initial);void groupware.stop();powerMonitor.removeListener('resume',tick);});
  return {hub,teams};
}
