// macOS: install only reviewed activity markers. Codex asks the user to trust them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (process.platform !== 'darwin') throw Error('macOS용 작업 신호입니다.');
const root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const file = path.join(root, 'hooks.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
config.hooks ??= {};
const script = `import hashlib,json,pathlib,sys
e=json.load(sys.stdin)
sid=e.get("session_id")
if not isinstance(sid,str) or not sid: sys.exit(0)
d=pathlib.Path.home()/".cy-agent"/"codex-active"
d.mkdir(mode=0o700,parents=True,exist_ok=True)
p=d/hashlib.sha256(sid.encode()).hexdigest()
if e.get("hook_event_name") in ("Stop","SessionEnd"): p.unlink(missing_ok=True)
else: p.touch(mode=0o600)`;
const command = "/usr/bin/python3 -c '" + script + "' # chiikawa-buddy";
let changed = false;
for (const event of ['UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd']) {
  const groups = config.hooks[event] ??= [];
  if (groups.some(g => g.hooks?.some(h => h.command?.includes('# chiikawa-buddy') && h.command.includes('codex-active')))) continue;
  groups.push({ ...(['PreToolUse','PostToolUse'].includes(event) ? {matcher:'*'} : {}), hooks:[{type:'command',command}] });
  changed = true;
}
if (changed) {
  fs.mkdirSync(root,{recursive:true});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(tmp,file);
}
console.log('Codex 설정 → Hooks에서 chiikawa-buddy 항목을 검토하고 신뢰하세요.');
