import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {workDay,noteSnapshot,saveWorkNote,readNote} from '../src/work-notes.js';
import {createWorkHub} from '../src/work-hub.js';
import {createTeams,teamsText} from '../src/teams-connect.js';
import {chooseStatus} from '../src/calendar-slack-status.js';
import {createGroupware} from '../src/groupware-connect.js';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'work-connect-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const vault=path.join(root,'vault');await fs.mkdir(vault);return {root,vault};}
test('노트: 날짜 전환·수기 보존·자동 영역만 갱신·사용자 템플릿 보존',async t=>{
 const {vault}=await fixture(t),c={vault,folder:'일지',selected:['일지/2026-10-20.md']};
 await saveWorkNote(c,{day:'2026-10-20',title:'수기',body:'- [ ] 어제 할 일'});
 const before=await noteSnapshot(c,new Date('2026-10-20T15:01:00Z'));assert.equal(before.day,'2026-10-21');assert.equal(before.todayExists,false);assert.deepEqual(before.tasks,[]);
 await fs.writeFile(path.join(vault,'양식.md'),'---\ndate: {{date}}\n---\n<!-- GRAPH-LINKS:START -->\n[[내 허브]]\n<!-- GRAPH-LINKS:END -->\n');c.template='양식.md';
 await saveWorkNote(c,{day:'2026-10-21',title:'수기',body:'직접 쓴 내용'});
 await saveWorkNote(c,{day:'2026-10-21',title:'자동 정리',body:'첫 정리',summary:true});
 await saveWorkNote(c,{day:'2026-10-21',title:'자동 정리',body:'두 번째 정리',summary:true});
 const result=await readNote(c,'일지/2026-10-21.md');assert.match(result,/date: 2026-10-21/);assert.match(result,/GRAPH-LINKS/);assert.match(result,/직접 쓴 내용/);assert.match(result,/두 번째 정리/);assert.doesNotMatch(result,/첫 정리/);
 assert.match(await readNote(c,'일지/2026-10-20.md'),/어제 할 일/);
});
test('노트: 볼트 이탈·심볼릭 링크·민감정보 저장 거부',async t=>{
 const {root,vault}=await fixture(t);const c={vault,folder:'../outside'};
 await assert.rejects(saveWorkNote(c,{title:'제목',body:'본문'}));
 if(process.platform!=='win32'){await fs.symlink(root,path.join(vault,'link'));await assert.rejects(saveWorkNote({...c,folder:'link'},{title:'제목',body:'본문'}));}
 await assert.rejects(saveWorkNote({...c,folder:'일지'},{title:'제목',body:'password: do-not-store'}));
 await assert.rejects(readNote(c,'업무용 계정 현황.md'));
});
test('업무정리: 기본 꺼짐, 수동 실행 중복 방지, 자정이 넘어도 시작 날짜에 저장',async t=>{
 const {root,vault}=await fixture(t);let date=new Date('2026-10-21T14:59:00Z'),posts=0,answer=false;
 const request=async(method,url)=>{if(method==='POST'){posts++;return {ok:true,data:{id:'t'}};}if(url.startsWith('/work-summary/'))return {ok:true,data:answer?{state:"done",reply:"오늘 업무를 정리했습니다."}:{state:"running"}};if(url.startsWith('/todos/'))return {ok:true,data:{entries:[{by:'user',day:'2026-10-21',title:'자료 작성',action:'done'}]}};if(url.startsWith('/runs'))return {ok:true,data:{runs:[]}};return {ok:true,data:{items:[]}};};
 const hub=createWorkHub({data:path.join(root,'state'),request,now:()=>date});await hub.configure({vault});await hub.tick();assert.equal(posts,0);
 await Promise.all([hub.tick(true),hub.tick(true)]);assert.equal(posts,1);answer=true;date=new Date('2026-10-21T15:01:00Z');await hub.tick();
 assert.match(await readNote({vault,folder:'일일 업무기록'},'일일 업무기록/2026-10-21.md'),/오늘 업무/);assert.equal((await hub.status()).day,'2026-10-22');
});
test('Teams: 디바이스 로그인·암호화 저장·토큰 비노출·연결 해제',async t=>{
 const {root}=await fixture(t);let pending=true;const client='00000000-0000-0000-0000-000000000001';
 const fetch=async url=>{if(url.endsWith('/devicecode'))return Response.json({device_code:'private-device',user_code:'CODE',expires_in:900,interval:5});if(url.endsWith('/token'))return pending?Response.json({error:'authorization_pending'},{status:400}):Response.json({access_token:'access-value',refresh_token:'refresh-value',expires_in:3600});throw Error('unexpected');};
 let time=0;const teams=createTeams({data:root,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString(),fetch,now:()=>time});
 assert.equal((await teams.status()).connected,false);const flow=await teams.start({client});assert.equal(flow.code,'CODE');assert.equal((await teams.poll()).pending,true);pending=false;time=6000;await teams.poll();assert.equal((await teams.status()).connected,true);assert.doesNotMatch(JSON.stringify(await teams.status()),/access-value|refresh-value/);assert.doesNotMatch(await fs.readFile(path.join(root,'teams.enc'),'utf8'),/access-value/);await teams.disconnect();assert.equal((await teams.status()).connected,false);
});
test('Teams: 단순 HTML 텍스트 변환, 잘못된 조직·클라이언트 ID 거부',async t=>{
 const {root}=await fixture(t);assert.equal(teamsText('<p>일정 &amp; 자료</p>'),'일정 & 자료');const teams=createTeams({data:root,encrypt:s=>s,decrypt:s=>s});await assert.rejects(teams.start({client:'not-an-id',tenant:'https://other.example'}));
});
test('Teams 답장: 미리보기는 전송하지 않음, 확인당 한 번 전송, 대상 변경과 시간초과 방어',async t=>{
 const {root}=await fixture(t);let recipients=[{id:'member',displayName:'Example User'}],sends=0,fail=false;
 const fetch=async(url,init)=>{
  if(url.endsWith('/devicecode'))return Response.json({device_code:'d',user_code:'C',expires_in:900});
  if(url.endsWith('/token'))return Response.json({access_token:'a',refresh_token:'r',expires_in:3600});
  if(init.method==='POST'){sends++;assert.equal(JSON.parse(init.body).body.contentType,'text');if(fail)throw Error('timeout');return Response.json({id:'sent'},{status:201});}
  return Response.json({topic:'Test room',members:recipients});
 };
 const teams=createTeams({data:root,encrypt:s=>s,decrypt:s=>s,fetch});
 await teams.start({client:'00000000-0000-0000-0000-000000000001'});await teams.poll();
 const a=await teams.prepare({chatId:'room',text:'확인했습니다.'});assert.equal(sends,0);assert.deepEqual(a.recipients,['Example User']);
 await teams.send(a.id);assert.equal(sends,1);await assert.rejects(teams.send(a.id));assert.equal(sends,1);
 const b=await teams.prepare({chatId:'room',text:'두 번째'});recipients.push({id:'new',displayName:'New User'});await assert.rejects(teams.send(b.id));assert.equal(sends,1);
 const c=await teams.prepare({chatId:'room',text:'세 번째'});fail=true;await assert.rejects(teams.send(c.id),/결과를 확인할 수 없습니다/);await assert.rejects(teams.send(c.id));assert.equal(sends,2);
 const d=await teams.prepare({chatId:'room',text:'취소'});await teams.disconnect();await assert.rejects(teams.send(d.id));assert.equal(sends,2);
});
test('Slack 상태: 연차 우선, 지정하지 않은 캘린더는 제외',()=>{
 const now=new Date('2026-10-21T01:00:00Z');const events=[{id:'m',calId:'work',title:'회의',start:'2026-10-21T00:00:00Z',end:'2026-10-21T02:00:00Z'},{id:'l',calId:'leave',title:'연차',start:'2026-10-20T15:00:00Z',end:'2026-10-21T15:00:00Z'}];
 assert.equal(chooseStatus(events,{personalIds:['leave'],meetingIds:['work']},now).kind,'연차·휴가');assert.equal(chooseStatus(events,{personalIds:[],meetingIds:[]},now),null);assert.equal(workDay(now),'2026-10-21');
});
test('그룹웨어: 사이트·연결 키 검사, 첫 목록 무알림, 동시 요청 중복 방지',async t=>{
 const {root}=await fixture(t);let notices=0;
 const group=createGroupware({data:root,port:0,notify:n=>notices+=n});
 t.after(()=>group.stop());await group.init();
 await group.configure({enabled:true,url:'https://group.example/path'});
 const key=group.pairing().key,url=`http://127.0.0.1:${group.status().port}/ingest`;
 const send=(items,k=key,site='https://group.example')=>fetch(url,{method:'POST',headers:{Origin:'chrome-extension://'+'a'.repeat(32),'Content-Type':'application/json','X-Chiikawa-Key':k},body:JSON.stringify({url:site,items})});
 assert.equal((await send([],'wrong')).status,403);
 assert.equal((await send([],key,'https://other.example')).status,400);
 assert.equal((await send([{title:'기존 알림'}])).status,200);assert.equal(notices,0);
 await Promise.all([send([{title:'새 알림'}]),send([{title:'새 알림'}])]);
 assert.equal(notices,1);assert.equal(group.status().recent.length,1);
 assert.doesNotMatch(JSON.stringify(group.status()),new RegExp(key));
});
