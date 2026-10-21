export function createWorkConnectionsCard({h,cy}) {
  let state={},busy=false,message='',query='',results=[],title='',body='',folder='',template='',client='',tenant='organizations',auth=null,teamItems=[],replyTarget=null,replyText="",preview=null,leaveCal="",meetingCal="",groupwareUrl="";
  const root=h('section.conn-card.open');
  const call=async(action,arg)=>{const r=await cy.workConnections(action,arg);if(!r?.ok)throw Error(r?.error||'연결 확인 필요');return r.data;};
  async function refresh(){state=await call('status');if(!folder)folder=state.notes.folder;if(!template)template=state.notes.template||'';if(!client)client=state.teams.client||'';if(!leaveCal)leaveCal=state.slackStatus?.personalIds?.[0]||"";if(!meetingCal)meetingCal=state.slackStatus?.meetingIds?.[0]||"";if(!groupwareUrl)groupwareUrl=state.groupware?.url||"";}
  async function run(fn){if(busy)return;busy=true;draw();try{await fn();await refresh();}catch(e){message=e.message;}finally{busy=false;draw();}}
  const button=(text,fn)=>h('button.ghost',{type:'button',disabled:busy,onclick:()=>run(fn)},text);
  const field=(label,value,set,multi=false)=>h('label',{},h('span',{},label),h(multi?'textarea':'input',{value,oninput:e=>set(e.target.value),style:'width:100%',...(multi?{rows:4}:{type:'text'})}));
  const calendarSelect=(label,value,set)=>h("label",{},h("span",{},label),h("select",{value,onchange:e=>set(e.target.value)},h("option",{value:""},"캘린더 선택"),...(state.calendars||[]).map(c=>h("option",{value:c.id,selected:c.id===value},c.name||c.id))));
  function draw(){const n=state.notes||{},t=state.teams||{};
    root.replaceChildren(h('div.conn-head',{},h('b',{},'💎 옵시디언 · 업무기록')),h('div.conn-body',{},
      h('p',{},'본인의 볼트를 선택하세요. 선택한 노트·오늘 일지와 앱 업무 근거를 사용합니다. 자동 정리를 켜거나 실행하면 해당 자료를 연결한 AI로 전달합니다. 컴퓨터 전체 활동을 수집하지 않습니다.'),
      button(n.vault?'볼트 폴더 바꾸기':'볼트 폴더 선택',()=>call('pick-vault')),h('p',{},n.vault||'연결 전'),
      field('업무기록 하위 폴더',folder,v=>folder=v),field('기존 템플릿의 볼트 내 경로 (선택, .md)',template,v=>template=v),
      h('p',{},'파일명 YYYY-MM-DD.md · 템플릿의 {{date}} 또는 {{date:YYYY-MM-DD}}를 오늘 날짜로 바꿉니다. 기존 본문은 보존하고 치이카와 자동 기록 영역만 갱신합니다.'),
      button('폴더·템플릿 저장',()=>call('configure',{folder,template})),
      h('p',{},'오늘 '+(n.day||'')+' · '+(n.todayExists?'오늘 일지 연결됨':'오늘 일지는 첫 저장 시 생성')),h('p',{},(n.schedule||'')+' · '+(n.enabled?'켜짐':'꺼짐')+' · '+(n.phase||'')),
      button(n.enabled?'17시 자동 정리 끄기':'17시 자동 정리 켜기',()=>call('configure',{folder,template,enabled:!n.enabled})),button('지금 업무 정리',()=>call('run')),
      h('h4',{},'추가 업무 폴더 (선택)'),h('p',{},'추가한 폴더는 파일명과 수정시각만 업무 근거로 확인합니다. 파일 내용이나 계정정보 파일은 읽지 않습니다.'),button('업무 폴더 추가',()=>call('pick-root')),
      ...(n.roots||[]).map(p=>h('div',{},h('span',{},p),button('제외',()=>call('remove-root',p)))),
      h('h4',{},'노트 찾기·할 일 연결'),field('노트 제목',query,v=>query=v),button('검색',async()=>{results=await call('search',query);}),
      ...results.map(p=>h('div',{},h('span',{},p),button('열기',()=>call('open',p)),button((n.selected||[]).includes(p)?'연결 해제':'할 일 연결',()=>call('select',{path:p,on:!(n.selected||[]).includes(p)})))),
      ...(n.tasks||[]).map(item=>h('p',{},'☐ '+item.text+' · '+item.path)),
      field('오늘 메모 제목',title,v=>title=v),field('메모 내용',body,v=>body=v,true),button('오늘 일지에 저장',async()=>{await call('save',{title,body});title='';body='';message='오늘 날짜로 저장했습니다.';}),
      h("h4",{},"캘린더 → Slack 상태 자동 변경"),h("p",{},"기본 꺼짐. 연차·휴가를 회의보다 우선하며 직접 설정한 Slack 상태는 유지합니다. 본인 Slack 연결에 users.profile:read / users.profile:write 권한이 필요합니다."),
      calendarSelect("연차·휴가 캘린더",leaveCal,v=>leaveCal=v),calendarSelect("회의 캘린더",meetingCal,v=>meetingCal=v),
      h("p",{},state.slackStatus?.phase||"꺼짐"),button("Slack 상태 권한 확인",()=>call("slack-status-check")),button(state.slackStatus?.enabled?"자동 상태 끄기":"선택한 캘린더로 자동 상태 켜기",()=>call("slack-status-configure",{enabled:!state.slackStatus?.enabled,personalIds:leaveCal?[leaveCal]:[],meetingIds:meetingCal?[meetingCal]:[]})),
      h("h4",{},"그룹웨어 화면 알림"),h("p",{},"별도 Chrome 확장으로 로그인된 전용 탭의 표시된 알림 제목만 확인합니다. 제품별 화면 구조가 달라 기본 선택자가 맞지 않으면 관리자 설정이 필요합니다. 설치 순서는 설명보기를 확인하세요."),
      field("본인 그룹웨어 주소 (HTTPS)",groupwareUrl,v=>groupwareUrl=v),button(state.groupware?.enabled?"그룹웨어 연결 끄기":"이 사이트의 알림 연결 켜기",()=>call("groupware-configure",{enabled:!state.groupware?.enabled,url:groupwareUrl})),button("확장에 붙일 연결 키 복사",async()=>{await call("groupware-pair");message="연결 키를 복사했습니다. 본인 확장 설정에만 붙여 넣으세요.";}),h("p",{},state.groupware?.phase||"꺼짐"),...(state.groupware?.recent||[]).map(i=>h("p",{},i.title)),
      h('h4',{},'Microsoft Teams'),h('p',{},t.connected?'연결됨':'연결 전'),h('p',{},'회사·학교 계정의 최근 채팅과 Microsoft 365 일정을 읽습니다. 멘션 포함 메시지를 확인하고 선택한 대화방에 답장을 보낼 수 있습니다. 일반 개인 Microsoft 계정·채널은 지원하지 않습니다. 조직 관리자 승인이 필요할 수 있습니다.'),
      field('Microsoft 앱의 애플리케이션(클라이언트) ID',client,v=>client=v),field('디렉터리(테넌트) ID 또는 organizations',tenant,v=>tenant=v),
      h('p',{},'Microsoft Entra 앱 등록에서 퍼블릭 클라이언트 흐름을 허용하고 User.Read, Chat.Read, ChatMessage.Send, Calendars.Read 위임 권한을 추가하세요. 비밀번호·클라이언트 시크릿은 입력하지 않습니다. 자세한 순서는 설명보기에서 확인하세요.'),
      button('Teams 로그인 시작',async()=>{auth=await call('teams-start',{client,tenant});}),
      auth?h('div',{},h('p',{},'본인이 시작한 Microsoft 로그인 화면에 입력할 코드: '+auth.code),button('Microsoft 로그인 화면 열기',()=>call('teams-login')),button('로그인 완료 확인',async()=>{const r=await call('teams-poll');if(r.connected){auth=null;message='Teams 연결 완료';}else message='Microsoft 화면에서 로그인을 완료한 뒤 다시 확인하세요.';})):null,
      t.connected?h('div',{},button('오늘 Teams 자료 확인',async()=>{const r=await call('teams-today');teamItems=r.items;message=r.partial?'최근 일부 대화만 표시합니다.':'조회 완료';}),button('Teams 연결 해제',async()=>{await call('teams-disconnect');teamItems=[];replyTarget=null;preview=null;replyText='';})):null,
      ...teamItems.map(i=>h('div',{},h('p',{},(i.mentioned?'[멘션 포함] ':'')+i.title+' · '+(i.text||i.at||'')),i.chatId?button('이 대화방에 답장 쓰기',async()=>{await call('teams-cancel');replyTarget=i;replyText='';preview=null;}):null)),
      replyTarget?h('div',{},h('h4',{},'Teams 답장'),h('p',{},'참고 메시지: '+replyTarget.text),h('p',{},'선택한 대화방의 모든 참여자에게 새 메시지로 보냅니다. 원문 인용·스레드 답장 기능은 아닙니다.'),field('보낼 내용',replyText,v=>{replyText=v;preview=null;root.querySelector('.teams-send-preview')?.remove();},true),button('받는 사람·내용 확인',async()=>{preview=await call('teams-prepare',{chatId:replyTarget.chatId,text:replyText});}),preview?h('div.teams-send-preview',{role:'alert'},h('p',{},'대화방: '+preview.title),h('p',{},'참여자: '+preview.recipients.join(', ')),h('pre',{style:'white-space:pre-wrap'},preview.text),button('확인한 내용 전송',async()=>{const id=preview.id;preview=null;await call('teams-send',id);message='Teams 대화방에 전송했습니다.';replyTarget=null;replyText='';})):null,button('답장 취소',async()=>{await call('teams-cancel');replyTarget=null;preview=null;replyText='';})):null,h('p',{role:'status'},message)
    ));
  }
  draw();run(refresh);
  const timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return;}if(!busy&&!(root.contains(document.activeElement)&&["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)))run(refresh);},30000);
  return root;
}
