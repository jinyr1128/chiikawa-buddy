import {randomUUID} from 'node:crypto';
import {journalSafe} from './notion-daily.ts';
export function createWorkSummary(summarize:(text:string)=>Promise<string>) {
 const jobs=new Map<string,{state:string;reply?:string;error?:string;at:number}>();
 return {
  start(body:unknown){const b=body as {text?:unknown};if(!b||typeof b.text!=='string'||!b.text.trim()||b.text.length>100000)throw Error('업무정리 자료 크기를 확인하세요.');
   for(const [id,job]of jobs)if(Date.now()-job.at>3600000)jobs.delete(id);
   if([...jobs.values()].some(j=>j.state==='running'))throw Error('업무 정리 중입니다.');
   const id=randomUUID();jobs.set(id,{state:'running',at:Date.now()});
   void summarize(b.text).then(text=>{const reply=journalSafe(text);jobs.set(id,reply?{state:'done',reply,at:Date.now()}:{state:'failed',error:'저장할 업무 정리 내용이 없습니다.',at:Date.now()});}).catch(()=>jobs.set(id,{state:'failed',error:'AI 업무 정리 실패. AI 연결과 로그인을 확인하세요.',at:Date.now()}));
   return {id};
  },
  status(id:string){return jobs.get(id)||{state:'failed',error:'정리 세션이 만료됐습니다. 다시 실행하세요.'};}
 };
}
