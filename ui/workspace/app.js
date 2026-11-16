import {createStore,escapeHtml as e,calendarDays,calendarWindow,calendarCoverage} from './store.js';
import * as v from './views.js';
import {shouldCheckForAppUpdate} from '../app-updater-utils.mjs';

const root=document.getElementById('workspace-app');
const legacy=document.getElementById('app');
const invoke=window.__TAURI__?.core?.invoke;
const state={route:'today',settingsTab:'general',calendarMode:'week',calendarDate:new Date(),lane:'reply',search:'',showArchived:false,showSnoozed:false,inboxLimit:200,appVersion:'',latestVersion:null,updateStatus:'',updateBusy:false};
let legacyModule,legacyMounted=false,rendering=0,readTimer,authTimer;
let runtimeReady=false;
let ready=false;
let pendingSettingsEdit=false;
let deferredNotification;
const dialogSources=new WeakMap();
const store=invoke?createStore(invoke):null;
const sn=()=>store.get().snapshot;
const current=()=>v.active(sn());
const mutate=async(op,data={},wid)=>{const scope=wid??[...document.querySelectorAll('.ws-modal[open]')].at(-1)?.dataset.workspaceId;try{return await store.mutate(op,data,scope);}finally{pendingSettingsEdit=false;if(ready&&!document.querySelector('.ws-modal[open]')&&!legacyMounted)await render();flushNotification();}};
const getRecord=(kind,id)=>sn().records.find(r=>r.kind===kind&&r.id===id);
const toast=message=>{document.querySelector('.ws-toast')?.remove();const el=document.createElement('div');el.className='ws-toast';el.setAttribute('role','status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),9000);};
function applyTheme(theme){window.__cmTheme?.set(theme);const t=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;document.documentElement.classList.remove('light','dark');document.documentElement.classList.add(t);const legacyToggle=document.getElementById('theme-toggle-input');if(legacyToggle)legacyToggle.checked=t==='dark';}

function modal(title,content,submit='Save',onSubmit,workspaceId){
  const restore=document.activeElement;
  const d=document.createElement('dialog');d.className='ws-modal';d.dataset.workspaceId=workspaceId||current().id;const workspaceName=sn().workspaces.find(w=>w.id===d.dataset.workspaceId)?.name||'Workspace';
  d.innerHTML=`<form><div class="ws-modal-heading"><div><h2>${e(title)}</h2><span class="ws-small ws-muted">${e(workspaceName)}</span></div><button type="button" class="ws-btn ws-btn-icon" data-modal-close aria-label="Close dialog">${v.icon('close')}</button></div><div class="ws-modal-content ws-form">${content}</div><div class="ws-modal-error" role="alert"></div><div class="ws-modal-footer"><button type="button" class="ws-btn" data-modal-close>Cancel</button>${submit?`<button type="submit" class="ws-btn ws-btn-primary">${e(submit)}</button>`:''}</div></form>`;
  const requestClose=async()=>{if(!d.beforeClose||await d.beforeClose()!==false)d.close();};
  d.querySelectorAll('[data-modal-close]').forEach(b=>b.onclick=()=>requestClose().catch(error=>toast(error.message||String(error))));
  d.addEventListener('cancel',event=>{if(d.beforeClose){event.preventDefault();requestClose().catch(error=>toast(error.message||String(error)));}});
  d.addEventListener('close',()=>{d.remove();restore?.focus?.();if(!document.querySelector('.ws-modal[open]'))render();flushNotification();},{once:true});
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const button=ev.submitter;button.disabled=true;d.querySelector('.ws-modal-error').textContent='';try{const result=await onSubmit(new FormData(ev.target),d);if(result!==false)d.close();}catch(error){d.querySelector('.ws-modal-error').textContent=error.message||String(error);}finally{button.disabled=false;}};
  document.body.append(d);d.showModal();return d;
}
const input=(label,name,value='',type='text',extra='')=>`<label>${e(label)}<input class="ws-input" name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const textarea=(label,name,value='',extra='')=>`<label>${e(label)}<textarea class="ws-textarea" name="${name}" ${extra}>${e(value)}</textarea></label>`;
const confirm=(title,description,action,label='Confirm')=>modal(title,`<p>${e(description)}</p>`,label,action);

function shell(){
  const s=sn(),w=v.active(s),route=state.route;
  root.dataset.route=route;
  const counts={inbox:v.visibleMessages(s).filter(m=>m.data.lane==='reply').length};
  root.innerHTML=`<aside class="ws-sidebar"><div class="ws-brand" aria-label="EPAM AI/Run CodeMie"><img class="ws-logo-dark" src="workspace/assets/logo-full-dark.svg" alt=""><img class="ws-logo-light" src="workspace/assets/logo-full-light.svg" alt=""></div><nav class="ws-nav" aria-label="Main navigation">${[['today','Today'],['calendar','Calendar'],['inbox','Inbox'],['workspaces','Workspaces']].map(([id,label])=>`<button data-action="route" data-route="${id}" aria-label="${label}" ${id===route?'aria-current="page"':''}>${v.icon(id)}<span>${label}</span>${counts[id]?`<small class="ws-count">${counts[id]}</small>`:''}</button>`).join('')}</nav><div class="ws-sidebar-bottom"><div class="ws-local"><strong><span class="ws-status-dot"></span>${s.connection?(s.connection.status==='connected'?'Microsoft connected':'Microsoft needs sign-in'):'Local workspace'}</strong>${s.connection?'Selected sources, your decisions.':'Start here. Connect services when you need them.'}</div><nav class="ws-nav"><button data-action="route" data-route="settings" ${route==='settings'?'aria-current="page"':''}>${v.icon('settings')}<span>Settings</span></button></nav><div class="ws-user"><div class="ws-avatar">${e((s.connection?.displayName||w.name)[0])}</div><div>${e(s.connection?.displayName||'Your workspace')}<br><span class="ws-small">CodeMie Connect</span></div></div></div></aside><header class="ws-topbar"><div class="ws-topbar-left"><span style="color:${e(w.color)}">${v.icon('workspaces')}</span><select class="ws-workspace-select ws-select" aria-label="Active workspace" id="workspace-select">${s.workspaces.filter(w=>!w.archived).map(item=>`<option value="${e(item.id)}" ${item.id===w.id?'selected':''}>${e(item.name)}</option>`).join('')}</select><span class="ws-breadcrumb">/ &nbsp;${e(route[0].toUpperCase()+route.slice(1))}</span></div><div class="ws-topbar-right"><span class="ws-sync-text">${s.connection?.lastSync?'Updated '+v.time(s.connection.lastSync,s.settings.timeZone):'Stored on this device'}</span><button class="ws-btn ws-btn-icon" data-action="sync" aria-label="Refresh Microsoft sources">${v.icon('refresh')}</button><button class="ws-btn ws-btn-icon" data-action="theme-cycle" aria-label="Change appearance">${v.icon('sun')}</button><button class="ws-btn ws-btn-icon" data-action="activity" aria-label="Background activity">${v.icon('bell')}</button></div></header><main class="ws-main" id="workspace-main"><div class="ws-page" id="workspace-page"></div></main>`;
}
async function render(){
  if(!store?.get())return;
  if(legacyMounted&&legacyModule?.legacyToolsBusy()){applyTheme(sn().settings.theme);return;}
  const noteElement=document.getElementById('today-note');
  const unsavedNote=noteElement&&noteElement.value!==noteElement.defaultValue?{workspaceId:noteElement.dataset.workspaceId,text:noteElement.value}:null;
  const revision=++rendering;
  // Preserve the single mounted installer DOM while replacing the workspace view.
  if(legacyMounted){legacy.classList.add('hidden');document.body.append(legacy);legacyMounted=false;}
  const scroll=root.querySelector('.ws-main')?.scrollTop||0;
  const settingsScroll={nav:root.querySelector('.ws-settings-sidebar')?.scrollTop||0,panels:root.querySelector('.ws-settings-panels')?.scrollTop||0,tab:root.querySelector('.ws-settings-nav [aria-current=page]')?.dataset.tab};
  shell();const s=sn();applyTheme(s.settings.theme);
  const page=document.getElementById('workspace-page');
  page.innerHTML=state.route==='today'?v.today(s):state.route==='calendar'?v.calendar(s,state):state.route==='inbox'?v.inbox(s,state):state.route==='workspaces'?v.workspaces(s):v.settings(s,state,store.get());
  if(state.route==='today'&&!runtimeReady&&localStorage.getItem('codemie.setupBanner.dismissed')!=='1')page.insertAdjacentHTML('afterbegin',`<div class="ws-banner"><span class="ws-banner-icon">${v.icon('spark')}</span><div><strong>Bring your coding tools into your workspace</strong><p>Set up CodeMie, Claude Code or Claude Desktop whenever you’re ready.</p></div><div class="ws-actions">${v.btn('Set up AI tools','setup-tools','',true)}${v.btn('Dismiss','setup-dismiss')}</div></div>`);
  if(state.latestVersion&&sessionStorage.getItem('app-update-banner-dismissed')!=='1'&&!(state.route==='settings'&&state.settingsTab==='updates'))page.insertAdjacentHTML('afterbegin',`<div class="ws-banner"><span class="ws-banner-icon">${v.icon('spark')}</span><div><strong>CodeMie Connect ${e(state.latestVersion)} is available</strong><p>Your workspace and tool configuration are retained.</p></div><div class="ws-actions">${v.btn('Review update','updates','',true)}${v.btn('Dismiss','update-dismiss')}</div></div>`);
  if(unsavedNote?.workspaceId===v.active(s).id){const note=document.getElementById('today-note');if(note)note.value=unsavedNote.text;}
  root.querySelector('.ws-main').scrollTop=scroll;
  if(state.route==='settings'&&document.getElementById('legacy-host')) {
    const host=document.getElementById('legacy-host');
    if(!runtimeReady){host.innerHTML=`<section class="ws-card">${v.empty('Your CodeMie tools are here','Prepare the CodeMie CLI when you want to install AI tools or connect Claude Desktop. The rest of your workspace works independently.','prepare-tools','Prepare CodeMie tools','settings')}</section>`;return;}
    try {
      legacyModule ||= await import('../renderer.js');
      if(revision!==rendering)return;
      host.append(legacy);legacy.classList.remove('hidden');legacyMounted=true;
    const map={installation:'home',tools:'agents',desktop:'connect',health:'health',usage:'analytics'};
      await legacyModule.openLegacyTools(map[state.settingsTab]);
    } catch(err){toast(err.message||String(err));}
  }
  const settingsNav=root.querySelector('.ws-settings-sidebar'),settingsPanels=root.querySelector('.ws-settings-panels');
  if(settingsNav)settingsNav.scrollTop=settingsScroll.nav;
  if(settingsPanels&&settingsScroll.tab===state.settingsTab)settingsPanels.scrollTop=settingsScroll.panels;
}
async function savePendingNote(){
  const el=document.getElementById('today-note');
  if(!el||el.value===el.defaultValue)return;
  const wid=el.dataset.workspaceId,id=el.dataset.recordId;
  if(!el.value.trim()){if(id)await mutate('local_delete',{kind:'note',id},wid);}
  else await mutate('local_save',{kind:'note',id:id||undefined,text:el.value},wid);
}
async function route(name,tab){
  if(pendingSettingsEdit&&(name!==state.route||tab&&tab!==state.settingsTab))return confirm('Discard unsaved settings?','Your current settings edits have not been saved.',()=>{pendingSettingsEdit=false;return route(name,tab);},'Discard edits');
  if(legacyMounted&&legacyModule&&!await legacyModule.leaveLegacyTools())return;
  await savePendingNote();state.route=['today','calendar','inbox','workspaces','settings'].includes(name)?name:'today';if(tab)state.settingsTab=tab;
  history.replaceState(null,'',`#/${state.route}${state.route==='settings'?'/'+state.settingsTab:''}`);await render();root.querySelector('h1')?.setAttribute('tabindex','-1');root.querySelector('h1')?.focus({preventScroll:true});if(state.route==='calendar')await ensureCalendarWindow();
}
async function ensureCalendarWindow(force=false){
  if(!sn().available||!(current().sources.calendars||[]).length)return;
  const window=calendarWindow(state.calendarDate,state.calendarMode);
  if(!force&&calendarCoverage(sn(),window))return;
  await mutate('calendar_window',window);
}
function workspaceDialog(w){modal(w?'Edit workspace':'Create a workspace',input('Name','name',w?.name||'','text','required maxlength="80"')+input('Color','color',w?.color||'#2297f6','color'),w?'Save workspace':'Create workspace',async f=>{await mutate(w?'workspace_update':'workspace_create',{name:f.get('name'),color:f.get('color')},w?.id);});}
function commitmentDialog(source){modal('Choose a commitment',textarea('What do you want to follow through on?','text','','required maxlength="20000"')+`<div class="ws-form-row">${input('Owner','owner','You','text','required')}${input('Due date (optional)','due','','date')}</div>`+(source?`<p class="ws-small ws-muted">Source quote: ${e(source.data.text)}</p>`:''),'Save commitment',async f=>{await mutate('local_save',{kind:'commitment',text:f.get('text'),owner:f.get('owner'),due:f.get('due'),sourceId:source?.id,sourceRevision:source?.revision,quote:source?.data.text});});}
function eventDialog(event){
  const s=sn(),zone=s.settings.timeZone;
  if(event){
    const d=modal(event.data.title||'Calendar event',`<p>${e(v.when(event.data.start,zone))} – ${e(v.when(event.data.end,zone))}${event.data.allDay?' · All day':''}</p><p>${e(event.data.location||'')}</p><p class="ws-small ws-muted">Organizer: ${e(event.data.organizer?.name||event.data.organizer?.address||'Microsoft Calendar')}</p><div class="ws-message-body">${e(event.data.preview||'Open the provider for full details and event changes.')}</div><div class="ws-actions">${v.btn('Open in Outlook','source',`data-kind="event" data-id="${e(event.id)}"`)}${event.data.joinUrl?v.btn('Join meeting','source',`data-kind="event" data-id="${e(event.id)}" data-join="true"`,true):''}${v.btn('Remind me','event-reminder',`data-id="${e(event.id)}"`)}</div>`,null);return d;
  }
  if(!s.available){route('settings','microsoft');return;}
  const catalog=v.records(s,'catalog').find(r=>r.id==='calendars')?.data.values||[];
  const calendars=catalog.filter(c=>current().sources.calendars.includes(c.id));
  if(!calendars.length){toast('Select at least one calendar in Microsoft settings first.');route('settings','microsoft');return;}
  modal('Create calendar event',`<label>Calendar<select class="ws-select" name="calendarId">${calendars.map(c=>`<option value="${e(c.id)}">${e(c.name)}</option>`).join('')}</select></label>`+input('Title','title','','text','required maxlength="250"')+`<div class="ws-form-row">${input('Starts','start','','datetime-local','required')}${input('Ends','end','','datetime-local','required')}</div>`+input('Time zone','timeZone',zone,'text','required')+`<div class="ws-form-row">${input('Start UTC offset, seconds (ambiguous times only)','startOffset','','number')}${input('End UTC offset, seconds (ambiguous times only)','endOffset','','number')}</div>`+input('Attendees (email addresses, comma separated)','attendees','','text')+textarea('Description','body')+'<p class="ws-small ws-muted">The next step shows the exact account, dates and attendee invitations. Nothing is created before confirmation.</p>','Review event',async(f,d)=>{
    const data=Object.fromEntries(f);data.attendees=String(data.attendees).split(',').map(s=>s.trim()).filter(Boolean);data.kind='event';for(const key of ['startOffset','endOffset'])data[key]=data[key]===''?null:Number(data[key]);
    const result=await mutate('action_prepare',data);d.close();reviewAction(result);return false;
  });
}
function reviewAction(result){
  const review=result.review||{};
  modal('Review before sending',`<div class="ws-banner"><span class="ws-badge ws-badge-blue">${e(result.account)}</span><span class="ws-small">Expires in five minutes</span></div><strong>${e(review.title||'Reply to conversation')}</strong>${review.start?`<p>${e(review.start)} – ${e(review.end)}<br>${e(review.timeZone)} · ${e(review.calendar)}</p>`:''}${review.invitesAttendees?'<p style="color:var(--ws-amber)">This event will send invitations to every attendee below.</p>':''}${review.recipients||review.attendees?`<div><span class="ws-small ws-muted">RECIPIENTS / PARTICIPANTS</span><pre class="ws-message-body">${e((review.recipients||review.attendees).map(r=>r.emailAddress?.address||r.email||r.displayName||'Unknown participant').join('\n'))}</pre></div>`:''}<div class="ws-message-body">${e(review.body||'')}</div><p class="ws-small ws-muted">A confirmed mail reply is accepted by Microsoft for processing; delivery is checked in Outlook. Interrupted sends are never retried automatically.</p>`,'Confirm and send',async()=>{const r=await mutate('action_confirm',{actionId:result.actionId,nonce:result.nonce});toast(r.message||r.state);},result.workspaceId);
}
function messageDialog(message){
  const s=sn();const draft=v.records(s,'draft').find(r=>r.data.sourceId===message.id&&!r.data.aiSuggested);
  const d=modal(message.data.title||'Conversation',`<div class="ws-account-card"><span class="ws-avatar">${e((message.data.from||'?')[0])}</span><div><strong>${e(message.data.from||'Microsoft source')}</strong><p class="ws-small ws-muted">${e(message.data.fromAddress||message.data.channel)} · ${e(v.when(message.data.at,s.settings.timeZone))}</p></div></div><div class="ws-message-body">${e(message.data.text||'No preview available. Open the provider for full content.')}</div><p class="ws-small ws-muted">${e(message.data.reason)}</p><div class="ws-form-row"><label>Queue<select class="ws-select" name="lane">${v.lanes.filter(([k])=>k!=='decisions').map(([key,label])=>`<option value="${key}" ${message.data.lane===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Snooze until<input class="ws-input" name="snooze" type="datetime-local"></label></div><div class="ws-actions">${v.btn('Save queue','message-lane',`data-id="${e(message.id)}"`)}${v.btn('Snooze','message-snooze',`data-id="${e(message.id)}"`)}${v.btn(message.data.lifecycle==='archived'?'Restore':'Archive','message-archive',`data-id="${e(message.id)}"`)}${message.data.lane==='critical'?v.btn(message.data.acknowledgedAt?'Acknowledged':'Acknowledge','message-ack',`data-id="${e(message.id)}" ${message.data.acknowledgedAt?'disabled':''}`):''}${v.btn('Add commitment','commitment',`data-id="${e(message.id)}"`)}${message.data.responseSourceId?v.btn('Review new response','message',`data-id="${e(message.data.responseSourceId)}"`):''}${v.btn('Open source','source',`data-kind="message" data-id="${e(message.id)}"`)}</div><hr class="ws-divider">${textarea('Your reply draft','body',draft?.data.text||'','required maxlength="20000"')}<div class="ws-actions">${v.btn('Save local draft','draft-save',`data-id="${e(message.id)}"`)}${v.btn('Draft with pinned AI','ai-draft',`data-id="${e(message.id)}"`)}${v.btn('Load AI suggestion','ai-load',`data-id="${e(message.id)}"`)}</div><p class="ws-small ws-muted">Drafts stay local. Sending requires a separate native review and Microsoft write permission.</p>`,'Review reply',async(f,dialog)=>{await mutate('draft_save',{text:f.get('body'),sourceId:message.id,sourceRevision:message.revision},dialog.dataset.workspaceId);const result=await mutate('action_prepare',{kind:message.data.channel==='mail'?'mail_reply':'chat_reply',sourceId:message.id,body:f.get('body')});dialog.close();reviewAction(result);return false;});
  d.dataset.messageId=message.id;dialogSources.set(d,message);
  if(message.data.unavailable||message.data.deleted){d.querySelector('[type=submit]').disabled=true;d.querySelector('[data-action=ai-draft]').disabled=true;d.querySelector('.ws-message-body').insertAdjacentHTML('beforebegin','<p class="ws-banner">This item moved or is no longer available in selected sources. Cached text remains for your local decisions; review the provider before replying.</p>');}
  d.beforeClose=()=>{
    const field=d.querySelector('[name=body]');if(field.value===field.defaultValue)return true;
    const prompt=confirm('Save your reply draft?','Keep this reply on this device before closing. Your Microsoft mailbox is unchanged.',async()=>{if(field.value.trim())await mutate('draft_save',{text:field.value,sourceId:message.id,sourceRevision:message.revision},d.dataset.workspaceId);else if(draft)await mutate('local_delete',{kind:'draft',id:draft.id},d.dataset.workspaceId);d.beforeClose=null;d.close();},'Save draft and close');
    const discard=document.createElement('button');discard.type='button';discard.className='ws-btn';discard.textContent='Discard edits';discard.onclick=()=>{prompt.close();d.beforeClose=null;d.close();};prompt.querySelector('.ws-modal-footer').prepend(discard);return false;
  };
}
function scheduleDialog(){const s=sn();modal('Add a daily schedule',`<label>Work to run<select class="ws-select" name="kind"><option value="brief">Generate daily brief</option><option value="reminder">Workspace reminder</option></select></label>`+input('Label','label','Daily workspace brief','text','required')+`<div class="ws-form-row">${input('Time','time','09:00','time','required')}${input('IANA time zone','timeZone',s.settings.timeZone,'text','required')}</div><label><input type="checkbox" class="ws-checkbox" name="weekdays" checked> Weekdays only</label><p class="ws-small ws-muted">Runs while Connect is open or in the menu bar. Briefs catch up within two hours after wake; older occurrences are skipped.</p>`,'Create schedule',async f=>{await mutate('schedule_save',{kind:f.get('kind'),label:f.get('label'),time:f.get('time'),timeZone:f.get('timeZone'),weekdays:f.has('weekdays'),enabled:true});});}

async function handle(action,b){
  const id=b.dataset.id,dialog=b.closest('dialog');const source=dialogSources.get(dialog)||getRecord('message',id);
  switch(action){
    case 'route':if(b.dataset.lane)state.lane=b.dataset.lane;return route(b.dataset.route||'inbox');
    case 'settings-tab':return route('settings',b.dataset.tab);
    case 'microsoft':return route('settings','microsoft');
    case 'queue-settings':return route('settings','queues');
    case 'activity':return route('settings','activity');
    case 'updates':return route('settings','updates');
    case 'setup-tools':return route('settings','installation');
    case 'setup-dismiss':localStorage.setItem('codemie.setupBanner.dismissed','1');return render();
    case 'update-check':return checkAppUpdate();
    case 'update-dismiss':sessionStorage.setItem('app-update-banner-dismissed','1');return render();
    case 'update-install':return confirm('Update CodeMie Connect?',`Install CodeMie Connect ${state.latestVersion} and restart the application. Your workspace and existing tool configuration are retained.`,async()=>{state.updateBusy=true;await invoke('workspace_installer_busy',{busy:true});try{const bridge=await import('../runner-bridge.js');await bridge.updater.downloadAndInstall(crypto.randomUUID(),progress=>{state.updateStatus=progress.message||'Downloading update…';});await invoke('workspace_installer_busy',{busy:false});await bridge.updater.restartApp();}finally{state.updateBusy=false;await invoke('workspace_installer_busy',{busy:false});}},'Update and restart');
    case 'workspace-new':return workspaceDialog();
    case 'workspace-edit':return workspaceDialog(sn().workspaces.find(w=>w.id===id));
    case 'workspace-open':await savePendingNote();await mutate('workspace_select',{id});return route('today');
    case 'workspace-archive':return confirm(b.dataset.archived==='true'?'Archive workspace?':'Restore workspace?',b.dataset.archived==='true'?'This pauses its schedules and provider actions. Local history is retained.':'Restore this workspace and its saved sources.',()=>mutate('workspace_update',{archived:b.dataset.archived==='true'},id));
    case 'theme':await mutate('settings_update',{theme:b.dataset.theme});return render();
    case 'theme-cycle':await mutate('settings_update',{theme:sn().settings.theme==='dark'?'light':'dark'});return render();
    case 'save-zone':return mutate('settings_update',{timeZone:document.getElementById('setting-time-zone').value});
    case 'setting-toggle':return mutate('settings_update',{[b.dataset.key]:b.checked});
    case 'quiet-save':return mutate('settings_update',{quietStart:document.getElementById('quiet-start').value,quietEnd:document.getElementById('quiet-end').value});
    case 'sync-window':return mutate('settings_update',{syncDays:Number(document.getElementById('sync-days').value)});
    case 'graph-registration':return mutate('settings_update',{clientId:document.getElementById('graph-client-id').value,tenant:document.getElementById('graph-tenant').value});
    case 'graph-connect':await mutate('graph_connect',{capabilities:[...document.querySelectorAll('#graph-capabilities input:checked')].map(i=>i.value)});toast('Complete Microsoft sign-in in your system browser.');return;
    case 'graph-cancel':await store.query('graph_cancel');return store.refresh();
    case 'graph-capabilities':return mutate('settings_update',{capabilities:[...document.querySelectorAll('#graph-capabilities input:checked')].map(i=>i.value)});
    case 'graph-bind':if(current().connectionId&&current().connectionId!==sn().connection?.id)return confirm('Reassign workspace account?','Clear the previous account source selections and bind this workspace to the currently signed-in Microsoft account. Local notes remain.',()=>mutate('graph_bind',{confirmReassignment:true}),'Reassign account');return mutate('graph_bind');
    case 'graph-disconnect':if(!sn().connection){toast('No Microsoft account is connected.');return;}return modal('Disconnect Microsoft 365',`<p>Remove Connect’s credentials and stop account jobs. Synchronized bodies and AI-derived content will be removed by default. Your local user-written notes and commitments remain.</p><label><input class="ws-checkbox" type="checkbox" name="retain"> Keep a read-only cache for this account on this device</label><p class="ws-small ws-muted">Other accounts cannot open this cache.</p>`,'Disconnect',async f=>mutate('graph_disconnect',{retainCache:f.has('retain')}));
    case 'sources-more':{
      const scope=current().id,wasDirty=pendingSettingsEdit;b.disabled=true;pendingSettingsEdit=true;
      try{await store.mutate('sources_more',{},scope);if(current().id!==scope)return;const form=document.getElementById('sources-form');const selected=[...form.querySelectorAll('[name=chat]:checked')].map(x=>x.value);const catalog=v.records(sn(),'catalog').find(r=>r.id==='chats');document.getElementById('source-chats-list').innerHTML=v.chatOptions(catalog?.data.values||[],selected);b.hidden=!catalog?.data.hasMore;}
      finally{b.disabled=false;const form=document.getElementById('sources-form');if(current().id===scope&&form){const f=new FormData(form),w=current();pendingSettingsEdit=wasDirty||f.has('mail')!==!!w.sources.mail||JSON.stringify(f.getAll('chat').sort())!==JSON.stringify([...(w.sources.chats||[])].sort())||JSON.stringify(f.getAll('calendar').sort())!==JSON.stringify([...(w.sources.calendars||[])].sort());}else pendingSettingsEdit=false;}
      return;
    }
    case 'sources-save':{const f=new FormData(document.getElementById('sources-form'));await mutate('sources_save',{sources:{calendars:f.getAll('calendar'),chats:f.getAll('chat'),mail:f.has('mail')}});await mutate('sync_request');toast('Sources saved. Refresh is queued.');return;}
    case 'sync':await mutate('sync_request');toast(sn().connection?'Refresh queued in Activity.':'Connect Microsoft in Settings to refresh sources.');return;
    case 'calendar-mode':state.calendarMode=b.dataset.mode;await render();return ensureCalendarWindow();
    case 'calendar-today':{const parts=v.dateKey(new Date(),sn().settings.timeZone).split('-').map(Number);state.calendarDate=new Date(parts[0],parts[1]-1,parts[2],12);await render();return ensureCalendarWindow();}
    case 'calendar-prev':case 'calendar-next':{const d=new Date(state.calendarDate);const n=action==='calendar-prev'?-1:1;if(state.calendarMode==='month')d.setMonth(d.getMonth()+n);else d.setDate(d.getDate()+n*(state.calendarMode==='week'?7:14));state.calendarDate=d;await render();return ensureCalendarWindow();}
    case 'calendar-refresh':await ensureCalendarWindow(true);toast('Calendar refresh queued in background.');return;
    case 'event':return eventDialog(getRecord('event',id));
    case 'new-event':return eventDialog();
    case 'event-reminder':{const event=getRecord('event',id);const start=Math.floor(new Date(event.data.start)/1000);return modal('Event reminder',`<p>${e(event.data.title)}</p><label>Remind me<select class="ws-select" name="minutes"><option value="5">5 minutes before</option><option value="10" selected>10 minutes before</option><option value="15">15 minutes before</option><option value="30">30 minutes before</option></select></label><p class="ws-small ws-muted">OS notifications must be enabled. Expired meeting reminders are suppressed.</p>`,'Save reminder',async f=>mutate('schedule_save',{kind:'event_reminder',eventId:id,eventRevision:event.revision,minutes:Number(f.get('minutes')),start}));}
    case 'source':return store.query('open_source',{id,kind:b.dataset.kind,join:b.dataset.join==='true'});
    case 'lane':state.lane=b.dataset.lane;return render();
    case 'inbox-more':state.inboxLimit+=200;return render();
    case 'show-archived':state.showArchived=b.checked;return render();
    case 'show-snoozed':state.showSnoozed=b.checked;return render();
    case 'message':return messageDialog(getRecord('message',id));
    case 'message-lane':{const lane=dialog.querySelector('[name=lane]').value;const source=dialogSources.get(dialog)||getRecord('message',id);if(source.data.lane==='critical'&&lane!=='critical')return confirm('Acknowledge and move?','Acknowledgement stops this account incident’s pending repeats across workspaces. The lane change applies to this workspace.',async()=>{await mutate('inbox_decision',{id,action:'lane',lane,acknowledge:true});dialog.close();},'Acknowledge and move');await mutate('inbox_decision',{id,action:'lane',lane});dialog.close();return;}
    case 'message-snooze':{const value=dialog.querySelector('[name=snooze]').value;if(!value)throw new Error('Choose a snooze time.');const until=Math.floor(new Date(value)/1000);if(source.data.lane==='critical')return confirm('Pause critical reminders everywhere?','This pauses this incident’s reminders across all workspaces until the selected time. It does not acknowledge the incident.',async()=>{await mutate('inbox_decision',{id,action:'snooze',until,confirmGlobal:true});dialog.close();},'Pause reminders');await mutate('inbox_decision',{id,action:'snooze',until});dialog.close();return;}
    case 'message-archive':await mutate('inbox_decision',{id,action:source.data.lifecycle==='archived'?'restore':'archive'});dialog.close();return;
    case 'message-ack':await mutate('inbox_decision',{id,action:'acknowledge'});dialog.close();return;
    case 'draft-save':{const text=dialog.querySelector('[name=body]').value;if(text.trim())await mutate('draft_save',{text,sourceId:id,sourceRevision:source.revision});else{const previous=v.records(sn(),'draft').find(r=>r.data.sourceId===id&&!r.data.aiSuggested);if(previous)await mutate('local_delete',{kind:'draft',id:previous.id});}dialog.querySelector('[name=body]').defaultValue=text;toast('Draft saved on this device.');return;}
    case 'ai-probe':{const result=await mutate('ai_probe');toast(result.message);return;}
    case 'ai-pin':{const result=await mutate('ai_probe');if(!result.ready)throw new Error(result.message);await mutate('workspace_update',{aiProfile:'claude-api'});toast('Claude API profile pinned to this workspace.');return;}
    case 'ai-draft':{await mutate('ai_draft',{sourceId:id});toast('AI draft queued. Your text stays unchanged. Use Load AI suggestion when Activity shows it is ready.');return;}
    case 'ai-load':{await store.refresh();const candidate=v.records(sn(),'draft').find(r=>r.data.sourceId===id&&r.data.aiSuggested);if(!candidate){toast('No completed AI suggestion yet. Check Activity for its status.');return;}const field=dialog.querySelector('[name=body]');const apply=()=>{field.value=candidate.data.text;};if(field.value.trim()&&field.value!==candidate.data.text)return confirm('Replace the current reply text?','Load the completed AI suggestion into the editor. Review and edit it before sending.',apply,'Load suggestion');apply();return;}
    case 'action-detail':{const r=getRecord('action',id);if(r.data.state==='prepared')return reviewAction({actionId:r.id,workspaceId:r.workspaceId,nonce:r.data.nonce,account:r.data.account,review:r.data.review});return modal('Action outcome',`<strong>${e(r.data.state)}</strong><p>${e(r.data.message||'This action was interrupted. Check the provider before taking another action.')}</p>`,null);}
    case 'commitment':return commitmentDialog(id?source:null);
    case 'commitment-toggle':{const r=getRecord('commitment',id);return mutate('local_save',{kind:'commitment',id,text:r.data.text,done:b.checked,due:r.data.due,owner:r.data.owner,sourceId:r.data.sourceId,quote:r.data.quote});}
    case 'local-delete':return mutate('local_delete',{kind:b.dataset.kind,id});
    case 'save-note':{const text=document.getElementById('today-note').value;if(!text.trim()&&id)return mutate('local_delete',{kind:'note',id});await mutate('local_save',{kind:'note',id:id||undefined,text});toast('Note saved.');return;}
    case 'brief':await savePendingNote();await mutate('brief_generate');toast('Brief refreshed from current selected sources.');return;
    case 'focus':await mutate('settings_update',{focusUntil:sn().settings.focusUntil>Date.now()/1000?null:Math.floor(Date.now()/1000)+1500});return;
    case 'customize':{const layout=current().layout;return modal('Customize Today',`<p>Choose the widgets you want, in the order they should appear.</p><div id="widget-order">${[...layout,...['brief','calendar','inbox','commitments','focus'].filter(k=>!layout.includes(k))].map(key=>`<div class="ws-row" data-widget="${key}"><input class="ws-checkbox" type="checkbox" name="widget" value="${key}" ${layout.includes(key)?'checked':''}><span class="ws-row-main">${e(key[0].toUpperCase()+key.slice(1))}</span><select class="ws-select" name="width-${key}" aria-label="${key} width">${[[4,'One third'],[6,'Half'],[8,'Two thirds'],[12,'Full width']].map(([n,label])=>`<option value="${n}" ${(current().widgetWidths?.[key]||({brief:8,focus:4,calendar:6,inbox:6,commitments:12}[key]))===n?'selected':''}>${label}</option>`).join('')}</select><button type="button" class="ws-btn" data-action="widget-up" aria-label="Move ${key} up">↑</button><button type="button" class="ws-btn" data-action="widget-down" aria-label="Move ${key} down">↓</button></div>`).join('')}</div>`,'Save layout',async f=>mutate('layout_save',{layout:f.getAll('widget'),widgetWidths:Object.fromEntries([...f].filter(([key])=>key.startsWith('width-')).map(([key,value])=>[key.slice(6),Number(value)]))}));}
    case 'widget-up':{const row=b.closest('[data-widget]');if(row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);return;}
    case 'widget-down':{const row=b.closest('[data-widget]');if(row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);return;}
    case 'rule-new':return modal('Add a critical rule',input('Match keyword or phrase','keyword','','text','required')+input('Sender email (optional)','sender')+'<p class="ws-small ws-muted">Matches selected sources. Automated sender exclusions still apply. Review notifications before enabling repeats.</p>','Save rule',async f=>mutate('local_save',{kind:'rule',text:'Critical: '+f.get('keyword'),keyword:f.get('keyword'),sender:f.get('sender'),lane:'critical',enabled:true}));
    case 'schedule-new':return scheduleDialog();
    case 'schedule-delete':return mutate('schedule_delete',{id});
    case 'job-cancel':return mutate('job_cancel',{id});
    case 'job-retry':return mutate('job_retry',{id});
    case 'notification-permission':return mutate('notification_permission');
    case 'notification-test':await mutate('notification_test');toast('Test reminder queued. Check the OS notification area and Activity.');return;
    case 'export':{const result=await store.query('export');const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='codemie-workspace-local-export.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    case 'prepare-tools':legacyModule ||= await import('../renderer.js');await legacyModule.initLegacyTools();runtimeReady=true;return render();
    default:throw new Error('This action is not available. Refresh the view and try again.');
  }
}
document.addEventListener('click',async ev=>{const b=ev.target.closest('[data-action]');if(!b||!b.closest('#workspace-app,.ws-modal'))return;if(['checkbox','radio'].includes(b.type))return;ev.preventDefault();if(b.disabled)return;const wasDisabled=b.disabled;b.disabled=true;try{await handle(b.dataset.action,b);}catch(error){toast(error.message||String(error));}finally{b.disabled=wasDisabled;}});
document.addEventListener('change',async ev=>{try{if(ev.target.id==='workspace-select'){if(legacyMounted&&legacyModule&&!await legacyModule.leaveLegacyTools()){ev.target.value=sn().settings.activeWorkspace;return;}await savePendingNote();await mutate('workspace_select',{id:ev.target.value});await render();}else if(ev.target.matches('[data-action][type=checkbox]'))await handle(ev.target.dataset.action,ev.target);}catch(error){toast(error.message||String(error));await render();}});
document.addEventListener('input',ev=>{if(ev.target.id==='inbox-search'){state.search=ev.target.value;clearTimeout(readTimer);const pos=ev.target.selectionStart;readTimer=setTimeout(async()=>{await render();const input=document.getElementById('inbox-search');input?.focus();input?.setSelectionRange(pos,pos);},250);}});
for(const event of ['input','change'])document.addEventListener(event,ev=>{if(state.route==='settings'&&ev.target.closest('#workspace-main')&&ev.target.matches('input,select,textarea')&&!ev.target.dataset.action)pendingSettingsEdit=true;});

function flushNotification(){if(deferredNotification&&!pendingSettingsEdit&&!document.querySelector('.ws-modal[open]')&&!legacyModule?.legacyToolsBusy()){const next=deferredNotification;deferredNotification=null;queueMicrotask(()=>openNotification(next).catch(error=>toast(error.message||String(error))));}}
async function openNotification(payload){
  if(pendingSettingsEdit||document.querySelector('.ws-modal[open]')||legacyModule?.legacyToolsBusy()){deferredNotification=payload;toast('Finish or close your current edits to open this notification.');return;}
  await savePendingNote();
  if(payload.workspaceId&&payload.workspaceId!==sn().settings.activeWorkspace)await mutate('workspace_select',{id:payload.workspaceId});
  await store.refresh();
  await route(payload.eventId?'calendar':payload.itemId?'inbox':'settings',payload.eventId||payload.itemId?undefined:'activity');
  if(payload.itemId){const record=getRecord('message',payload.itemId);if(record)messageDialog(record);}
  if(payload.eventId){const record=getRecord('event',payload.eventId);if(record)eventDialog(record);}
}
async function boot(){
  if(!invoke){root.innerHTML=`<div class="ws-error-page"><h1>Open CodeMie Connect</h1><p>This is the real application interface. Native storage and integrations are available in the desktop app.</p></div>`;return;}
  root.innerHTML='<div class="ws-loading" role="status">Opening your workspace…</div>';
  const flags=await invoke('smoke_mode');
  if(flags.smoke||flags.probe){root.classList.add('hidden');legacy.classList.remove('hidden');legacyModule=await import('../renderer.js');await legacyModule.initLegacyTools();return;}
  const hash=location.hash.split('/');if(hash[1])state.route=['today','calendar','inbox','workspaces','settings'].includes(hash[1])?hash[1]:'today';if(hash[2])state.settingsTab=hash[2];
  try{await store.refresh();}catch(error){
    root.innerHTML=`<div class="ws-error-page"><h1>Workspace storage needs attention</h1><p>${e(error.message||error)}</p><p>The original database is retained. Your existing CodeMie tools are available.</p><button id="recovery-tools" class="ws-btn">Open existing tools</button></div>`;
    document.getElementById('recovery-tools').onclick=async()=>{root.classList.add('hidden');legacy.classList.remove('hidden');legacyModule=await import('../renderer.js');await legacyModule.initLegacyTools();};return;
  }
  runtimeReady=await invoke('runtime_ready').catch(()=>false);
  state.appVersion=await invoke('get_app_version');
  // First upgrade preserves the old theme hint. All later preferences come from native storage.
  if(sn().revision===0){const old=localStorage.getItem('cm-theme');await mutate('settings_update',{theme:['light','dark'].includes(old)?old:'system',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'});}
  store.subscribe(result=>{
    applyTheme(result.snapshot.settings.theme);
    if(pendingSettingsEdit||document.querySelector('.ws-modal[open]')||legacyMounted||document.activeElement?.matches('input,textarea,select'))return;
    render();
  });
  const calendarParts=v.dateKey(new Date(),sn().settings.timeZone).split('-').map(Number);state.calendarDate=new Date(calendarParts[0],calendarParts[1]-1,calendarParts[2],12);
  ready=true;
  await render();
  const listen=window.__TAURI__.event.listen;
  let debounce;
  for(const event of ['workspace:changed','connection:changed'])await listen(event,()=>{clearTimeout(debounce);debounce=setTimeout(()=>store.refresh().catch(err=>toast(err.message)),150);});
  await listen('workspace:quit-request',async()=>{if(state.updateBusy){toast('The app update is in progress. Keep Connect open until it finishes.');return;}if(legacyModule)await legacyModule.leaveLegacyTools();});
  await listen('workspace:notification-open',event=>openNotification(event.payload||{}).catch(error=>toast(error.message||String(error))));
  await listen('workspace:installer-settled',flushNotification);
  window.addEventListener('focus',()=>store.refresh().catch(()=>{}));
  matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{if(sn().settings.theme==='system')applyTheme('system');});
  window.addEventListener('cm-theme-change',event=>mutate('settings_update',{theme:event.detail}).catch(error=>toast(error.message||String(error))));
  authTimer=setInterval(()=>{if(store.get()?.authPending)store.refresh().catch(()=>{});},1500);
  window.addEventListener('pagehide',()=>clearInterval(authTimer),{once:true});
  if(state.route==='calendar')await ensureCalendarWindow();
  if(flags.dev)window.__workspace={store,state,route,render};
  if(shouldCheckForAppUpdate(localStorage.getItem(`codemie.app.lastUpdateCheck.${state.appVersion}`)))checkAppUpdate().catch(()=>{});
}
async function checkAppUpdate(){state.updateStatus='Checking for updates…';if(state.route==='settings'&&state.settingsTab==='updates')await render();try{state.latestVersion=(await invoke('check_for_update'))||state.latestVersion;state.updateStatus=state.latestVersion?`Version ${state.latestVersion} is available.`:'No newer release was reported. Check the session log if the network is unavailable.';localStorage.setItem(`codemie.app.lastUpdateCheck.${state.appVersion}`,new Date().toISOString());}catch(error){state.updateStatus=error.message||String(error);}if(state.route==='settings'&&state.settingsTab==='updates'&&!document.querySelector('.ws-modal[open]'))await render();}
boot().catch(error=>{window.__bootError=String(error.stack||error);toast(error.message||String(error));});
