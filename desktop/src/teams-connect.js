// Delegated Microsoft Graph connection; tokens are encrypted by the OS key store.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const GRAPH='https://graph.microsoft.com/v1.0';
const SCOPES='offline_access User.Read Chat.Read ChatMessage.Send Calendars.Read';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const teamsText = s => String(s??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,1500);
export function createTeams({data,encrypt,decrypt,fetch:fetcher=fetch,now=()=>Date.now()}) {
  const file=path.join(data,'teams.enc');let config=null,flow=null,generation=0,refreshing=null;
  const drafts=new Map();
  async function load(){if(config)return;try{config=JSON.parse(decrypt(await fs.readFile(file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw Error('Teams 연결 정보를 읽지 못했습니다. 다시 연결하세요.');}}
  async function save(){await fs.mkdir(data,{recursive:true});const encoded=encrypt(JSON.stringify(config));await fs.writeFile(file+'.tmp',encoded,{mode:0o600});await fs.rename(file+'.tmp',file);}
  const endpoint=(tenant,part)=>`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${part}`;
  async function form(url,body){const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),signal:AbortSignal.timeout(20000),redirect:'error'});const d=await r.json();return {ok:r.ok,data:d};}
  async function access(){await load();if(!config)throw Error('Teams를 연결하세요.');if(config.expires>now()+60000)return config.access;
    if(refreshing)return refreshing;
    const gen=generation,c={...config};
    refreshing=(async()=>{const r=await form(endpoint(c.tenant,'token'),{client_id:c.client,grant_type:'refresh_token',refresh_token:c.refresh,scope:SCOPES});if(!r.ok)throw Error('Teams 로그인이 만료됐습니다. 다시 연결하세요.');if(gen!==generation)throw Error('Teams 연결이 변경됐습니다.');config={...c,access:r.data.access_token,refresh:r.data.refresh_token||c.refresh,expires:now()+r.data.expires_in*1000};await save();return config.access;})();
    try{return await refreshing;}finally{refreshing=null;}
  }
  async function graph(route){if(!route.startsWith('/'))throw Error('잘못된 Teams 요청');const token=await access();const r=await fetcher(GRAPH+route,{headers:{Authorization:`Bearer ${token}`,Prefer:'outlook.timezone="Asia/Seoul"'},signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw Error(r.status===403?'Teams 조회 권한 또는 조직 관리자 승인이 필요합니다.':`Teams 조회 실패 (${r.status})`);return r.json();}
  async function start({client,tenant='organizations'}) {
    if(!uuid.test(String(client))||!(tenant==='organizations'||uuid.test(String(tenant))))throw Error('애플리케이션 ID와 조직 ID를 확인하세요.');
    // Verify encryption availability before issuing an authorization request.
    encrypt('{}');generation++;
    const r=await form(endpoint(tenant,'devicecode'),{client_id:client,scope:SCOPES});if(!r.ok)throw Error('Teams 로그인 시작 실패. 앱 등록의 퍼블릭 클라이언트 흐름 허용과 권한을 확인하세요.');
    flow={client,tenant,device:r.data.device_code,code:r.data.user_code,expires:now()+r.data.expires_in*1000,interval:Math.max(5,r.data.interval||5)*1000,next:now()};
    return {code:flow.code,url:'https://microsoft.com/devicelogin',expires:flow.expires};
  }
  async function poll(){if(!flow)return {pending:false};if(now()>flow.expires){flow=null;throw Error('로그인 코드가 만료됐습니다. 다시 시작하세요.');}if(now()<flow.next)return {pending:true};
    const f=flow,gen=generation;f.next=now()+f.interval;
    const r=await form(endpoint(f.tenant,'token'),{client_id:f.client,grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:f.device});
    if(gen!==generation||flow!==f)return {pending:false};
    if(!r.ok){if(r.data.error==='authorization_pending')return {pending:true};if(r.data.error==='slow_down'){f.interval+=5000;f.next=now()+f.interval;return {pending:true};}flow=null;throw Error('Teams 로그인 승인 실패 또는 만료. 조직 정책과 동의 화면을 확인하세요.');}
    config={client:f.client,tenant:f.tenant,access:r.data.access_token,refresh:r.data.refresh_token,expires:now()+r.data.expires_in*1000};flow=null;await save();return {connected:true};
  }
  async function snapshot(day){
    const chats=await graph('/me/chats?$top=20');const items=[];let partial=!!chats['@odata.nextLink'];
    for(const chat of (chats.value||[]).slice(0,20)){
      try{const messages=await graph(`/chats/${encodeURIComponent(chat.id)}/messages?$top=30`);if(messages['@odata.nextLink'])partial=true;
        for(const m of messages.value||[]){if(!m.createdDateTime||m.deletedDateTime)continue;const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(m.createdDateTime));if(date===day)items.push({source:'Teams 채팅 · 처리 완료 근거 아님',title:chat.topic||m.from?.user?.displayName||'Teams 대화',text:teamsText(m.body?.content),at:m.createdDateTime,chatId:chat.id,messageId:m.id,mentioned:!!m.mentions?.length});}
      }catch{partial=true;}
    }
    const from=day+'T00:00:00+09:00',to=new Date(Date.parse(from)+86400000).toISOString();
    const events=await graph('/me/calendarView?startDateTime='+encodeURIComponent(from)+'&endDateTime='+encodeURIComponent(to)+'&$top=100');
    for(const e of events.value||[])if(!e.isCancelled)items.push({source:'Teams/Microsoft 365 일정 · 예정, 참석 확인 안 됨',title:e.subject||'일정',at:e.start?.dateTime});
    return {items:items.slice(0,200),partial:partial||!!events['@odata.nextLink']};
  }
  const participants=c=>(c.members||[]).map(m=>m.userId||m.id).sort().join('|');
  async function prepare({chatId,text}){
    if(typeof chatId!=='string'||!chatId||chatId.length>500||typeof text!=='string'||!text.trim()||text.length>4000)throw Error('대화방과 답장 내용(4,000자 이하)을 확인하세요.');
    const gen=generation,c=await graph('/chats/'+encodeURIComponent(chatId)+'?$expand=members');
    if(gen!==generation)throw Error('Teams 계정이 변경됐습니다.');
    if(!c.members?.length||c.members.length>100||c['members@odata.nextLink'])throw Error('받는 사람 전체를 확인할 수 없어 전송을 준비하지 않았습니다. Teams 앱에서 확인하세요.');
    const id=randomUUID();drafts.clear();
    const draft={id,chatId,text:text.trim(),title:c.topic||'Teams 대화',recipients:c.members.map(m=>m.displayName||'이름 없음'),members:participants(c),generation:gen,expires:now()+300000};drafts.set(id,draft);
    return {id,title:draft.title,recipients:draft.recipients,text:draft.text,expires:draft.expires};
  }
  async function send(id){
    const d=drafts.get(id);drafts.delete(id);
    if(!d||d.expires<now()||d.generation!==generation)throw Error('전송 확인이 만료됐습니다. 내용을 다시 확인하세요.');
    const c=await graph('/chats/'+encodeURIComponent(d.chatId)+'?$expand=members');
    if(participants(c)!==d.members||d.generation!==generation)throw Error('받는 사람 또는 계정이 바뀌었습니다. 다시 확인하세요.');
    const token=await access();if(d.generation!==generation)throw Error('Teams 계정이 바뀌었습니다.');
    let r;try{r=await fetcher(GRAPH+'/chats/'+encodeURIComponent(d.chatId)+'/messages',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({body:{contentType:'text',content:d.text}}),signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw Error('전송 결과를 확인할 수 없습니다. 중복 방지를 위해 재전송하지 않았습니다. Teams 대화방에서 확인하세요.');}
    if(!r.ok)throw Error(r.status===403?'Teams 전송 권한(ChatMessage.Send)과 조직 승인을 확인하세요.':'Teams 전송 실패 또는 결과 불명확. 다시 보내기 전 Teams 대화방을 확인하세요.');
    return {sent:true};
  }
  return {start,poll,snapshot,prepare,send,cancel:()=>drafts.clear(),status:async()=>{await load();return {connected:!!config,pending:!!flow,client:config?.client||'',tenant:config?.tenant||'organizations',scope:'회사·학교 계정의 채팅·멘션 포함 메시지·일정 조회, 확인 후 대화방에 답장 전송. 채널은 제외합니다.'};},disconnect:async()=>{generation++;drafts.clear();config=null;flow=null;await fs.rm(file,{force:true});},graph};
}
