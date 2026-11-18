// Explicit user requests only. The configured local bridge owns vault access;
// neither the model nor chat text can choose an executable or arbitrary file.
import {spawn} from 'node:child_process';
import path from 'node:path';
type Turn={role:string;text:string;at?:string};
export function obsidianIntent(text:string,history:Turn[]=[]):'save'|'status'|null{
 const t=text.trim();if(t.length>800||/하지\s*마|하지말|저장.*말[아고]|저장하지|취소|예시|번역|라는\s*(말|문장)|방법|어떻게/.test(t))return null;
 const topic=/옵시디언|obsidian|(?:업무|근무)\s*(?:기록|일지)|일간\s*(?:기록|일지)/i.test(t);
 const follow=/저장|기록해/.test(t)&&history.slice(-4).some(m=>/옵시디언|(?:업무|근무)\s*(?:기록|일지)|일간\s*(?:기록|일지)/.test(m.text));
 if(!topic&&!follow)return null;
 if(/저장\s*(해|해줘|해둬|해놔|해놓|해두|해주세요|해주|하자)|기록\s*(해줘|해둬|해놔|해놓|해두|해주세요)|(?:업무|근무)\s*(정리|기록)\s*(해줘|해둬|해놔)/.test(t)&&!/[?？]|했|됐|되었|해놨|해뒀|했는지/.test(t))return 'save';
 if(/저장|해놨|해뒀|했|됐|되었|어디|확인|상태|다.*기록|적고|쓰고|작성|기록.*(?:있|돼|되|됐|했)|업데이트/.test(t))return 'status';return null;
}
export async function invokeObsidian(action:string,arg:unknown,signal?:AbortSignal):Promise<any>{
 const bridge=process.env.CY_OBSIDIAN_BRIDGE;if(!bridge||!path.isAbsolute(bridge))return null;
 return new Promise(resolve=>{let out='',done=false;const child=spawn(process.execPath,[bridge],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','ignore']});
 const finish=(r:any)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve(r);};
 const cancel=()=>{child.kill();finish({ok:false,error:'요청을 중단했습니다. 저장 여부는 다시 확인해 주세요.'});};
 const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'저장 결과 확인 시간이 초과됐습니다. 완료 여부를 다시 확인해 주세요.'});},60000);
 child.stdout.on('data',b=>{out+=b;if(out.length>1000000)cancel();});child.on('error',()=>finish({ok:false,error:'옵시디언 연결을 실행하지 못했습니다.'}));child.on('close',()=>{try{finish(JSON.parse(out));}catch{finish({ok:false,error:'저장 결과를 확인하지 못했습니다.'});}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({action,arg}));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 });
}
export async function handleObsidianChat(text:string,history:Turn[],signal?:AbortSignal,invoke=invokeObsidian){
 const intent=obsidianIntent(text,history);if(!intent)return null;
 const r=await invoke(intent==='save'?'chat-save':'chat-status',{text,history:history.filter(m=>m.role==='user'||m.role==='assistant'&&m.text.length>=200).map(m=>({role:m.role,text:m.text,at:m.at}))},signal);
 if(r===null)return null;
 const reply=r.ok&&r.data?.verified===true?r.data.message:'옵시디언 저장 완료를 확인하지 못했어요. '+(r.error||'실제 파일 상태를 다시 확인해 주세요.');
 return {reply_md:reply,bubble:r.ok?'업무기록을 확인했어요.':'업무기록 확인이 필요해요.',show:null,proposals:[]};
}
