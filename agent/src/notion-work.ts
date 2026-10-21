import {createHash} from 'node:crypto';
import type {ActionType} from './actions.ts';
import {notionRequest,notionWorkConn,pageTitle,type NotionConn} from './notion.ts';
import {journalPageId,journalSafe,journalBlocks} from './notion-daily.ts';
type Op='create'|'append'|'replace_block'|'rename';
type Payload={op:Op;target:string;title:string;body:string;revision?:string;account?:string;label?:string;before?:string};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const revision=(o:any)=>hash({id:o.id,edited:o.last_edited_time,archived:o.archived,trash:o.in_trash,type:o.type,properties:o.properties,content:o[o.type]});
const supported=['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote','to_do'];
export const NOTION_ACTION_SCHEMA={type:'array',maxItems:3,description:'노션 쓰기 제안. 사용자 확인 카드 실행 전에는 완료라고 말하지 마라. target은 읽기로 확인한 페이지/블록 id. 삭제·전체 교체 미지원.',items:{type:'object',additionalProperties:false,required:['type','op','target','title','body'],properties:{type:{type:'string',enum:['notion_write']},op:{type:'string',enum:['create','append','replace_block','rename']},target:{type:'string'},title:{type:'string',description:'create/rename 제목, 그 밖은 빈 문자열'},body:{type:'string',description:'create/append/replace_block 본문, rename은 빈 문자열'}}}};
export const NOTION_READ_SCHEMA={type:'array',maxItems:3,description:'노션 검색 또는 읽기 요청. 결과를 받은 뒤 답하라.',items:{type:'object',additionalProperties:false,required:['kind','value'],properties:{kind:{type:'string',enum:['search','read']},value:{type:'string'}}}};
export function notionWriteType(conn:()=>NotionConn|undefined=notionWorkConn,f:typeof fetch=fetch):ActionType<Payload>{
 const read=async(p:Payload)=>{const c=conn();if(!c)throw Error('연결 관리에서 본인 노션을 먼저 연결해 주세요.');const obj=await notionRequest(c.token,(p.op==='replace_block'?'/blocks/':'/pages/')+p.target,{},f);if(obj.archived||obj.in_trash)throw Error('삭제된 대상은 수정할 수 없습니다.');return {c,obj};};
 return {type:'notion_write',keys:['type','op','target','title','body'],
 parse(raw){try{
  if(!['create','append','replace_block','rename'].includes(String(raw.op)))throw Error('지원하지 않는 노션 작업입니다.');
  if(typeof raw.title!=='string'||typeof raw.body!=='string'||raw.title.length>200||raw.body.length>8000)throw Error('제목은 200자, 본문은 8,000자 이내로 입력해 주세요.');
  const p:Payload={op:raw.op as Op,target:journalPageId(raw.target),title:raw.title.trim(),body:raw.body.trim()};
  if(['create','rename'].includes(p.op)&&!p.title)throw Error('제목이 필요합니다.');
  if(['append','replace_block'].includes(p.op)&&!p.body)throw Error('본문이 필요합니다.');
  if(p.op==='replace_block'&&p.body.length>1800)throw Error('한 블록은 1,800자 이내로 수정해 주세요.');
  if(journalSafe(p.body)!==p.body||journalSafe(p.title)!==p.title)throw Error('개인정보나 계정정보를 제외한 내용으로 요청해 주세요.');
  return {ok:true,value:p};
 }catch(e){return {ok:false,error:(e as Error).message};}},
 async verify(p){try{const {c,obj}=await read(p);const block=p.op==='replace_block';if(block&&!supported.includes(obj.type))throw Error('이 블록 형식은 텍스트 수정이 지원되지 않습니다.');
 const before=block?(obj[obj.type]?.rich_text??[]).map((t:any)=>t.plain_text??t.text?.content??'').join(''):pageTitle(obj);
 if(journalSafe(before)!==before.trim()||before.length>8000)throw Error('민감정보가 있거나 너무 긴 대상은 노션에서 직접 수정해 주세요.');
 return {ok:true,value:{...p,account:hash(c.token),revision:revision(obj),label:block?'노션 텍스트 블록':pageTitle(obj),before}};
 }catch(e){return {ok:false,error:(e as Error).message};}},
 call:p=>({service:'notion-direct',tool:p.op,args:{target:p.target,title:p.title,body:p.body}}),
 card:p=>({icon:'📝',title:p.label||'노션',verb:'실행',question:({create:'이 페이지 아래에 새 문서를 만들까요?',append:'이 페이지 끝에 내용을 추가할까요?',replace_block:'이 블록의 내용을 바꿀까요?',rename:'페이지 제목을 바꿀까요?'})[p.op],notice:'대상 내용이나 계정이 바뀌면 실행하지 않습니다. 문단 수정은 해당 문단의 글자 서식·링크를 일반 텍스트로 바꿉니다.',fields:[{label:'대상 ID',value:p.target},{label:'작업',value:p.op}],body:`현재: ${p.before||''}\n\n새 제목: ${p.title}\n\n작성할 내용:\n${p.body}`,bodyKind:'text'}),
 async execute(p){try{const {c,obj}=await read(p);if(hash(c.token)!==p.account||revision(obj)!==p.revision)throw Error('대상 내용 또는 노션 연결이 바뀌었습니다. 다시 요청해 주세요.');
 let path:string,method:string,body:any;
 if(p.op==='create'){path='/pages';method='POST';body={parent:{page_id:p.target},properties:{title:{type:'title',title:[{type:'text',text:{content:p.title}}]}},...(p.body?{children:journalBlocks(p.body)}:{})};}
 else if(p.op==='append'){path=`/blocks/${p.target}/children`;method='PATCH';body={children:journalBlocks(p.body)};}
 else if(p.op==='rename'){path='/pages/'+p.target;method='PATCH';const prop=Object.entries(obj.properties??{}).find(([,v]:any)=>v.type==='title');if(!prop)throw Error('제목 속성을 찾지 못했습니다.');body={properties:{[prop[0]]:{title:[{type:'text',text:{content:p.title}}]}}};}
 else{path='/blocks/'+p.target;method='PATCH';body={[obj.type]:{rich_text:[{type:'text',text:{content:p.body}}]}};}
 await notionRequest(c.token,path,{method,body},f);return {ok:true,message:'노션 작업을 완료했습니다.'};
 }catch(e){return {ok:false,message:(e as Error).message+' 저장 요청 후 오류라면 노션에서 결과를 확인한 뒤 다시 요청해 주세요.'};}},
 result:()=>({ok:false,message:'노션 직접 실행 결과가 없습니다.'})};
}
