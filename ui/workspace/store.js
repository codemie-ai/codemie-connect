// Native snapshots are authoritative. localStorage holds only the pre-paint theme hint.
export function createStore(invoke) {
  let state = null;
  let latestRead = 0;
  let chain = Promise.resolve();
  const listeners = new Set();
  async function refresh() {
    const read = ++latestRead;
    const result = await invoke('workspace_request', { request: { op: 'snapshot' } });
    if (read === latestRead) { state = result; listeners.forEach(fn => fn(result)); }
    return state;
  }
  function mutate(op, data = {}, workspaceId) {
    const run = async () => {
      if (!state) await refresh();
      try {
        return await invoke('workspace_request', {request:{op, data, workspaceId:workspaceId ?? state.snapshot.settings.activeWorkspace, expectedRevision:state.snapshot.revision, operationId:crypto.randomUUID()}});
      } finally { await refresh(); }
    };
    const task = chain.then(run, run);
    chain = task.catch(() => {});
    return task;
  }
  async function query(op, data = {}) {
    return invoke('workspace_request', {request:{op,data,workspaceId:state?.snapshot.settings.activeWorkspace}});
  }
  return {get:()=>state, refresh, mutate, query, subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
}
export const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function calendarDays(date, mode) {
  const d = new Date(date);d.setHours(12,0,0,0);
  if (mode === 'month') {d.setDate(1);d.setDate(d.getDate() - (d.getDay()+6)%7);}
  else if (mode === 'week') d.setDate(d.getDate() - (d.getDay()+6)%7);
  const count = mode === 'month' ? 42 : mode === 'week' ? 7 : 14;
  return Array.from({length:count},(_,i)=>{const v=new Date(d);v.setDate(d.getDate()+i);return v;});
}

export function calendarWindow(date,mode){const days=calendarDays(date,mode),start=new Date(days[0]),end=new Date(days.at(-1));start.setHours(0,0,0,0);end.setDate(end.getDate()+1);end.setHours(0,0,0,0);return{start:Math.floor(start/1000)-172800,end:Math.floor(end/1000)+172800};}
export function calendarCoverage(snapshot,window){const workspace=snapshot.workspaces.find(w=>w.id===snapshot.settings.activeWorkspace),calendars=workspace?.sources.calendars||[];return calendars.length>0&&calendars.every(id=>snapshot.records.some(r=>r.kind==='calendar_window'&&r.source==='calendar:'+id&&r.data.start<=window.start&&r.data.end>=window.end));}
