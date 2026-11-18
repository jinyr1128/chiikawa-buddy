import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const meetingStamp=(date=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
export const meetingTitle=(date=new Date())=>{const s=meetingStamp(date);return s.slice(2,10).replaceAll('-','')+' '+s.slice(11,13)+'시'+s.slice(14,16)+'분 회의';};
const safeName=s=>String(s).replace(/[\\/<>:"|?*\[\]#\r\n]/g,' ').trim().slice(0,45);
export const safeTranscript=s=>String(s).split('\n').filter(l=>!/(01[016789][- .]?\d{3,4}[- .]?\d{4}|\d{6}\s*-\s*[1-8]\d{6}|비밀번호|password|api[_ -]?key|(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{10,})/i.test(l)).join('\n');
export async function atomicJSON(file,value){const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(tmp,file);}
export async function checkedDir(root){await fs.mkdir(root,{recursive:true,mode:0o700});if((await fs.lstat(root)).isSymbolicLink())throw Error('바로가기 저장 폴더는 사용할 수 없습니다.');return fs.realpath(root);}
export function createMeetingArchive(root) {
 const valid=id=>/^\d{4}-\d{2}-\d{2}_[a-f0-9-]{36}$/.test(id);
 async function dir(id){if(!valid(id))throw Error('회의 ID가 올바르지 않습니다.');const base=await checkedDir(root);const d=path.join(base,id);if((await fs.lstat(d)).isSymbolicLink())throw Error('바로가기 회의는 열 수 없습니다.');return d;}
 async function get(id){return JSON.parse(await fs.readFile(path.join(await dir(id),'meeting.json'),'utf8'));}
 async function update(id,patch){const m=await get(id);const next={...m,...patch,id};await atomicJSON(path.join(await dir(id),'meeting.json'),next);return next;}
 return {dir,get,update,async list(){const base=await checkedDir(root);const out=[];for(const e of await fs.readdir(base,{withFileTypes:true})){if(e.isDirectory()&&valid(e.name))try{out.push(await get(e.name));}catch{}}return out.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));},
 async create({title='',mode='mic',appName='',now=new Date()}={}){if(!['mic','online','import'].includes(mode))throw Error('녹음 방식을 확인하세요.');const day=meetingStamp(now).slice(0,10),id=day+'_'+randomUUID(),base=await checkedDir(root),d=path.join(base,id);await fs.mkdir(d,{mode:0o700});const m={id,day,title:safeName(title)||meetingTitle(now),mode,appName,startedAt:now.toISOString(),phase:'준비',revisions:[]};await atomicJSON(path.join(d,'meeting.json'),m);return m;},
 async saveRevision(id,kind,text){if(!['transcript','summary'].includes(kind))throw Error('잘못된 기록 종류');if(typeof text!=='string'||!text.trim())throw Error('저장할 내용이 없습니다.');const d=await dir(id),name=kind+'-'+Date.now()+'-'+randomUUID().slice(0,8)+'.md';await fs.writeFile(path.join(d,name),text,{flag:'wx',mode:0o600});const m=await get(id);await update(id,{[kind]:name,revisions:[...(m.revisions||[]),name]});return name;},
 async exportNote(id,folder){const m=await get(id),d=await dir(id),out=await checkedDir(folder),stem=safeName(m.title)+' '+id.slice(-8),recordDir=await checkedDir(path.join(out,'첨부',stem));
   for(const name of ['microphone.wav','system.caf','audio.wav',...(m.importFile?[m.importFile]:[]),...(m.revisions||[])]){if(!/^[\w.-]+$/.test(name))continue;try{await fs.copyFile(path.join(d,name),path.join(recordDir,name),fs.constants.COPYFILE_EXCL);}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}}
   const summary=m.summary?await fs.readFile(path.join(d,m.summary),'utf8'):'아직 요약하지 않았습니다. 전사 후 Codex 요약을 실행하세요.';
   const version=m.summary?m.summary.replace('summary-','').replace('.md',''):'원본-'+Date.now();
   const noteName=stem+' '+version+'.md';
   const links=(m.revisions||[]).map(n=>`- [[첨부/${stem}/${n}|${n.startsWith('transcript')?'전사문':'이전 요약'}]]`).join('\n');
   const body=`---\ndate: "${m.day}"\ntype: meeting-notes\nconfidential: true\nmeeting_id: "${id}"\ntags: [회의록]\n---\n\n# ${m.title}\n\n- 시작: ${meetingStamp(new Date(m.startedAt))} (한국 시간)\n- 수집: ${m.mode==='online'?'선택한 앱 소리 + 마이크':m.mode==='mic'?'마이크':'가져온 녹음 · 실제 회의 일시 확인 필요'}\n- 녹음: [[첨부/${stem}/audio.wav|정리용 오디오]]\n${m.mode==='import'?`- 가져온 원본: [[첨부/${stem}/${m.importFile}]]\n`:`- 마이크 원본: [[첨부/${stem}/microphone.wav]]\n`}${m.mode==='online'?`- 앱 오디오 원본: [[첨부/${stem}/system.caf]]\n`:''}\n${links}\n\n${summary}\n\n<!-- GRAPH-LINKS:START -->\n## 🧠 신경망 연결\n- 회의 허브: [[회의 요약]]\n- 신경 신호: #회의록\n<!-- GRAPH-LINKS:END -->\n`;
   try{await fs.writeFile(path.join(out,noteName),body,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
   const hub=path.join(out,'회의 요약.md');try{await fs.writeFile(hub,'---\ntype: hub\ntags: [회의록, 업무허브]\n---\n\n# 회의 요약\n\n녹음 원본·전사문·요약은 첨부 폴더와 연결됩니다. 요약 재실행은 새 기록을 만들며 기존 회의록을 덮어쓰지 않습니다.\n\n<!-- GRAPH-LINKS:START -->\n## 🧠 신경망 연결\n- 신경 신호: #회의록 #업무허브\n<!-- GRAPH-LINKS:END -->\n\n## 회의 기록\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
   const line=`- [[${noteName.slice(0,-3)}|${m.title}]]\n`;const content=await fs.readFile(hub,'utf8');if(!content.includes(line))await fs.appendFile(hub,line);await update(id,{exported:path.join(out,noteName)});return path.join(out,noteName);
 }};
}
