// Only the existing connected user's status fields. Never expose the token or full profile.
export async function profileStatus(token: string|undefined, patch: any=null, fetcher: typeof fetch=fetch){
 if(!token)return {ok:false,error:'Slack 연결이 필요합니다.'};
 try{
 const auth=await fetcher('https://slack.com/api/auth.test',{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
 const a=await auth.json();if(!a.ok)return {ok:false,error:'Slack 인증을 확인해 주세요.'};
 const scopes=(auth.headers.get('x-oauth-scopes')||'').split(',').map(s=>s.trim());
 const canRead=scopes.includes('users.profile:read'),canWrite=scopes.includes('users.profile:write');
 if(!canRead||!canWrite)return {ok:false,canRead,canWrite,error:'Slack 상태 연동 권한 필요: '+[!canRead&&'users.profile:read',!canWrite&&'users.profile:write'].filter(Boolean).join(', ')};
 let endpoint='users.profile.get',body;
 if(patch!==null){
  if(!patch||typeof patch.status_text!=='string'||patch.status_text.length>100||typeof patch.status_emoji!=='string'||patch.status_emoji.length>100||!Number.isSafeInteger(patch.status_expiration)||patch.status_expiration<0)return {ok:false,error:'상태 값이 올바르지 않습니다.'};
  endpoint='users.profile.set';body=JSON.stringify({profile:{status_text:patch.status_text,status_emoji:patch.status_emoji,status_expiration:patch.status_expiration}});
 }
 const r=await fetcher('https://slack.com/api/'+endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=utf-8'},...(body?{body}:{}),signal:AbortSignal.timeout(15000)});
 const j=await r.json();if(!j.ok)return {ok:false,error:'Slack 상태 처리 실패: '+String(j.error||'unknown'),canRead,canWrite};
 const p=j.profile||{};return {ok:true,canRead,canWrite,profile:{status_text:p.status_text||'',status_emoji:p.status_emoji||'',status_expiration:p.status_expiration||0}};
 }catch{return {ok:false,error:'Slack 상태 조회 연결 실패'};}
}
