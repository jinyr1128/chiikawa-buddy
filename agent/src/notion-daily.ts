// Opt-in daily journal. Writes only new child pages under the user's selected page.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { writeFileAtomic } from './fs-atomic.ts';
import type { NotionConn } from './notion.ts';
export const dailyClock = (now: Date) => {
  const parts = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  const day=parts.slice(0,10); return {day,time:parts.slice(11,16),week:new Date(day+'T12:00:00Z').getUTCDay()};
};
export function journalPageId(value: unknown): string {
  if(typeof value!=='string') throw Error('저장할 노션 페이지 주소를 넣어 주세요.');
  let text=value.trim();
  if(text.startsWith('https://')) {const u=new URL(text);if(!/(^|\.)notion\.(so|site)$/.test(u.hostname))throw Error('노션 페이지 주소를 넣어 주세요.');text=u.pathname.split('/').at(-1)||'';}
  const id=text.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)?.[1];
  if(!id)throw Error('노션 페이지 주소를 확인해 주세요.');
  const s=id.replaceAll('-','').toLowerCase();return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
const PRIVATE=/[\w.+-]+@[\w.-]+\.[a-z]{2,}|01[016789][- .]?\d{3,4}[- .]?\d{4}|\d{6}\s*-\s*[1-8]\d{6}|비밀번호|업무용 아이디 모음|업무용 계정 현황|\b(?:password|token|api[_ -]?key)\s*[:=]|(?:sk-|ntn_|secret_|xox[baprs]-)[A-Za-z0-9-]{10,}/i;
export const journalSafe = (v: unknown) => String(v??'').split('\n').filter(x=>!PRIVATE.test(x)).join('\n').trim().slice(0,12000);
export function journalFacts(entries: any[], jobs: any[], day: string) {
 return [...entries.filter(e=>e.by==='user'&&e.day===day).map(e=>({source:'할 일 변경',title:journalSafe(e.title),status:e.action})),
 ...jobs.filter(r=>!r.routine&&['chat','fix','action'].includes(r.kind)&&Number.isFinite(Date.parse(r.startedAt))&&dailyClock(new Date(r.startedAt)).day===day).map(r=>({source:'치이카와 작업 (제목과 실행 상태만 확인)',title:journalSafe(r.title),status:r.status}))].filter(x=>x.title).slice(0,200);
}
export function journalBlocks(body: string) {
 const text=journalSafe(body);if(!text)throw Error('저장할 업무 정리 내용이 없습니다.');
 const chunks:string[]=[];let chunk='';for(const char of text){if(chunk.length+char.length>1800){chunks.push(chunk);chunk='';}chunk+=char;}if(chunk)chunks.push(chunk);
 return chunks.map(content=>({object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content}}]}}));
}
class NotionFailure extends Error { rejected:boolean; constructor(message:string,rejected:boolean){super(message);this.rejected=rejected;} }
type State={connectionKey?:string;enabled:boolean;parentId:string;phase:string;lastDay?:string;lastUrl?:string;attemptAt?:number;uncertain?:{day:string;parentId:string}};
type Deps={file:string;conn:()=>NotionConn|undefined;facts:(day:string)=>unknown[];summarize:(facts:unknown[],day:string)=>Promise<string>;ready?:()=>boolean;now?:()=>Date;fetch?:typeof fetch};
export class NotionDaily {
 private d:Deps;private state:State={enabled:false,parentId:'',phase:'꺼짐'};private busy=false;
 constructor(d:Deps){this.d=d;try{if(existsSync(d.file))this.state={...this.state,...JSON.parse(readFileSync(d.file,'utf8'))};}catch{this.state.phase='업무기록 설정을 읽지 못했습니다. 저장 페이지를 다시 설정해 주세요.';}}
 status(){return {...this.state,busy:this.busy,schedule:'월~금 17:00 · 한국 시간'};}
 private key(){return createHash("sha256").update(this.d.conn()?.token??"").digest("hex");}
 private save(){mkdirSync(dirname(this.d.file),{recursive:true});writeFileAtomic(this.d.file,JSON.stringify(this.state),{mode:0o600});}
 private async call(path:string,body?:unknown){if(body&&this.state.connectionKey!==this.key())throw new NotionFailure('노션 연결이 변경됐습니다. 저장 페이지를 다시 설정해 주세요.',true);const conn=this.d.conn();if(!conn?.token)throw Error('먼저 본인 노션을 연결해 주세요.');
  const r=await(this.d.fetch??fetch)('https://api.notion.com/v1'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${conn.token}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new NotionFailure(r.status===403?'노션 통합의 콘텐츠 읽기·추가 권한과 페이지 연결을 확인해 주세요.':`노션 요청 실패 (${r.status}). 페이지 연결과 인터넷을 확인해 주세요.`,r.status>=400&&r.status<500&&r.status!==408);
  return r.json();}
 async configure(b:unknown){let acquired=false;try{
  if(this.busy)throw Error('업무 정리 중입니다. 끝난 뒤 설정해 주세요.');
  this.busy=true;acquired=true;
  const v=b as any;if(!v||typeof v.enabled!=='boolean'||Object.keys(v).some(k=>!['enabled','parent'].includes(k)))throw Error('설정을 확인해 주세요.');
  if(!v.enabled){this.state.enabled=false;this.state.phase='꺼짐';this.save();return {ok:true};}
  const parentId=journalPageId(v.parent);const p=await this.call('/pages/'+parentId);
  if(p.object!=='page'||p.archived||p.in_trash)throw Error('사용 가능한 일반 노션 페이지를 지정해 주세요. 데이터베이스는 지원하지 않습니다.');
  if(this.state.uncertain&&this.state.uncertain.parentId!==parentId)throw Error('이전 저장 결과 확인이 필요합니다. 기존 저장 페이지에서 다시 시도해 주세요.');
  if(this.state.parentId!==parentId){delete this.state.lastDay;delete this.state.lastUrl;}
  this.state={...this.state,connectionKey:this.key(),enabled:true,parentId,phase:'대기'};this.save();return {ok:true};
 }catch(e){return {ok:false,error:(e as Error).message};}finally{if(acquired)this.busy=false;}}
 private async existing(parent:string,title:string){let cursor:string|undefined;for(let n=0;n<100;n++){
  const r=await this.call(`/blocks/${parent}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);
  const found=(r.results??[]).find((b:any)=>!b.archived&&!b.in_trash&&b.type==='child_page'&&b.child_page?.title===title);if(found)return String(found.id);
  if(!r.has_more)return null;if(!r.next_cursor)throw Error('노션 페이지 목록을 모두 확인하지 못했습니다.');cursor=r.next_cursor;
 }throw Error('하위 페이지가 너무 많습니다. 업무기록 전용 상위 페이지를 사용해 주세요.');}
 async tick(force=false){if(this.busy)return this.status();this.busy=true;
 try{const now=(this.d.now??(()=>new Date()))();const t=dailyClock(now);
  if(!this.state.enabled)return this.status();
  if(!this.d.conn()){this.state.phase='노션 연결 필요';this.save();return this.status();}
  if(this.state.connectionKey!==this.key()){this.state.enabled=false;this.state.phase='노션 계정이 바뀌었습니다. 저장 페이지를 다시 설정해 주세요.';this.save();return this.status();}
  if(this.d.ready&&!this.d.ready()){this.state.phase='AI 설정과 로그인 필요';this.save();return this.status();}
  if(!force&&(t.week===0||t.week===6||t.time<'17:00'||this.state.lastDay===t.day||(this.state.attemptAt&&now.getTime()-this.state.attemptAt<900000)))return this.status();
  this.state.attemptAt=now.getTime();this.state.phase='업무 정리 중';this.save();
  const day=this.state.uncertain?.day??t.day,parent=this.state.uncertain?.parentId??this.state.parentId,title=day+' 업무기록 · 치이카와';
  const found=await this.existing(parent,title);
  if(found){this.state.lastDay=day;this.state.lastUrl='https://www.notion.so/'+found.replaceAll('-','');this.state.phase='저장 확인 완료 · 기존 내용 유지';delete this.state.uncertain;this.save();return this.status();}
  if(this.state.uncertain)throw Error('이전 저장 결과를 확인하지 못했습니다. 중복 방지를 위해 새로 만들지 않습니다. 노션 페이지를 확인해 주세요.');
  const facts=this.d.facts(day);if(!facts.length){this.state.phase='오늘 업무 근거 없음 · 건너뜀';this.save();return this.status();}
  const body=journalSafe(await this.d.summarize(facts,day));const children=journalBlocks(body);
  // Persist before the write. A timeout/crash must never cause a blind second POST.
  this.state.uncertain={day,parentId:parent};this.save();
  const p=await this.call('/pages',{parent:{page_id:parent},properties:{title:{type:'title',title:[{type:'text',text:{content:title}}]}},children});
  if(!p.id)throw Error('노션 저장 결과를 확인하지 못했습니다.');
  this.state.lastDay=day;this.state.lastUrl='https://www.notion.so/'+String(p.id).replaceAll('-','');this.state.phase='저장 완료';delete this.state.uncertain;this.save();
 }catch(e){if(e instanceof NotionFailure&&e.rejected)delete this.state.uncertain;this.state.phase=(e as Error).message;this.save();}finally{this.busy=false;}return this.status();
 }
}
