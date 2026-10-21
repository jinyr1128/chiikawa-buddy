import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkSummary} from './work-summary.ts';
test('업무 정리: 한 번에 한 작업, 실패와 완료를 구분하고 빈 입력 거부',async()=>{
 let finish!:(s:string)=>void;
 const service=createWorkSummary(()=>new Promise<string>(resolve=>{finish=resolve;}));
 assert.throws(()=>service.start({text:''}));
 const {id}=service.start({text:'오늘 수행한 업무'});
 assert.equal(service.status(id).state,'running');
 assert.throws(()=>service.start({text:'중복'}));
 finish('오늘 자료를 작성했습니다.');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(service.status(id).state,'done');
 assert.equal(service.status('missing').state,'failed');
 const failed=createWorkSummary(async()=>{throw Error('private error');});
 const next=failed.start({text:'자료'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(failed.status(next.id).state,'failed');
 assert.doesNotMatch(JSON.stringify(failed.status(next.id)),/private error/);
});
