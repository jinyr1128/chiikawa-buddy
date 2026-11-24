import {createHash} from 'node:crypto';
import {zoned} from './calendar-tab.js';
const dayOf = time => zoned(time,'Asia/Seoul').ymd;
const privateText = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|01[016789][- .]?\d{3,4}[- .]?\d{4}|\d{6}\s*-\s*[1-8]\d{6}|비밀번호|업무용 아이디 모음|업무용 계정 현황|(?:password|token|api[_ -]?key)\s*[:=]|(?:sk-|ntn_|secret_|xox[baprs]-)[A-Za-z0-9-]{10,}/i;
const safeText = text => typeof text==='string' && !privateText.test(text) ? text : '';
import {isTimedMeeting, eventWhen} from './calendar-tab.js';

const DAY = 86400000;
const reason = '캘린더 회의 종료 시각이 지났어요.';
const keyOf = id => createHash('sha256').update(id).digest('hex');
const midnight = time => Date.parse(dayOf(time)+'T00:00:00+09:00');
const iso = time => new Date(time).toISOString();
function rowsOf(view) {
  const calendars = new Map(view.calendars.filter(c=>c.enabled && c.phase==='ok').map(c=>[c.id,c]));
  return view.events.filter(e=>calendars.has(e.calId) && typeof e.id==='string' && e.id && isTimedMeeting(e)
    && safeText(e.title)===e.title && Date.parse(e.end)>Date.parse(e.start)).map(e=>{
    const s=Date.parse(e.start), end=Date.parse(e.end);
    const when=eventWhen({s,e:end},view.timeZone || 'Asia/Seoul');
    const calendar=calendars.get(e.calId).name;
    return {key:keyOf(e.id),event:e,cal:e.calId,s,end,title:e.title.slice(0,200),description:'일정: '+when+'\n캘린더: '+safeText(calendar)};
  });
}

export async function calendarCompletion(db,request,{now=Date.now(),pin}={}) {
  db.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS chi_meeting_tasks (key TEXT PRIMARY KEY, todo_id TEXT NOT NULL UNIQUE, cal TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, generated INTEGER NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS chi_meeting_sync (cal TEXT PRIMARY KEY, at INTEGER NOT NULL, available INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chi_meeting_cursor (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);`);
  const current=midnight(now), cursor=db.prepare('SELECT at FROM chi_meeting_cursor WHERE id=1').get()?.at;
  const from=pin ? midnight(pin.start) : Math.min(current,midnight(db.prepare('SELECT min(at) AS at FROM chi_meeting_sync WHERE available=1').get().at ?? cursor ?? now));
  // Each pass catches up at most one week. Advance only after a complete calendar response.
  const to=pin ? from+DAY : Math.min(current+DAY,from+7*DAY);
  const lookup=db.prepare('SELECT * FROM chi_meeting_tasks WHERE key=?');
  const todo=db.prepare('SELECT * FROM todos WHERE id=?');
  async function fetchView(fresh) {
    const query=new URLSearchParams({from:iso(from),to:iso(to),...(fresh?{fresh:'1'}:{})});
    const r=await request('GET','/calendar/events?'+query,undefined,70000);
    if(!r.ok || !r.data?.connected || !Array.isArray(r.data.events) || !Array.isArray(r.data.calendars)) throw Error('캘린더 연결을 확인한 뒤 다시 시도해요.');
    return r.data;
  }
  const pending=db.prepare(`SELECT 1 FROM chi_meeting_tasks m JOIN todos t ON t.id=m.todo_id
    WHERE m.end<=? AND m.end>? AND t.status='open' AND t.auto_reverted=0 AND t.user_edited NOT LIKE '%"status"%' LIMIT 1`).get(now,from);
  const view=await fetchView(!cursor || now-cursor>120000 || !!pending);
  const rows=rowsOf(view);
  const single=pin && rows.find(r=>r.event.id===pin.id);
  if(pin && !single)throw Error('일정이 변경되었어요. 캘린더를 새로고침해 주세요.');
  let changed=0;
  const log=db.prepare('INSERT INTO todo_ledger(day,at,todo_id,title,action,by,detail) VALUES (?,?,?,?,?,?,?)');
  function record(id,title,action,at,detail) {
    log.run(dayOf(at),iso(at),id,title,action,'auto',detail);
    changed++;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const row of (pin?[single]:rows)) {
      const {key,cal,title,description,s,end,event}=row;
      const ref='calendar:meeting:'+key;
      let link=lookup.get(key);
      if(!link) {
        // Older calendar cards carried the displayed date/time and calendar on two exact lines.
        // A title match alone could point to an action item or a different occurrence.
        const legacy=db.prepare(`SELECT id FROM todos WHERE title=? AND
          (source_ref=? OR (source IN ('calendar','cal') AND (source_ref IN (?,?) OR id IN (?,?))) OR
           (source='user' AND source_ref IS NULL AND created>=? AND (description=? OR substr(description,1,length(?)+1)=?||char(10))))
          AND id NOT IN (SELECT todo_id FROM chi_meeting_tasks)`).all(title,ref,event.id,'calendar:'+event.id,'cal:'+event.id,'calendar:'+event.id,iso(s-180*DAY),description,description,description);
        const ambiguous=rows.filter(r=>r.title===title && r.description===description).length>1;
        const existing=legacy.length===1&&!ambiguous ? legacy[0].id : null;
        const id=existing || 'cal:meeting:'+key;
        db.prepare('INSERT INTO chi_meeting_tasks(key,todo_id,cal,start,end,generated) VALUES(?,?,?,?,?,?)').run(key,id,cal,s,end,existing?0:1);
        if(!existing && !todo.get(id) && !db.prepare('SELECT 1 FROM todo_tombstones WHERE id=?').get(id)) {
          const at=Math.min(now,s);
          db.prepare(`INSERT INTO todos(id,title,source,priority,status,created,updated,description,source_ref)
              VALUES(?,?,'calendar',?,'open',?,?,?,?)`).run(id,title,s>=current+DAY?2:1,iso(at),iso(at),description,ref);
          record(id,title,'added',at,'캘린더 회의 일정');
        }
        link=lookup.get(key);
      }
      const id=link.todo_id;
      if(link.start!==s || link.end!==end)db.prepare('UPDATE chi_meeting_tasks SET start=?,end=? WHERE key=?').run(s,end,key);
      let t=todo.get(id);
      if(!t)continue;
      if(link.withdrawn && t.status==='trashed' && t.trashed_at===iso(link.withdrawn)) {
        db.prepare("UPDATE todos SET status=prev_status,trashed_at=NULL,prev_status=NULL,prev_priority=NULL WHERE id=?").run(id);
        db.prepare('DELETE FROM todo_tombstones WHERE id=?').run(id);
        db.prepare('UPDATE chi_meeting_tasks SET withdrawn=0 WHERE key=?').run(key);
        record(id,t.title,'restored',now,'캘린더에 회의 일정이 다시 표시됨');
        t=todo.get(id);
      }
      if(t.status!=='open'||t.trashed_at)continue;
      const edited=new Set(JSON.parse(t.user_edited||'[]'));
      if(link.generated && !edited.has('priority') && s>=current && s<current+DAY && t.priority===2) {
        db.prepare('UPDATE todos SET priority=1 WHERE id=?').run(id);
        changed++;
      }
      if(link.generated && ((!edited.has('title')&&t.title!==title)||(!edited.has('description')&&t.description!==description))) {
        db.prepare('UPDATE todos SET title=?,description=? WHERE id=?').run(edited.has('title')?t.title:title,edited.has('description')?t.description:description,id);
        changed++;t=todo.get(id);
      }
      if(end<=now && !t.auto_reverted && !edited.has('status')) {
        db.prepare("UPDATE todos SET status='done',done_by='auto',updated=?,auto_reason=?,auto_evidence=? WHERE id=?").run(iso(end),reason,JSON.stringify({ids:[ref]}),id);
        record(id,t.title,'done',end,reason);
      }
    }
    if(!pin) {
      const active=new Set(rows.map(r=>r.key));
      const healthy=new Set(view.calendars.filter(c=>c.enabled && c.phase==='ok').map(c=>c.id));
      for(const m of db.prepare(`SELECT m.*, t.title FROM chi_meeting_tasks m JOIN todos t ON t.id=m.todo_id
        WHERE m.generated=1 AND t.status='open' AND t.trashed_at IS NULL AND t.user_edited='[]' AND t.auto_reverted=0
        AND t.project_id IS NULL AND m.start<? AND m.end>?`).all(to,from)) {
        if(active.has(m.key)||!healthy.has(m.cal))continue;
        db.prepare("UPDATE todos SET prev_status=status,prev_priority=priority,status='trashed',trashed_at=?,updated=? WHERE id=?").run(iso(now),iso(now),m.todo_id);
        db.prepare('INSERT OR REPLACE INTO todo_tombstones(id,title,at) VALUES(?,?,?)').run(m.todo_id,m.title,iso(now));
        db.prepare('UPDATE chi_meeting_tasks SET withdrawn=? WHERE key=?').run(now,m.key);
        record(m.todo_id,m.title,'trashed',now,'캘린더에서 빠진 회의 일정');
      }
      db.prepare('UPDATE chi_meeting_sync SET available=0 WHERE available=1').run();
      for(const c of view.calendars){
        if(!c.enabled)continue;
        const ok=c.phase==='ok'?1:0;
        const through=ok?Math.min(now,to):from;
        db.prepare(`INSERT INTO chi_meeting_sync(cal,at,available) VALUES(?,?,?)
          ON CONFLICT(cal) DO UPDATE SET available=excluded.available,at=CASE WHEN excluded.available=1 AND chi_meeting_sync.at>=? THEN MAX(chi_meeting_sync.at,excluded.at) ELSE chi_meeting_sync.at END`)
          .run(c.id,through,ok,from);
      }
      if(healthy.size || view.ok)db.prepare('INSERT INTO chi_meeting_cursor(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=MAX(at,excluded.at)').run(Math.min(now,to));
    }
    db.exec('COMMIT');
    return {changed};
  }catch(err){db.exec('ROLLBACK');throw err;}
}
