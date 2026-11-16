// Run with playwright-cli run-code --filename. Browser-only UI fixtures, never a native integration claim.
async page => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const now=Math.floor(Date.now()/1000),cid='fixture-account';
    const workspace={id:'personal',name:'Personal',color:'#2297f6',archived:false,isDefault:true,connectionId:cid,revision:0,sources:{calendars:['cal-1'],mail:true,chats:['chat-1']},layout:['brief','focus','calendar','inbox','commitments'],aiProfile:null};
    const settings={theme:'dark',timeZone:'Europe/Kyiv',background:false,notifications:false,notificationPreview:false,quietStart:'22:00',quietEnd:'08:00',clientId:'3d7688c6-f449-4d04-8b0d-57d94818e922',tenant:'common',activeWorkspace:'personal',activeConnection:cid,notificationPermission:'not_requested',focusUntil:null};
    const record=(id,kind,source,data)=>({id,kind,source,data,connectionId:cid,workspaceId:null,revision:'v1',updatedAt:now});
    const s={revision:1,settings,workspaces:[workspace],connection:{id:cid,displayName:'QA Fixture',email:'qa@example.test',userId:'qa',status:'connected',enabled:['calendar','mail','chats'],scopes:['Calendars.Read','Mail.Read','Chat.Read'],lastSync:now,syncError:null},available:true,jobs:[],records:[record('known-window','calendar_window','calendar:cal-1',{start:now-31536000,end:now+31536000}),record('calendars','catalog','catalog',{values:[{id:'cal-1',name:'QA Calendar',canEdit:true,isDefaultCalendar:true}]}),record('chats','catalog','catalog',{hasMore:true,values:[{id:'chat-1',topic:'QA conversation',members:[{displayName:'QA Recipient'}]}]}),record('event-1','event','calendar:cal-1',{title:'QA planning',start:new Date((now+3600)*1000).toISOString(),end:new Date((now+7200)*1000).toISOString(),allDay:false,calendarId:'cal-1',location:'Teams',url:'https://outlook.office.com/calendar',preview:'Planning agenda'}),...['critical','reply','waiting','fyi','low'].map((lane,i)=>record('message-'+i,'message','mail:inbox',{lane,channel:'mail',title:i===1?'<script>untrusted</script>':'QA '+lane,text:'Please review the fixture proposal.',from:'QA Sender',fromAddress:'sender@example.test',at:now-i*60,lifecycle:'open',reason:'Fixture lane projection',conversationId:'conversation-'+i,url:'https://outlook.office.com/mail'}))]};
    const clone=x=>JSON.parse(JSON.stringify(x));
    window.__fixtureSetConnectionStatus=async status=>{s.connection.status=status;s.available=status==='connected';await window.__workspace.store.refresh();};
    window.__fixtureCalls=[];const listeners={};window.__fixtureEmit=(name,payload)=>listeners[name]?.({payload});
    window.__TAURI__={event:{listen:async(name,fn)=>{listeners[name]=fn;return()=>delete listeners[name];}},core:{invoke:async(command,{request:r}={})=>{
      if(command==='smoke_mode')return{dev:true};if(command==='runtime_ready')return false;if(command==='get_app_version')return '2.1.1';if(command==='check_for_update')return null;
      if(command!=='workspace_request')throw Error('Unexpected native command '+command);
      if(r.op==='snapshot')return{snapshot:clone(s),authPending:false,authError:null};
      if(r.expectedRevision!==s.revision)throw{code:'conflict',message:'Fixture stale revision'};
      window.__fixtureCalls.push(clone(r));s.revision++;
      if(r.op==='workspace_create'){const w={...clone(workspace),id:r.operationId,name:r.data.name,isDefault:false,connectionId:null};s.workspaces.push(w);s.settings.activeWorkspace=w.id;}
      if(r.op==='workspace_select')s.settings.activeWorkspace=r.data.id;
      if(r.op==='workspace_update'){const w=s.workspaces.find(w=>w.id===r.workspaceId);Object.assign(w,r.data);if(w.archived)s.settings.activeWorkspace='personal';}
      if(r.op==='sources_more'){const catalog=s.records.find(r=>r.id==='chats');catalog.data.values.push({id:'chat-2',topic:'More QA chats',members:[]});catalog.data.hasMore=false;}
      if(r.op==='settings_update')Object.assign(s.settings,r.data);
      if(r.op==='layout_save')Object.assign(s.workspaces.find(w=>w.id===r.workspaceId),r.data);
      if(r.op==='local_save'||r.op==='draft_save'){const id=r.op==='draft_save'?'manual:'+r.data.sourceId:r.data.id||r.operationId;const old=s.records.find(x=>x.id===id);if(old)old.data=r.data;else s.records.push({...record(id,r.op==='draft_save'?'draft':r.data.kind,'local',r.data),connectionId:null,workspaceId:r.workspaceId});}
      if(r.op==='local_delete')s.records=s.records.filter(x=>x.id!==r.data.id);
      if(r.op==='inbox_decision'){const m=s.records.find(x=>x.id===r.data.id);if(r.data.action==='lane')m.data.lane=r.data.lane;if(r.data.action==='archive')m.data.lifecycle='archived';}
      if(r.op==='brief_generate')s.records.push({...record('daily','brief','deterministic',{text:'One upcoming fixture event.',citations:[],source:'Fixture selected sources'}),connectionId:null,workspaceId:r.workspaceId});
      if(r.op==='action_prepare')return{actionId:'action-1',nonce:'review-nonce',account:'qa@example.test',review:{title:'QA reply',recipients:[{emailAddress:{address:'recipient@example.test'}}],body:r.data.body}};
      if(r.op==='action_confirm')return{state:'accepted',message:'Fixture accepted; no network request was made.'};
      if(r.op==='ai_probe')return{ready:false,message:'Fixture has no AI runtime.'};
      if(r.op==='schedule_save')s.records.push({...record(r.operationId,'schedule','local',{...r.data,nextAt:now+86400}),connectionId:null,workspaceId:r.workspaceId});
      return{saved:true};
    }}};
  });
  await page.goto(new URL('/',page.url()).href);
  await page.getByRole('heading',{name:'A clear start to your day'}).waitFor();
  let checks=0;
  const check=async(condition,label)=>{if(!await condition)throw Error(label);checks++;};
  await check(page.getByText('QA planning',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Today uses event source');
  for(const theme of ['dark','light']){
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await page.locator(`[data-action="theme"][data-theme="${theme}"]`).click();
    for(const width of [1000,1360,1600]){
      await page.setViewportSize({width,height:900});
      for(const name of ['Today','Calendar','Inbox','Workspaces']){
        await page.getByRole('button',{name,exact:true}).first().click();
        await check(page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow '+theme+width+name);
        await check(page.locator('h1').waitFor({state:'visible'}).then(()=>true),'Visible heading '+name);
      }
    }
  }
  await page.getByRole('button',{name:'New workspace',exact:true}).click();
  await page.getByLabel('Name',{exact:true}).fill('Browser QA');
  await page.getByRole('button',{name:'Create workspace',exact:true}).click();
  await check(page.getByRole('heading',{name:'Browser QA',exact:true}).waitFor({state:'visible'}).then(()=>true),'Create workspace');
  await page.getByRole('button',{name:'Archive',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await check(page.getByText('Archived',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Archive workspace');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Microsoft 365',exact:true}).click();
  await page.getByLabel('Outlook Inbox & Sent',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Load more Teams chats',exact:true}).click();
  await check(page.getByText('More QA chats',{exact:true}).isVisible(),'Teams discovery is explicitly paged');
  await check(page.getByLabel('Outlook Inbox & Sent',{exact:true}).isChecked().then(v=>!v),'Loading more sources preserves unsaved selection');
  await page.getByRole('button',{name:'Today',exact:true}).first().click();await page.getByRole('button',{name:'Discard edits',exact:true}).click();
  await page.getByRole('button',{name:'Today',exact:true}).first().click();
  await page.getByRole('button',{name:'Add commitment',exact:true}).click();
  await page.getByLabel('What do you want to follow through on?').fill('Review native evidence');
  await page.getByRole('button',{name:'Save commitment',exact:true}).click();
  await check(page.getByText('Review native evidence',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Commitment creation');
  await page.getByRole('button',{name:'Start focus session',exact:true}).click();
  await check(page.getByRole('button',{name:'End focus',exact:true}).waitFor({state:'visible'}).then(()=>true),'Focus persistence');
  await page.getByRole('button',{name:'Generate today’s brief',exact:true}).click();
  await check(page.getByText('One upcoming fixture event.',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Brief render');
  await page.getByRole('button',{name:'Inbox',exact:true}).first().click();
  await check(page.getByText('<script>untrusted</script>',{exact:false}).waitFor({state:'visible'}).then(()=>true),'Source HTML escaped');
  await check(page.locator('#workspace-page script').count().then(n=>n===0),'No injected script');
  await page.locator('[data-action="message"][data-id="message-1"]').click();
  await page.getByLabel('Your reply draft').fill('Reviewed fixture reply.');
  await page.getByRole('button',{name:'Review reply',exact:true}).click();
  await check(page.getByText('recipient@example.test',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Native review recipient shown');
  await page.getByRole('button',{name:'Confirm and send',exact:true}).click();
  await check(page.evaluate(()=>window.__fixtureCalls.filter(r=>r.op==='action_confirm').length===1),'One confirmation dispatch');
  await page.locator('[data-action="message"][data-id="message-1"]').click();
  await page.getByLabel('Your reply draft').fill('Unfinished reply protected by close guard');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await check(page.getByRole('heading',{name:'Save your reply draft?',exact:true}).isVisible(),'Dirty reply has a close guard');
  await page.getByRole('button',{name:'Save draft and close',exact:true}).click();
  await page.locator('[data-action="message"][data-id="message-1"]').click();
  await check(page.getByLabel('Your reply draft').inputValue().then(v=>v==='Unfinished reply protected by close guard'),'Reply restored after guarded close');
  await page.getByLabel('Your reply draft').fill('Discard this edit');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Discard edits',exact:true}).click();
  await check(page.locator('.ws-modal[open]').count().then(n=>n===0),'Escape supports explicit discard');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Queues & schedules',exact:true}).click();
  await page.getByRole('button',{name:'Add schedule',exact:true}).click();await page.getByRole('button',{name:'Create schedule',exact:true}).click();
  await check(page.getByText('Daily workspace brief',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Schedule persisted');
  await page.getByRole('button',{name:'Today',exact:true}).first().click();
  await page.getByRole('button',{name:'Customize',exact:false}).click();
  await page.getByLabel('brief width',{exact:true}).selectOption('12');
  await page.getByRole('button',{name:'Save layout',exact:true}).click();
  await check(page.evaluate(()=>window.__workspace.store.get().snapshot.workspaces.find(w=>w.id==='personal').widgetWidths.brief===12),'Widget widths persist through native bridge contract');
  await page.getByRole('button',{name:'Customize',exact:false}).click();
  await check(page.getByLabel('brief width',{exact:true}).inputValue().then(v=>v==='12'),'Customize restores saved width');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('#today-note').fill('Scoped unsaved note');
  await page.getByRole('button',{name:'Add commitment',exact:true}).click();
  await page.evaluate(()=>window.__fixtureEmit('workspace:notification-open',{workspaceId:'personal',itemId:'message-1'}));
  await check(page.getByRole('dialog').getByRole('heading',{name:'Choose a commitment',exact:true}).isVisible(),'Notification does not replace open modal');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Your reply draft').waitFor();
  await check(page.evaluate(()=>window.__fixtureCalls.some(r=>r.op==='local_save'&&r.workspaceId==='personal'&&r.data.text==='Scoped unsaved note')),'Notification saves note to original workspace');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Today',exact:true}).first().click();
  await page.locator('#today-note').fill('');
  await page.getByRole('button',{name:'Calendar',exact:true}).first().click();
  await check(page.evaluate(()=>window.__fixtureCalls.some(r=>r.op==='local_delete'&&r.data.kind==='note')),'Clearing a note survives route change');
  await page.getByRole('button',{name:'Today',exact:true}).first().click();
  for(const theme of ['dark','light']){
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await page.locator(`[data-action="theme"][data-theme="${theme}"]`).click();
    await page.setViewportSize({width:1000,height:700});
    for(const name of ['General','Microsoft 365','Appearance','Queues & schedules','Notifications','Data & privacy','Setup & installation','AI tools & profiles','Desktop connection','Health','Activity & jobs','Updates & about','CLI usage analytics']){
      await page.getByRole('button',{name,exact:true}).click();
      await check(page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Settings does not overflow '+theme+' '+name);
    }
    await page.getByRole('button',{name:'Today',exact:true}).first().click();
    await page.setViewportSize({width:1360,height:900});
    await page.screenshot({path:`output/playwright/milestone-1/today-${theme}.png`});
  }
  await page.evaluate(()=>window.__fixtureSetConnectionStatus('needs_login'));
  await check(page.getByText('Reconnect Microsoft 365',{exact:true}).waitFor({state:'visible'}).then(()=>true),'Expired credential shows explicit reconnection state');
  await check(page.getByText('Microsoft needs sign-in',{exact:true}).isVisible(),'Sidebar does not claim connected after credential failure');
  await check(errors.length===0,'No browser errors: '+errors.join('; '));
  return {mode:'Browser with explicitly mocked IPC; not native Graph or notification proof',checks,errors};
}
