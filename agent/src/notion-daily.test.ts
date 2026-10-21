import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NotionDaily,journalPageId,journalFacts,journalBlocks,dailyClock} from './notion-daily.ts';
const ID='11111111-1111-1111-1111-111111111111';
function fixture(t:any, options:any={}) {
 const dir=mkdtempSync(join(tmpdir(),'journal-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const calls:any[]=[];let now=new Date('2026-10-21T08:00:00Z');let children:any[]=[];
 const d={file:join(dir,'state.json'),conn:()=>({token:'fake'}),facts:()=>[{title:'문서 정리',status:'done'}],summarize:async()=> '오늘 한 일\n문서 정리 완료',now:()=>now,
 fetch:(async(url:any,init:any)=>{calls.push({url,init});if(init.method==='POST'){if(options.timeout)throw Error('timeout');children=[{id:ID,type:'child_page',child_page:{title:'2026-10-21 업무기록 · 치이카와'}}];return Response.json({id:ID});}return Response.json(String(url).includes('/blocks/')?{results:children}:{object:'page',id:ID});}) as typeof fetch,...options};
 return {d,calls,service:new NotionDaily(d),setNow:(s:string)=>now=new Date(s),setChildren:(c:any[])=>children=c};
}
test('기본 꺼짐·본인 연결 필수·페이지 URL 검증',async t=>{
 const f=fixture(t);await f.service.tick(true);assert.equal(f.calls.length,0);
 assert.equal((await f.service.configure({enabled:true,parent:'https://evil.com/'+ID})).ok,false);
 assert.equal(journalPageId('https://www.notion.so/journal-'+ID.replaceAll('-','')+'?pvs=4'),ID);
 const absent=fixture(t,{conn:()=>undefined});assert.equal((await absent.service.configure({enabled:true,parent:ID})).ok,false);
});
test('평일 한국시간17시 실행·같은 날 재실행/재시작 중복 없음·수기 내용 유지',async t=>{
 const f=fixture(t);await f.service.configure({enabled:true,parent:ID});f.setNow('2026-10-21T07:59:00Z');await f.service.tick();assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 f.setNow('2026-10-21T08:00:00Z');await f.service.tick();await f.service.tick(true);await new NotionDaily(f.d).tick(true);
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);assert.equal(f.service.status().lastDay,'2026-10-21');
 assert.ok(f.calls.every(c=>['POST','GET'].includes(c.init.method)));assert.equal(dailyClock(new Date('2026-10-21T08:00:00Z')).time,'17:00');
});
test('주말·업무 근거 없는 날 건너뜀·설정 해제 후 저장 없음',async t=>{
 const f=fixture(t,{facts:()=>[]});await f.service.configure({enabled:true,parent:ID});await f.service.tick();assert.match(f.service.status().phase,/근거 없음/);
 f.setNow('2026-10-24T08:00:00Z');await f.service.tick();assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 await f.service.configure({enabled:false});await f.service.tick(true);assert.equal(f.service.status().enabled,false);
});
test('POST 시간초과 후 재시작해도 새 페이지를 무작정 만들지 않음',async t=>{
 const f=fixture(t,{timeout:true});await f.service.configure({enabled:true,parent:ID});await f.service.tick(true);const again=new NotionDaily(f.d);await again.tick(true);
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);assert.match(again.status().phase,/중복 방지/);
 f.setChildren([{id:ID,type:'child_page',child_page:{title:'2026-10-21 업무기록 · 치이카와'}}]);await again.tick(true);assert.equal(again.status().uncertain,undefined);
});
test('동시 실행 차단·정리 중 설정 변경 차단',async t=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const f=fixture(t,{summarize:async()=>{await wait;return '완료';}});await f.service.configure({enabled:true,parent:ID});const run=f.service.tick(true);await f.service.tick(true);assert.equal((await f.service.configure({enabled:false})).ok,false);release();await run;
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
});
test('개인정보 제거·자동 작업 제외·노션 블록 길이 제한',()=>{
 assert.deepEqual(journalFacts([{by:'user',day:'2026-10-21',title:'연락 010-1234-5678'},{by:'auto',day:'2026-10-21',title:'자동'}],[],'2026-10-21'),[]);
 assert.ok(journalBlocks('가'.repeat(9000)).every(b=>b.paragraph.rich_text[0].text.content.length<=1800));
});

test('노션 계정 교체 시 자동 기록 해제·권한 거절 후 수정하면 재시도 가능',async t=>{
 const f=fixture(t);await f.service.configure({enabled:true,parent:ID});f.d.conn=()=>({token:'other'});await f.service.tick(true);assert.equal(f.service.status().enabled,false);
 let rejected=true;
 const g=fixture(t,{fetch:(async(url:any,init:any)=>Response.json(init.method==='POST'?(rejected?{}:{id:ID}):String(url).includes('/blocks/')?{results:[]}:{object:'page'},{status:init.method==='POST'&&rejected?403:200})) as typeof fetch});
 await g.service.configure({enabled:true,parent:ID});await g.service.tick(true);assert.equal(g.service.status().uncertain,undefined);rejected=false;await g.service.tick(true);assert.equal(g.service.status().lastDay,'2026-10-21');
});

test('업무기록 HTTP 변경은 기존 로컬 요청 보호를 통과해야 함',async t=>{
 const {Bus}=await import('./bus.ts');const bus=new Bus();let writes=0;
 bus.notionDaily={status:()=>({enabled:false}),configure:async()=>{writes++;return {ok:true};},tick:async()=>{writes++;return {};}};
 const port=48000+Math.floor(Math.random()*500);await bus.listen(port,{} as never);t.after(()=>bus.close());
 const url=`http://127.0.0.1:${port}/notion-daily`;
 assert.equal((await fetch(url)).status,200);
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);assert.equal(writes,0);
 assert.equal((await fetch(url,{method:'POST',headers:{'x-cy-agent':'1','content-type':'application/json'},body:'{}'})).status,200);assert.equal(writes,1);
});
