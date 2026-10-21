import fs from 'node:fs/promises';import path from 'node:path';
const day=(now)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(now);
const LEAVE=/연차|휴가|반차|시간\s*휴가|휴무|\bOOO\b|out of office|vacation/i;
const MEETING=/회의|미팅|면담|면접|설명회|리허설|meeting|interview|sync|standup|1[:：]1/i;
export function chooseStatus(events,{personalIds=[],meetingIds=[]}={},now=new Date()){
 const n=+now,d=day(now);const active=events.filter(e=>!e.cancelled&&!['declined','decline'].includes(e.response)&&
  (e.allDay&&e.startDay&&e.endDay?e.startDay<=d&&d<e.endDay:Date.parse(e.start)<=n&&n<Date.parse(e.end)));
 const leave=active.filter(e=>personalIds.includes(e.calId)&&LEAVE.test(e.title||'')).sort((a,b)=>Date.parse(b.end)-Date.parse(a.end))[0];
 const meeting=active.filter(e=>meetingIds.includes(e.calId)&&!e.allDay&&!e.free&&(MEETING.test(e.title||'')||e.joinUrl)).sort((a,b)=>Date.parse(b.end)-Date.parse(a.end))[0];
 const e=leave||meeting;if(!e)return null;
 return {id:e.id,end:Date.parse(e.end),kind:leave?'연차·휴가':'회의',profile:{status_text:leave?'연차·휴가 중':'회의 중',status_emoji:leave?':palm_tree:':':calendar:',status_expiration:Math.floor(Date.parse(e.end)/1000)}};
}
const same=(a,b)=>a&&b&&a.status_text===b.status_text&&a.status_emoji===b.status_emoji&&a.status_expiration===b.status_expiration;
export function createCalendarSlackStatus({data,request,now=()=>new Date()}){
 const file=path.join(data,'calendar-slack-status.json');let state={enabled:false,personalIds:[],meetingIds:[],phase:'개인 일정 캘린더 선택 필요',priority:'연차·휴가 > 회의'},busy=false;
 async function load(){try{state={...state,...JSON.parse(await fs.readFile(file,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}}
 async function persist(){await fs.mkdir(data,{recursive:true});await fs.writeFile(file,JSON.stringify(state,null,2),{mode:0o600});}
 async function call(method,url,body){const r=await request(method,url,body);if(!r.ok||r.data?.ok===false)throw Error(r.data?.error||'연결 확인 필요');return r.data;}
 async function inspect(){await load();const r=await request('GET','/slack/profile-status');state.permission=r.data?.ok?'상태 읽기·변경 가능':r.data?.error||'상태 권한 확인 실패';await persist();return state;}
 async function select(id){const c=await call('GET','/connectors/calendar');if(!(c.calendars||[]).some(c=>c.id===id))throw Error('연결된 캘린더를 선택해 주세요.');await load();state.personalIds=[id];state.phase='연차 우선 · 자동 상태 대기';await persist();return state;}
 async function tick(){if(busy)return;busy=true;try{
  await load();if(!state.enabled)return;
  const today=day(now());const from=new Date(today+'T00:00:00+09:00'),to=new Date(+from+86400000);
  const data=await call('GET','/calendar/events?from='+encodeURIComponent(from.toISOString())+'&to='+encodeURIComponent(to.toISOString()));
  if(data.ok===false)throw Error('캘린더 조회 실패');
  const desired=chooseStatus(data.events||[],state,now());
  // Until personal leave calendar is selected, do not apply meeting status: leave must win.
  if(!state.personalIds.length){state.phase=(state.personalCalendarName||'개인 일정')+' 캘린더 연결 필요 · 회의 자동 변경도 대기';await persist();return;}
  const p=await call('GET','/slack/profile-status');state.permission='상태 읽기·변경 가능';const current=p.profile;
  if(state.applied&&!same(current,state.applied.profile)){
   const expired=+now()>=state.applied.end&&!current.status_text&&!current.status_emoji;
   if(!expired){state.suppressedUntil=state.applied.end;state.previous=null;state.applied=null;state.phase='직접 변경한 Slack 상태 유지';await persist();return;}
  }
  if(state.suppressedUntil>+now()){state.phase='직접 변경한 Slack 상태 유지';return;}
  if(desired){
   if(!state.applied&&(current.status_text||current.status_emoji)){state.phase='기존 Slack 상태 유지 · 직접 설정된 상태 있음';await persist();return;}
   if(!same(current,desired.profile)){
    if(!state.applied)state.previous=current;
    await call('POST','/slack/profile-status',desired.profile);state.applied=desired;
   }state.phase=desired.kind+' 상태 적용 중';
  }else if(state.applied){
   const prev=state.previous;const restore=prev&&(!prev.status_expiration||prev.status_expiration*1000>+now())?prev:{status_text:'',status_emoji:'',status_expiration:0};
   await call('POST','/slack/profile-status',restore);state.applied=null;state.previous=null;state.phase='일정 종료 · 자동 상태 해제';
  }else state.phase='진행 중인 연차·회의 없음';
  state.lastChecked=now().toISOString();await persist();
 }catch(e){state.phase=e.message;await persist();}finally{busy=false;}return state;}
 return {tick,inspect,select,configure:async(patch)=>{await load();if(busy)throw Error("상태 갱신 중입니다.");if(typeof patch.enabled!=="boolean"||!Array.isArray(patch.personalIds)||!Array.isArray(patch.meetingIds))throw Error("캘린더 설정을 확인하세요.");const calendars=await call("GET","/connectors/calendar");const ids=new Set((calendars.calendars||[]).map(c=>c.id));if([...patch.personalIds,...patch.meetingIds].some(id=>!ids.has(id)))throw Error("연결된 캘린더를 선택하세요.");if(!patch.enabled&&state.applied){const current=(await call("GET","/slack/profile-status")).profile;if(same(current,state.applied.profile))await call("POST","/slack/profile-status",{status_text:"",status_emoji:"",status_expiration:0});state.applied=null;}state={...state,enabled:patch.enabled,personalIds:patch.personalIds,meetingIds:patch.meetingIds,phase:patch.enabled?"자동 상태 대기":"꺼짐"};await fs.mkdir(data,{recursive:true});await persist();return state;},status:async()=>{await load();return state;}};
}
