// Read-only projections of the native snapshot shared by every view.
import { activeWorkspace } from './calendar-model.js';

export { activeWorkspace as active };

export const records = (s, kind) => s.records.filter(r => r.kind === kind);

export const LANES = [
  ['reply', 'Needs reply'],
  ['critical', 'Critical'],
  ['waiting', 'Waiting'],
  ['fyi', 'FYI'],
  ['low', 'Low priority'],
  ['decisions', 'Decisions'],
];
export const laneLabel = lane => LANES.find(([key]) => key === lane)?.[1] || 'Inbox';

export function visibleMessages(s, { archived = false, snoozed = false } = {}) {
  const now = Date.now() / 1000;
  return records(s, 'message')
    .filter(r => !r.data.deleted
      && (archived ? r.data.lifecycle === 'archived' : r.data.lifecycle !== 'archived')
      && (snoozed || !(r.data.snoozedUntil > now)))
    .sort((a, b) => (b.data.at || 0) - (a.data.at || 0));
}

/**
 * Teams chats arrive as many short messages; lists show one row per chat (its newest message in
 * the list) and the count of messages it stands for. Mail stays one row per message.
 * Input must be sorted newest first.
 */
/** Stable identity of a list row: a Teams chat is one row whatever its newest message is. */
export const messageKey = m => (m.data.channel === 'chat' ? `chat:${m.data.conversationId || m.source}` : m.id);

export function collapseChats(messages) {
  const counts = new Map();
  const leaders = new Map();
  const items = [];
  for (const m of messages) {
    if (m.data.channel !== 'chat') {
      items.push(m);
      continue;
    }
    const key = messageKey(m);
    const leader = leaders.get(key);
    if (leader) {
      counts.set(leader.id, (counts.get(leader.id) || 1) + 1);
      continue;
    }
    leaders.set(key, m);
    items.push(m);
  }
  return { items, counts };
}

/**
 * Messages that ask something of the user: unacknowledged critical first, then replies, one row
 * per Teams chat. A chat with a critical message is represented by that message, never hidden
 * behind a newer reply in the same chat.
 */
export function attentionMessages(s) {
  const all = visibleMessages(s);
  const critical = collapseChats(all.filter(m => m.data.lane === 'critical' && !m.data.acknowledgedAt)).items;
  const taken = new Set(critical.map(messageKey));
  const replies = collapseChats(all.filter(m => m.data.lane === 'reply' && !taken.has(messageKey(m)))).items;
  return [...critical, ...replies];
}

function currentJobPolicy(s, job) {
  if (!job.policy) return true;
  const w = s.workspaces.find(x => x.id === job.workspaceId);
  const c = s.connection;
  if (w && (w.archived || job.policy.workspaceRevision !== w.accessRevision)) return false;
  if (job.connectionId && (!c || job.connectionId !== c.id || job.policy.generation !== c.generation || job.policy.policyRevision !== c.policyRevision)) return false;
  if (!job.workspaceId && job.connectionId && job.policy.sourceRevision !== c?.sourceRevision) return false;
  return true;
}

/**
 * Claude work whose failures are shown where it was asked for (the reply box, the summary card,
 * the automation's Run log), not as decisions.
 */
export const INLINE_AI_JOBS = new Set(['ai_draft', 'ai_summarize', 'automation_run']);

/** The daily "tasks due today" reminder: a notification job, but no critical alert. */
export const tasksDueJob = job => job.kind === 'notification' && String(job.key || '').startsWith('tasks_due:');

/** Prepared actions and failed/blocked work that need a human decision. */
export function decisions(s) {
  return [
    ...records(s, 'action').filter(r => ['prepared', 'dispatching', 'unknown_outcome', 'rejected'].includes(r.data.state)),
    ...s.jobs.filter(j => ['failed', 'blocked'].includes(j.state) && j.kind !== 'sync' && !INLINE_AI_JOBS.has(j.kind) && currentJobPolicy(s, j)),
  ];
}

// ---------------------------------------------------------------- reply drafts (DESIGN 6.4)

/**
 * What one AI draft answers: an Outlook message (its id, as Review & send does) or a whole
 * Teams chat (the row key). Matches `draft_key` in `ai_jobs.rs`.
 */
export const draftKeyOf = m => (m.data.channel === 'chat' ? messageKey(m) : m.id);

/** The newest `ai_draft` job for a draft key; the snapshot lists jobs newest first. */
export function draftJob(s, key) {
  const jobs = s.jobs.filter(j => j.kind === 'ai_draft' && j.payload?.draftKey === key);
  return jobs.find(j => ['queued', 'running'].includes(j.state)) || jobs.sort((a, b) => (b.dueAt || 0) - (a.dueAt || 0))[0] || null;
}

// ---------------------------------------------------------------- thread summaries (DESIGN 6.5)

/** What one summary covers; matches `conversation_key` in `prompts.rs`. */
export const summaryKeyOf = m => (m.data.channel === 'chat' ? messageKey(m) : m.data.conversationId ? `mail:${m.data.conversationId}` : m.id);

/** The summary record of a conversation (its `stale` flag is computed in the snapshot). */
export const summaryFor = (s, m) => {
  const key = summaryKeyOf(m);
  return s.records.find(r => r.kind === 'summary' && (r.id === key || r.data.conversationKey === key)) || null;
};

/** The newest `ai_summarize` job of a conversation; a queued or running one wins. */
export function summaryJob(s, key) {
  const jobs = s.jobs.filter(j => j.kind === 'ai_summarize' && j.payload?.conversationKey === key);
  return jobs.find(j => ['queued', 'running'].includes(j.state)) || jobs.sort((a, b) => (b.dueAt || 0) - (a.dueAt || 0))[0] || null;
}

/** Claude's draft record for a draft key (`ai:<key>`). */
export function latestDraft(s, key) {
  return s.records.find(r => r.kind === 'draft' && r.data.aiSuggested && (r.data.draftKey === key || r.id === `ai:${key}`)) || null;
}

/** The reply the user saved in Connect for a conversation (one per conversation). */
export function savedReply(s, m) {
  const threadIds = new Set(conversation(s, m).map(t => t.id));
  return records(s, 'draft').filter(r => threadIds.has(r.data.sourceId) && !r.data.aiSuggested).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

export const syncRunning = s => s.jobs.some(j => j.kind === 'sync' && ['queued', 'running'].includes(j.state));

/**
 * Microsoft connection state for the active workspace:
 * none | authorizing | needs_login | other_account | syncing | connected
 */
export function connectionState(s, auth = {}) {
  const c = s.connection;
  const w = activeWorkspace(s);
  if (auth.authPending) return 'authorizing';
  if (!c || c.status === 'disconnected') return 'none';
  if (c.status !== 'connected') return 'needs_login';
  if (w.connectionId && w.connectionId !== c.id) return 'other_account';
  if (!s.available) return 'syncing';
  return 'connected';
}

export const can = (s, capability) => !!s.connection?.enabled?.includes(capability) && s.connection.status === 'connected';

export function chatCatalog(s) {
  return s.records.find(r => r.kind === 'catalog' && r.id === 'chats')?.data?.values || [];
}

/** Human title for a Teams message: provider chat title, else members, else a generic label. */
export function messageTitle(m, s) {
  const d = m.data;
  if (d.channel !== 'chat') return d.title || '(No subject)';
  if (d.title && !['Teams conversation', 'Teams chat'].includes(d.title)) return d.title;
  const chatId = d.chatId || m.source?.replace(/^chat:/, '');
  const chat = chatCatalog(s).find(c => c.id === chatId);
  if (chat?.topic) return chat.topic;
  const me = s.connection?.userId;
  const names = (chat?.members || []).filter(x => x.userId !== me && x.displayName).map(x => x.displayName);
  return names.join(', ') || 'Teams chat';
}

export function conversation(s, message) {
  const key = message.data.conversationId;
  if (!key) return [message];
  return records(s, 'message')
    .filter(m => m.data.conversationId === key && !m.data.deleted)
    .sort((a, b) => (a.data.at || 0) - (b.data.at || 0));
}

export function sourceCounts(s) {
  const counts = { events: 0, mail: 0, chat: 0 };
  for (const r of s.records) {
    if (r.kind === 'event') counts.events++;
    else if (r.kind === 'message') counts[r.data.channel === 'chat' ? 'chat' : 'mail']++;
  }
  return counts;
}
