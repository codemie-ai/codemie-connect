import {groupCalendarEvents} from '../workspace/views.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore,escapeHtml,calendarDays,calendarWindow,calendarCoverage} from '../workspace/store.js';
import {runReadOnlyProbe} from '../workspace/safe-probe.js';

test('the probe only invokes explicit read-only inspectors',async()=>{
  const calls=[];const inspectors=new Proxy(Object.fromEntries(['checkGit','checkNode','checkNpm','checkCodemie'].map(k=>[k,async()=>{calls.push(k);return{ok:true};}])),{get(target,key){if(!(key in target))throw Error(`Mutation or unsupported probe: ${key}`);return target[key];}});
  assert.equal(Object.keys(await runReadOnlyProbe(inspectors)).length,4);
  assert.deepEqual(calls,['checkGit','checkNode','checkNpm','checkCodemie']);
});
test('workspace mutations serialize against refreshed native revisions',async()=>{
  let revision=0;const mutations=[];
  const store=createStore(async(_,{request:r})=>{if(r.op==='snapshot')return{snapshot:{revision,settings:{activeWorkspace:'personal'}}};assert.equal(r.expectedRevision,revision);assert.ok(r.operationId);mutations.push(r.op);await new Promise(resolve=>setTimeout(resolve,5));revision++;return{saved:true};});
  await store.refresh();await Promise.all([store.mutate('workspace_create',{name:'A'}),store.mutate('settings_update',{theme:'dark'})]);
  assert.deepEqual(mutations,['workspace_create','settings_update']);assert.equal(store.get().snapshot.revision,2);
});
test('a rejected mutation refreshes canonical state before the next write',async()=>{
  let revision=0;const store=createStore(async(_,{request:r})=>{if(r.op==='snapshot')return{snapshot:{revision,settings:{activeWorkspace:'personal'}}};if(r.op==='first'){revision=3;throw{code:'conflict'};}assert.equal(r.expectedRevision,3);return{};});await store.refresh();await assert.rejects(store.mutate('first'));await store.mutate('second');
});
test('calendar grid crosses month/year boundaries without missing days',()=>{const days=calendarDays(new Date(2026,11,31,12),'month');assert.equal(days.length,42);assert.equal(days[0].getDay(),1);for(let i=1;i<days.length;i++){const prev=new Date(days[i-1]);prev.setDate(prev.getDate()+1);assert.equal(days[i].getDate(),prev.getDate());}});
test('untrusted source text is escaped before HTML rendering',()=>{assert.equal(escapeHtml('<img onerror="run()">&'), '&lt;img onerror=&quot;run()&quot;&gt;&amp;');});

test('calendar coverage requires every selected calendar and a complete requested period',()=>{const window=calendarWindow(new Date(2026,10,16,12),'week');assert.ok(window.end-window.start>=7*86400);const s={settings:{activeWorkspace:'p'},workspaces:[{id:'p',sources:{calendars:['a','b']}}],records:[{kind:'calendar_window',source:'calendar:a',data:window}]};assert.equal(calendarCoverage(s,window),false);s.records.push({kind:'calendar_window',source:'calendar:b',data:{start:window.start+1,end:window.end}});assert.equal(calendarCoverage(s,window),false);s.records[1].data.start=window.start;assert.equal(calendarCoverage(s,window),true);});

test('overnight timed events and all-day exclusive ends occupy exactly their covered dates',()=>{const days=[16,17,18].map(day=>new Date(2026,10,day,12));const timed={id:'overnight',data:{start:'2026-11-16T23:00:00Z',end:'2026-11-18T00:00:00Z',allDay:false}},allDay={id:'all-day',data:{start:'2026-11-16T00:00:00Z',end:'2026-11-18T00:00:00Z',startDate:'2026-11-16',endDate:'2026-11-18',allDay:true}};const groups=groupCalendarEvents([timed,allDay],days,'UTC');assert.deepEqual(groups.map(g=>g.events.length),[2,2,0]);});
