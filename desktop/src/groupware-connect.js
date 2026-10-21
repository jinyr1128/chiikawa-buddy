import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {cleanWork} from './work-notes.js';
export function createGroupware({data,notify=()=>{},port=47824}) {
  const file=path.join(data,'groupware.json');let state={enabled:false,url:'',recent:[],seen:[],phase:'꺼짐'},server=null,ingestQueue=Promise.resolve();
  async function load(){try{state={...state,...JSON.parse(await fs.readFile(file,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}}
  async function save(){await fs.mkdir(data,{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.rename(file+'.tmp',file);}
  const status=()=>({enabled:state.enabled,url:state.url,phase:state.phase,recent:state.recent,port:server?.address()?.port||port});
  async function stop(){if(server){const s=server;server=null;await new Promise(r=>s.close(r));}}
  async function start(){if(!state.enabled||server)return;server=http.createServer(async(req,res)=>{
    const origin=req.headers.origin||'';
    if(req.headers.host!==`127.0.0.1:${server?.address()?.port}`||!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)){res.writeHead(403);res.end();return;}
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','content-type,x-chiikawa-key');res.setHeader('Access-Control-Allow-Methods','POST');res.writeHead(204);res.end();return;}
    const key=Buffer.from(String(req.headers['x-chiikawa-key']||'')),expected=Buffer.from(state.key||'');
    if(req.method!=='POST'||req.url!=='/ingest'||!state.enabled||key.length!==expected.length||!timingSafeEqual(key,expected)){res.writeHead(403);res.end();return;}
    let body='',size=0;req.on('data',b=>{size+=b.length;if(size>100000)req.destroy();else body+=b;});
    req.on('end',()=>{ingestQueue=ingestQueue.then(async()=>{try{
      const payload=JSON.parse(body);if(new URL(payload.url).origin!==new URL(state.url).origin||!Array.isArray(payload.items)||payload.items.length>100)throw Error();
      const items=payload.items.map(i=>({title:cleanWork(String(i.title||'')).slice(0,300),kind:cleanWork(String(i.kind||'알림')).slice(0,50)})).filter(i=>i.title);
      const keyed=items.map(i=>({...i,id:createHash('sha256').update(i.kind+'\n'+i.title).digest('hex')}));
      const fresh=state.initialized?keyed.filter(i=>!state.seen.includes(i.id)):[];
      state.seen=[...new Set([...keyed.map(i=>i.id),...state.seen])].slice(0,1000);state.initialized=true;
      state.recent=[...fresh.map(i=>({...i,at:new Date().toISOString()})),...state.recent].slice(0,50);state.phase=items.length?'알림 화면 확인됨':'선택한 알림 목록이 비어 있음';await save();
      if(fresh.length)notify(fresh.length);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
    }catch{res.writeHead(400);res.end('{"ok":false}');}});});
  });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  return {init:async()=>{await load();try{await start();}catch{server=null;state.phase='연결 포트 사용 중 · 다른 치이카와 앱을 종료하세요.';}},status,
    configure:async({enabled,url})=>{if(typeof enabled!=='boolean')throw Error('설정 확인 필요');const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw Error('그룹웨어 HTTPS 주소를 입력하세요.');await stop();const changed=state.url!==u.origin;state={...state,enabled,url:u.origin,key:state.key||randomBytes(32).toString('hex'),...(changed?{seen:[],recent:[],initialized:false}:{}),phase:enabled?'브라우저 연결 대기':'꺼짐'};await save();await start();return status();},
    pairing:()=>{if(!state.enabled)throw Error('그룹웨어 연결을 먼저 켜세요.');return {url:state.url,key:state.key,endpoint:'http://127.0.0.1:47824/ingest'};},stop};
}
