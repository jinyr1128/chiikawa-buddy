// User-selected local vault only. No bundled vault, company name or personal path.
import fs from 'node:fs/promises';
import path from 'node:path';
export const workDay = (now=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const privateName = /업무용 아이디 모음|업무용 계정 현황|비밀번호|연락처|주민번호|credentials?|password|secrets?|계정/i;
export const cleanWork = text => String(text??'').split('\n').filter(l=>!/(?:01[016789][- .]?\d{3,4}[- .]?\d{4}|\d{6}\s*-\s*[1-8]\d{6}|비밀번호|(?:password|token|api[_ -]?key)\s*[:=]|(?:ntn_|secret_|sk-|xox[baprs]-)[A-Za-z0-9_-]{10,})/i.test(l)).join('\n').slice(0,30000);
export function notePath(config, day=workDay()) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('기록 날짜를 확인해 주세요.');
  return path.join(config.folder||'일일 업무기록',day+'.md');
}
export async function vaultPath(root,rel,{create=false}={}) {
  if(!root||typeof rel!=='string'||path.isAbsolute(rel)||rel.split(/[\\/]/).some(p=>p==='..'||p.startsWith('.'))||privateName.test(rel)) throw Error('허용되지 않는 노트 경로입니다.');
  const real=await fs.realpath(root);const target=path.resolve(real,rel);
  if(!target.startsWith(real+path.sep)) throw Error('볼트 밖 경로는 사용할 수 없습니다.');
  // Check each existing component; never traverse a symlink, including parents.
  let current=real;
  for(const part of path.relative(real,target).split(path.sep)) {
    current=path.join(current,part);
    try { if((await fs.lstat(current)).isSymbolicLink())throw Error('바로가기 경로는 사용할 수 없습니다.'); }
    catch(e){if(e.code!=='ENOENT'||!create)throw e;}
  }
  return target;
}
export async function readNote(config,rel) {
  if(!rel.endsWith('.md'))throw Error('Markdown 노트만 지원합니다.');
  const file=await vaultPath(config.vault,rel);if((await fs.stat(file)).size>200000)throw Error('너무 큰 노트입니다.');
  return cleanWork(await fs.readFile(file,'utf8'));
}
export async function findNotes(config,query='') {
  if(!config.vault)return [];const out=[];let visited=0;
  async function walk(dir,depth=0) {
    if(depth>8||visited>4000||out.length>=100)return;
    for(const e of await fs.readdir(dir,{withFileTypes:true})) {
      if(++visited>4000)return;
      if(e.name.startsWith('.')||e.isSymbolicLink()||privateName.test(e.name)||['node_modules','.git'].includes(e.name))continue;
      const full=path.join(dir,e.name),rel=path.relative(config.vault,full);
      if(e.isDirectory())await walk(full,depth+1);
      else if(e.isFile()&&e.name.endsWith('.md')&&rel.toLowerCase().includes(String(query).toLowerCase().slice(0,150)))out.push(rel);
    }
  }
  await walk(config.vault);return out.slice(0,100).sort();
}
export async function noteSnapshot(config,now=new Date()) {
  const day=workDay(now),today=notePath(config,day),tasks=[],errors=[];
  const selected=[...new Set([today,...(config.selected||[]).filter(p=>!(path.dirname(p)===(config.folder||'일일 업무기록')&&/^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(p))))])];
  let todayExists=false;
  if(config.vault)for(const rel of selected.slice(0,100)) {
    try {const text=await readNote(config,rel);if(rel===today)todayExists=true;let fence=false;
      text.split(/\r?\n/).forEach((l,i)=>{if(/^\s*(```|~~~)/.test(l)){fence=!fence;return;}const m=!fence&&/^\s*[-*+]\s+\[ \]\s+(.+)/.exec(l);if(m)tasks.push({text:m[1],path:rel,line:i+1});});
    }catch(e){if(!(rel===today&&e.code==='ENOENT'))errors.push(rel);}
  }
  return {day,today,todayExists,selected,tasks,errors};
}
export async function saveWorkNote(config,{title,body,day=workDay(),summary=false}) {
  if(!config.vault)throw Error('옵시디언 볼트 폴더를 먼저 선택하세요.');
  if(typeof title!=='string'||!title.trim()||title.length>150||typeof body!=='string'||!body.trim()||body.length>30000||cleanWork(body)!==body||cleanWork(title)!==title)throw Error('제목·내용을 확인하고 개인정보를 제외해 주세요.');
  const rel=notePath(config,day),file=await vaultPath(config.vault,rel,{create:true});
  await fs.mkdir(path.dirname(file),{recursive:true});
  let initial=`---\ndate: ${day}\ntype: daily-work-log\ntags: [업무일지]\n---\n\n# ${day} 업무 기록\n\n## 오늘 할 일\n\n## 업무 진행 기록\n\n## 확인·대기 사항\n\n## 다음 할 일\n`;
  if(config.template)initial=(await readNote(config,config.template)).replaceAll('{{date:YYYY-MM-DD}}',day).replaceAll('{{date}}',day);
  try{await fs.writeFile(file,initial,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  await vaultPath(config.vault,rel);
  const current=await fs.readFile(file,'utf8');
  const start='<!-- CHIIKAWA-DAILY:START -->',end='<!-- CHIIKAWA-DAILY:END -->';
  const block=`${start}\n### ${title.replace(/[\r\n]/g,' ')}\n\n${body.trim()}\n${end}`;
  let next=current;
  if(summary&&current.includes(start)) {
    const a=current.indexOf(start),b=current.indexOf(end,a);if(b<a)throw Error('자동 기록 영역이 손상되어 저장하지 않았습니다.');
    next=current.slice(0,a)+block+current.slice(b+end.length);
  }else next=current+`\n\n${summary?block:`### ${title.replace(/[\r\n]/g,' ')}\n\n${body.trim()}`}\n`;
  if(await fs.readFile(file,'utf8')!==current)throw Error('노트가 편집 중입니다. 다시 저장하세요.');
  await fs.writeFile(file,next);return {path:rel};
}
