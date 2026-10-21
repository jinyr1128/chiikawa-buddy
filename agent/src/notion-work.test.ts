import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notionWriteType} from './notion-work.ts';
const id='11111111-1111-1111-1111-111111111111';
function harness(){let token='fake';let version='1';const writes:any[]=[];const f=(async(url:any,init:any)=>{if(init.method==='GET')return Response.json({object:'page',id,last_edited_time:version,type:'paragraph',paragraph:{rich_text:[{plain_text:'원문'}]},properties:{Name:{type:'title',title:[{plain_text:'자료'}]}}});writes.push({url,method:init.method,body:JSON.parse(init.body)});return Response.json({id});}) as typeof fetch;
return {t:notionWriteType(()=>({token}),f),writes,change:()=>version='2',account:()=>token='changed'};}
async function prepared(h:ReturnType<typeof harness>,op:string){const p=h.t.parse({type:'notion_write',op,target:id,title:op==='create'||op==='rename'?'새 제목':'',body:op==='rename'?'':'새 내용'});assert.ok(p.ok);const v=await h.t.verify(p.value,{} as any);assert.ok(v.ok);return v.value;}
for(const op of ['create','append','replace_block','rename'])test('확인 전 쓰기 없음, 정확한 노션 작업: '+op,async()=>{const h=harness();const p=await prepared(h,op);assert.equal(h.writes.length,0);assert.ok(h.t.card(p).body?.includes('새'));assert.ok((await h.t.execute!(p)).ok);assert.equal(h.writes.length,1);assert.equal(h.writes[0].method,op==='create'?'POST':'PATCH');if(op==='replace_block')assert.deepEqual(Object.keys(h.writes[0].body),['paragraph']);});
test('원문 변경·계정 변경 후 실행 차단',async()=>{for(const change of ['change','account'] as const){const h=harness();const p=await prepared(h,'append');h[change]();assert.equal((await h.t.execute!(p)).ok,false);assert.equal(h.writes.length,0);}});
test('잘못된 대상·민감정보·긴 문단 차단',()=>{const h=harness();for(const patch of [{target:'https://evil.test/'+id},{body:'비밀번호: secret'},{op:'replace_block',body:'가'.repeat(1801)}])assert.equal(h.t.parse({op:'append',target:id,title:'',body:'본문',...patch}).ok,false);});
test('연결 없음·접근 불가에 쓰기 없음',async()=>{const t=notionWriteType(()=>undefined);const p=t.parse({op:'append',target:id,title:'',body:'본문'});assert.ok(p.ok);assert.equal((await t.verify(p.value,{} as any)).ok,false);});
test('실제 확인 대기열: 제안은 읽기만, 실행 클릭은 한 번만 저장, 취소는 저장 없음',async()=>{
 const {Actions,TYPES}=await import('./actions.ts');const {Store}=await import('./store.ts');const {loadConfig}=await import('./config.ts');const {RunRegistry}=await import('./runs.ts');const {DatabaseSync}=await import('node:sqlite');
 const h=harness(),old=TYPES.notion_write;TYPES.notion_write=h.t;
 const store=new Store(':memory:');const db=new DatabaseSync(':memory:');
 try{const a=new Actions(loadConfig({},{}),store,{runs:new RunRegistry(db)});const raw={type:'notion_write',op:'append',target:id,title:'',body:'추가 내용'};
 const proposed=await a.propose([raw],{via:'chat'});assert.equal(proposed.created.length,1);assert.equal(h.writes.length,0);
 const aid=proposed.created[0].id;await Promise.all([a.confirm(aid),a.confirm(aid)]);await a.confirm(aid);assert.equal(h.writes.length,1);
 const next=await a.propose([raw],{via:'chat'});a.cancel(next.created[0].id);await a.confirm(next.created[0].id);assert.equal(h.writes.length,1);
 }finally{TYPES.notion_write=old;store.db.close();db.close();}
});
