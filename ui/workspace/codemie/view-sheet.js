// The guided-setup sheet: a step rail and one step at a time. Pure; the controller owns the
// sheet state (`sh`) and runs `codemie setup` through the setup session. The project, gateway
// and model lists are the ones the CLI sends, one at a time, with its ⭐ shown as "Recommended".
import { escapeHtml as e } from '../store.js';
import { icon } from '../icons.js';
import { badge, button, field, select, spinner, textInput, toggle } from '../ui.js';
import { APPS, BUILTIN_AGENT, agentDisplay, providerShort } from './catalog.js';
import { appState, setupProgress } from './model.js';
import { DEFAULT_CODEMIE_URL } from './url.js';
import { hostOf, logBlock, plural } from './view-common.js';

const FLOW = {
  setup: [['signin', 'Sign in', 'Your work account'], ['project', 'Project & model', 'What CodeMie uses'], ['agents', 'Coding agents', 'Claude Code and others'], ['apps', 'Your apps', 'Optional']],
  add: [['signin', 'Sign in', 'Account or provider'], ['project', 'Project & model', 'What this profile uses']],
  edit: [['project', 'Project & model', 'What this profile uses']],
  relogin: [['signin', 'Sign in again', 'Same account']],
};

export const OTHER_PROVIDERS = {
  litellm: { name: 'LiteLLM proxy', text: 'OpenAI, Azure OpenAI, Vertex and others through your LiteLLM proxy.',
    fields: [{ key: 'endpoint', label: 'LiteLLM proxy URL', placeholder: 'http://localhost:4000' }, { key: 'key', label: 'API key', secret: true, hint: 'Leave empty if your proxy does not need one.' }] },
  bedrock: { name: 'AWS Bedrock', text: 'Uses an AWS profile from this Mac, or an access key.',
    fields: [{ key: 'awsRegion', label: 'AWS region', placeholder: 'us-east-1' }, { key: 'awsAccessKey', label: 'Access key ID', hint: 'Only if you sign in with an access key instead of an AWS profile.' }, { key: 'awsSecret', label: 'Secret access key', secret: true }] },
  ollama: { name: 'Ollama on this Mac', text: 'Models running locally. Nothing leaves this Mac.',
    fields: [{ key: 'endpoint', label: 'Ollama address', placeholder: 'http://localhost:11434' }] },
};

const PICK = {
  codemieProject: ['CodeMie project', 'Which project?', 'Usage and budgets count against the project. These are the ones your account can use.'],
  integration: ['AI gateway', 'Which AI gateway?', 'Your project has more than one. The default suits most people.'],
  model: ['Default model', 'Which model?', 'Agents can still pick another model when they start.'],
  bedrockAuth: ['AWS sign-in', 'How should CodeMie sign in to AWS?', 'An AWS profile from this Mac is the simplest.'],
  awsProfile: ['AWS profile', 'Which AWS profile?', 'The profiles in ~/.aws on this Mac.'],
};

const activeProfile = (cm) => cm.profiles.find((p) => p.name === cm.config.active) || null;
const installed = (cm) => (cm.agents || []).filter((a) => a.installed && a.command !== BUILTIN_AGENT);
const connected = (cm) => APPS.filter((a) => appState(cm, a.id) === 'connected');
const pct = (cm) => Math.floor((cm.runtime.fraction || 0) * 100);
/** The provider the sheet's sign-in answers mean. */
export const draftProvider = (d) => (d.choice === 'codemie' || d.choice === 'org' ? 'ai-run-sso' : d.choice === 'subscription' ? d.sub : d.provider);
const cleanOption = (o) => String(o).replace(/\s*⭐\s*/g, ' ').trim();

function choiceCard(name, value, checked, title, text, panel = '', side = '') {
  return `<div class="cm-choice-wrap"><label class="cm-choice"><input type="radio" name="${e(name)}" value="${e(value)}" data-action="cm-draft-radio" data-key="${e(name)}" ${checked ? 'checked' : ''}><span class="cm-choice-mark"></span><span class="cm-choice-copy"><strong>${title}</strong>${text ? `<span>${text}</span>` : ''}</span>${side ? `<span class="cm-choice-side">${e(side)}</span>` : ''}</label>${checked && panel ? `<div class="cm-choice-panel">${panel}</div>` : ''}</div>`;
}

function railAnswer(id, sh, cm, prefs) {
  const p = activeProfile(cm);
  if (id === 'signin') return sh.d.signedInAs || (sh.mode === 'setup' ? cm.config.account || p?.name || '' : '');
  if (id === 'project') return sh.mode === 'setup' && p ? [p.codemieProject, p.model].filter(Boolean).join(' · ') : '';
  if (id === 'agents') return installed(cm).map((a) => agentDisplay(a).name).join(', ');
  if (id === 'apps') return connected(cm).map((a) => a.name.split(' — ')[0]).join(', ') || (prefs.appsSkipped ? 'Skipped' : '');
  return '';
}

export function sheetMarkup(sh, cm, prefs = {}) {
  const steps = FLOW[sh.mode];
  const progress = setupProgress(cm, prefs);
  const doneIds = new Set();
  if (sh.mode === 'setup') {
    if (progress.account) { doneIds.add('signin'); doneIds.add('project'); }
    if (progress.agent) doneIds.add('agents');
    if (progress.apps) doneIds.add('apps');
  }
  if (sh.d.signedInAs) doneIds.add('signin');
  if (sh.step === 'done') steps.forEach(([id]) => doneIds.add(id));
  const busy = sheetBusy(sh);
  const rail = steps.map(([id, title, sub], i) => {
    const state = id === sh.step ? 'current' : doneIds.has(id) ? 'done' : 'todo';
    const answer = state === 'done' ? railAnswer(id, sh, cm, prefs) || sub : sub;
    const jump = state === 'done' && sh.step !== 'done' && !busy && id !== 'project' && id !== 'signin';
    return `<button type="button" class="cm-rail-step" data-state="${state}" ${jump ? `data-action="cm-sheet-go" data-step="${id}"` : 'tabindex="-1"'}><span class="cm-rail-num">${state === 'done' ? icon('check') : i + 1}</span><span class="cm-rail-copy"><strong>${e(title)}</strong><span>${e(answer)}</span></span></button>`;
  }).join('');
  const r = cm.runtime;
  const runtime = r.state === 'downloading' ? `<div class="cm-rail-runtime">${spinner('Preparing')}<span>Getting CodeMie ready · ${pct(cm)}%</span></div><div class="cm-progress"><span style="width:${pct(cm)}%"></span></div>`
    : r.state === 'failed' ? `<div class="cm-rail-runtime" style="color:var(--ws-amber)">${icon('alert')}<span>Download stopped — check your connection</span></div><div>${button('Try again', { action: 'cm-runtime-retry', size: 'sm' })}</div>`
      : r.state === 'ready' ? `<div class="cm-rail-runtime">${icon('check-circle')}<span>CodeMie${r.version ? ` ${e(r.version)}` : ''} ready${r.ownCli ? ' (your copy)' : ''}</span></div>` : '';
  const title = sh.mode === 'add' ? 'Add a profile' : sh.mode === 'edit' ? 'Change project and model' : sh.mode === 'relogin' ? 'Sign in again' : 'Set up CodeMie';
  const view = STEP_VIEWS[sh.step](sh, cm, prefs);
  const compact = sh.mode === 'relogin';
  return `<div class="cm-sheet-panel${compact ? ' cm-compact' : ''}" role="dialog" aria-modal="true" aria-label="${e(title)}" tabindex="-1" data-step-key="${e(`${sh.mode}:${sh.step}:${sh.pending?.id || ''}`)}">
    ${compact ? '' : `<aside class="cm-rail">
      <div class="cm-rail-brand"><img class="ws-logo-dark" src="workspace/assets/logo-full-dark.svg" alt="EPAM AI/Run CodeMie"><img class="ws-logo-light" src="workspace/assets/logo-full-light.svg" alt="EPAM AI/Run CodeMie"></div>
      <div class="cm-rail-title">${e(title)}</div>
      <div class="cm-rail-steps">${rail}</div>
      <div class="cm-rail-foot">${runtime}<span>Every command is listed in Settings → CodeMie → Health.</span></div>
    </aside>`}
    <section class="cm-stage">
      <header class="cm-stage-head"><div>${view.eyebrow ? `<p class="ws-eyebrow">${e(view.eyebrow)}</p>` : ''}<h2>${e(view.title)}</h2>${view.text ? `<p>${view.text}</p>` : ''}</div>${button('', { action: 'cm-sheet-close', iconName: 'close', variant: 'ghost', title: sh.step === 'done' ? 'Close' : 'Close — progress is kept' })}</header>
      <div class="cm-stage-body">${view.body}</div>
      <footer class="cm-stage-foot">${view.left || ''}<span class="ws-spacer"></span>${view.note ? `<span class="cm-foot-note" title="${e(view.note)}">${e(view.note)}</span>` : ''}${view.right || ''}</footer>
    </section>
  </div>`;
}

/** Something in the sheet is running: the browser sign-in, an install, a connect. */
export function sheetBusy(sh) {
  const d = sh?.d;
  return !!d && (['queued', 'installing', 'checking', 'waiting'].includes(d.signin) || d.install?.state === 'running' || d.appsRun?.state === 'running' || !!sh.saving);
}

function problemBox(err) {
  if (!err) return '';
  return `<div class="cm-problem" style="margin-bottom:14px"><strong>${icon('alert')}${e(err.title)}</strong><p>${e(err.text)}</p>${err.cmd ? logBlock(err.cmd, err.output, { always: true }) : ''}</div>`;
}

const STEP_VIEWS = {
  welcome: (sh, cm, prefs = {}) => ({
    eyebrow: 'Welcome to CodeMie Connect', title: 'Let’s get your AI coding tools working',
    text: 'Connect sets up CodeMie for you — the same steps as the CodeMie CLI, without Terminal.',
    body: `<div class="cm-welcome">
      <div class="cm-benefits">
        <div class="cm-benefit">${icon('terminal')}<div><strong>Coding agents with your CodeMie access</strong><span>Claude Code, Gemini CLI, Codex and more — installed and signed in for you.</span></div></div>
        <div class="cm-benefit">${icon('monitor')}<div><strong>Claude Desktop and VS Code on CodeMie models</strong><span>Optional. One click each, and they keep working after a restart.</span></div></div>
        <div class="cm-benefit">${icon('spark')}<div><strong>AI drafts in Connect</strong><span>The same profile drafts Outlook and Teams replies for your review.</span></div></div>
      </div>
      <p class="cm-time-note">${icon('clock')}${cm.org ? `About 3 minutes. You need your ${e(cm.org.organizationName || 'work')} account.` : 'About 3 minutes. You need your work account, and the VPN if you are outside the office.'}</p>
    </div>`,
    left: button('Not now', { action: 'cm-sheet-later', variant: 'ghost' }),
    // `resumeFrom`: Today shows no setup card while a ready Claude waits for setup to start.
    note: `You can finish later from ${prefs.resumeFrom || 'Today or Settings → CodeMie'}`,
    right: button('Get started', { action: 'cm-sheet-go', variant: 'primary', iconRight: 'arrow', attrs: { 'data-step': 'signin' } }),
  }),

  signin: (sh, cm) => {
    const d = sh.d;
    const relogin = sh.mode === 'relogin';
    let body;
    if (d.signin === 'queued') {
      body = `<div class="cm-waiting">${spinner('Preparing')}<strong>Getting CodeMie ready first…</strong><p>CodeMie is still downloading (${pct(cm)}%). Sign-in starts on its own as soon as it is done — no need to click again.</p><div class="cm-progress" style="width:100%;max-width:320px"><span style="width:${pct(cm)}%"></span></div></div>`;
    } else if (d.signin === 'installing') {
      const agent = d.sub === 'moonshot-subscription' ? 'Kimi Code' : 'Claude Code';
      body = `<div class="cm-waiting">${spinner('Installing')}<strong>Installing ${agent} first…</strong><p>Signing in with a subscription uses ${agent}’s own sign-in, so Connect installs it now. You’d want it anyway.</p></div>`;
    } else if (d.signin === 'checking') {
      body = `<div class="cm-waiting">${spinner('Checking')}<strong>Checking ${e(hostOf(d.url))}…</strong><p>Making sure this address answers like CodeMie before the browser opens.</p></div>`;
    } else if (d.signin === 'waiting') {
      const notice = d.notice ? `<p class="ws-inline-note" style="margin-top:10px">${icon('alert')}<span>${e(d.notice)}</span></p>` : '';
      body = d.browser || relogin
        ? `<div class="cm-waiting">${spinner('Waiting for sign-in')}<strong>Finish signing in in your browser</strong><p>${relogin || draftProvider(d) === 'ai-run-sso' ? `A CodeMie sign-in page opened in your browser (${e(hostOf(d.url))}). Use your work account.` : 'A sign-in page opened in your browser.'} Then come back here — Connect continues on its own.</p>${notice}</div>`
        : `<div class="cm-waiting">${spinner('Working')}<strong>${draftProvider(d) === 'ai-run-sso' ? 'Starting CodeMie sign-in…' : `Checking ${e(OTHER_PROVIDERS[d.provider]?.name || providerShort(draftProvider(d)))}…`}</strong><p>${draftProvider(d) === 'ai-run-sso' ? 'Your browser opens in a moment.' : 'Asking it which models it offers. Nothing is saved yet.'}</p>${notice}</div>`;
    } else if (d.signin === 'done') {
      body = `<div class="cm-waiting" style="border-style:solid">${icon('check-circle')}<strong>Signed in</strong><p>${relogin ? 'Everything that uses this profile works again.' : 'Loading your projects and models…'}</p></div>`;
    } else if (relogin) {
      body = `${problemBox(d.error)}<div class="cm-answers"><div class="cm-answer">${icon('user')}<span>Profile</span><strong>${e(sh.profile)}</strong></div><div class="cm-answer">${icon('globe')}<span>Server</span><strong>${e(hostOf(d.url))}</strong></div></div><p class="ws-muted ws-hint">Your project, model, agents and apps stay exactly as they are. Only the sign-in is renewed.</p>`;
    } else {
      const preset = cm.org;
      const main = preset?.codemieUrl || DEFAULT_CODEMIE_URL;
      const urlLine = `<span class="cm-inline">Address <strong>${e(hostOf(main))}</strong>${preset ? '<span>· set by your IT team</span>' : ''}</span>`;
      const recent = [...new Set(cm.profiles.filter((p) => p.provider === 'ai-run-sso' && p.codemieUrl && p.codemieUrl !== main).map((p) => p.codemieUrl))];
      const orgPanel = `${field('CodeMie address', textInput({ value: d.orgUrl, 'data-draft': 'orgUrl', placeholder: 'https://codemie.your-company.com', spellcheck: 'false', autocomplete: 'off', inputmode: 'url' }), 'The address you open CodeMie at in the browser. Your administrator can tell you. Connect checks it before you sign in.')}
        ${recent.length ? `<span class="cm-inline">Used before on this Mac: ${recent.map((u) => `<button type="button" class="cm-link" data-action="cm-org-pick" data-url="${e(u)}">${e(hostOf(u))}</button>`).join(' ')}</span>` : ''}`;
      const subAgent = d.sub === 'moonshot-subscription' ? ['kimi', 'Kimi Code'] : ['claude', 'Claude Code'];
      const hasAgent = (cm.agents || []).some((a) => a.command === subAgent[0] && a.installed);
      const subPanel = `${field('Subscription', select([['anthropic-subscription', 'Claude (Pro or Max)'], ['moonshot-subscription', 'Kimi']], d.sub, { 'data-action': 'cm-draft-select', 'data-key': 'sub', 'aria-label': 'Subscription' }))}
        <span>Signs in with ${subAgent[1]}’s own browser sign-in${hasAgent ? '' : ` — Connect installs ${subAgent[1]} first`}. Usage is billed to your subscription, not to CodeMie.</span>`;
      const other = OTHER_PROVIDERS[d.provider];
      const otherPanel = `${field('Provider', select(Object.entries(OTHER_PROVIDERS).map(([id, p]) => [id, p.name]), d.provider, { 'data-action': 'cm-draft-select', 'data-key': 'provider', 'aria-label': 'Provider' }))}
        <span>${e(other.text)}</span>
        ${other.fields.map((f) => field(f.label, textInput({ value: d[f.key] || '', 'data-draft': f.key, type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off' }), f.hint || '')).join('')}
        ${other.fields.some((f) => f.secret) ? `<span class="ws-field-hint">${icon('lock')} Typed into the CodeMie CLI only. Connect does not keep it.</span>` : ''}`;
      const orgName = preset?.organizationName;
      body = `${problemBox(d.error)}<div class="cm-choices">
        ${choiceCard('choice', 'codemie', d.choice === 'codemie', preset ? `${e(orgName || 'Your organization’s')} CodeMie ${badge('Your organization', 'purple')}` : `EPAM AI/Run CodeMie ${badge('Recommended', 'purple')}`, preset ? `Sign in with your ${e(orgName || 'work')} account in the browser. Nothing to copy or paste.` : 'Sign in with your EPAM account in the browser. Nothing to copy or paste.', urlLine)}
        ${choiceCard('choice', 'org', d.choice === 'org', preset ? 'A different CodeMie address' : 'CodeMie at my organization', preset ? 'Another CodeMie your team uses.' : 'Your company or client runs its own CodeMie. Enter its address and sign in the same way.', orgPanel)}
        ${choiceCard('choice', 'subscription', d.choice === 'subscription', 'My Claude or Kimi subscription', 'Use a personal Claude Pro/Max or Kimi plan instead of CodeMie.', subPanel)}
        ${choiceCard('choice', 'other', d.choice === 'other', 'LiteLLM, AWS Bedrock or Ollama', 'For teams that run their own model access.', otherPanel)}
      </div>`;
    }
    const busy = ['queued', 'installing', 'checking', 'waiting', 'done'].includes(d.signin);
    const browser = relogin || d.choice !== 'other';
    return {
      eyebrow: relogin ? `Profile ${sh.profile}` : sh.mode === 'add' ? 'New profile · step 1 of 2' : 'Step 1 of 4',
      title: relogin ? 'Sign in to CodeMie again' : 'How should CodeMie reach a model?',
      text: relogin ? 'Your previous sign-in expired. This renews it in your browser.'
        : cm.org ? `Your IT team set up ${e(cm.org.organizationName || 'a')} CodeMie for this Mac. You can add other profiles later.` : 'Most people sign in to CodeMie with their work account. You can add other profiles later.',
      body,
      left: busy ? button('Cancel', { action: 'cm-signin-cancel', variant: 'ghost' }) : sh.mode === 'setup' && !cm.profiles.length ? button('Back', { action: 'cm-sheet-go', variant: 'ghost', attrs: { 'data-step': 'welcome' } }) : '',
      note: busy ? '' : relogin ? 'Runs codemie profile login' : 'Runs codemie setup — Connect answers its questions',
      right: busy ? '' : button(d.error ? 'Try again' : browser ? 'Sign in with browser' : 'Check and continue', { action: 'cm-signin-start', variant: 'primary', iconName: browser ? 'external' : undefined }),
    };
  },

  project: (sh, cm) => {
    const d = sh.d;
    const pending = sh.pending;
    const [label, title, text] = PICK[pending?.id] || PICK.model;
    let body;
    if (!pending) {
      body = `<div class="cm-waiting">${spinner('Working')}<strong>${sh.mode === 'edit' ? 'Asking CodeMie for your projects and models…' : 'Saving your profile…'}</strong><p>CodeMie is finishing the setup. This takes a few seconds.</p></div>`;
    } else {
      const selected = Number.isInteger(d.pick) ? d.pick : pending.recommended ?? 0;
      const choices = pending.options.map((o, i) => `<div class="cm-choice-wrap"><label class="cm-choice"><input type="radio" name="cm-pick" value="${i}" data-action="cm-pick" ${i === selected ? 'checked' : ''}><span class="cm-choice-mark"></span><span class="cm-choice-copy"><strong>${e(cleanOption(o))}${i === pending.recommended ? ` ${badge('Recommended', 'purple')}` : ''}</strong></span></label></div>`).join('');
      const isModel = pending.id === 'model';
      const more = isModel && sh.mode !== 'edit' ? `<p style="margin-top:16px"><button type="button" class="cm-link" data-action="cm-draft-toggle" data-key="more">${d.more ? 'Hide options' : `More options — name “${e(d.name)}”${sh.mode === 'add' ? ', active' : ''}`}</button></p>
        ${d.more ? `<div class="cm-form-grid cm-form-grid-2" style="margin-top:12px">${field('Profile name', textInput({ value: d.name, 'data-draft': 'name', spellcheck: 'false', autocomplete: 'off', maxlength: 64 }), 'Letters, numbers, dots and dashes.')}</div>
        ${sh.mode === 'add' ? `<div style="margin-top:12px">${toggle({ action: 'cm-draft-check', checked: d.makeActive, label: 'Make it the active profile', attrs: { 'data-key': 'makeActive' } })}</div>` : ''}` : ''}` : '';
      body = `${problemBox(d.error)}<p class="ws-field-label" style="margin-bottom:8px">${e(label)}</p><div class="cm-choices${pending.options.length > 4 && !isModel ? ' cm-choices-2' : ''}">${choices}</div>${more}`;
    }
    const last = pending?.id === 'model';
    return {
      eyebrow: sh.mode === 'add' ? 'New profile · step 2 of 2' : sh.mode === 'edit' ? `Profile ${sh.profile}` : 'Step 2 of 4',
      title: pending ? title : 'One moment',
      text: pending ? e(text) : '',
      body,
      left: pending ? button('Cancel', { action: 'cm-signin-cancel', variant: 'ghost' }) : '',
      note: last && sh.mode !== 'edit' ? `Saves profile “${d.name}” to ~/.codemie` : '',
      right: pending ? button(last ? 'Save and continue' : 'Continue', { action: 'cm-pick-continue', variant: 'primary', iconRight: 'arrow' }) : '',
    };
  },

  agents: (sh, cm) => {
    const d = sh.d;
    const run = d.install;
    const provider = activeProfile(cm)?.provider;
    let body;
    if (run) {
      const total = run.tasks.length;
      const finished = run.tasks.filter((t) => t.state === 'done' || t.state === 'failed').length;
      body = `<div class="cm-tasks">${run.tasks.map((t) => `<div class="cm-task" data-state="${t.state}">${t.state === 'running' ? spinner('Installing') : icon(t.state === 'done' ? 'check-circle' : t.state === 'failed' ? 'alert' : 'clock')}<span>${e(t.label)}${t.detail ? ` <small>· ${e(t.detail)}</small>` : ''}</span></div>`).join('')}</div>
        <div class="cm-progress" style="margin-top:12px"><span style="width:${run.state === 'running' ? Math.max(6, (finished / total) * 100) : 100}%"></span></div>
        ${run.failed ? `<div class="cm-problem" style="margin-top:14px"><strong>${icon('alert')}${e(run.failed.title)}</strong><p>${e(run.failed.text)}</p>${logBlock(run.failed.cmd || 'codemie install', run.failed.output, { always: true })}</div>` : ''}`;
    } else {
      const rows = (cm.agents || []).filter((a) => a.command !== BUILTIN_AGENT);
      const visible = rows.filter((a) => { const i = agentDisplay(a); return a.installed || (d.showAll ? true : i.featured && !i.editor); });
      const hidden = rows.length - visible.length;
      body = cm.agents === undefined ? `<span class="cm-status">${spinner('Loading')}<span>Reading the coding agents CodeMie offers…</span></span>`
        : `<div class="cm-choices">${visible.map((a) => {
          const i = agentDisplay(a);
          const fits = !provider || !i.providers || i.providers.includes(provider);
          return `<label class="cm-choice"><input type="checkbox" value="${e(a.command)}" data-action="cm-agent-pick" ${a.installed || d.agents.includes(a.command) ? 'checked' : ''} ${a.installed || !fits ? 'disabled' : ''}><span class="cm-choice-mark cm-choice-check">${icon('check')}</span><span class="cm-agent-logo" style="background:${e(i.color)};width:32px;height:32px">${e(i.mono)}</span><span class="cm-choice-copy"><strong>${e(i.name)}${i.recommended && fits ? ` ${badge('Recommended', 'purple')}` : ''}${a.installed ? ` ${badge(`Installed${a.version ? ` ${a.version}` : ''}`, 'success')}` : ''}</strong><span>${fits ? e(i.short || i.desc) : `Doesn’t work with ${e(providerShort(provider))} profiles.`}</span></span><span class="cm-choice-side">${e(i.maker)}</span></label>`;
        }).join('')}</div>
        ${hidden > 0 ? `<p style="margin-top:10px"><button type="button" class="cm-link" data-action="cm-draft-toggle" data-key="showAll">Show ${hidden} more, including agents for code editors</button></p>` : ''}`;
    }
    const n = d.agents.filter((c) => !(cm.agents || []).some((a) => a.command === c && a.installed)).length;
    const agentDone = installed(cm).length > 0;
    const right = run?.state === 'running' ? button('Installing…', { variant: 'primary', disabled: true })
      : run?.state === 'partial' ? `${button('Try again', { action: 'cm-setup-install', iconName: 'refresh' })}${button(agentDone ? 'Continue' : 'Continue without', { action: 'cm-sheet-next', variant: 'primary', iconRight: 'arrow' })}`
        : run?.state === 'done' ? button('Continue', { action: 'cm-sheet-next', variant: 'primary', iconRight: 'arrow' })
          : n ? button(`Install ${plural(n, 'agent')}`, { action: 'cm-setup-install', variant: 'primary', iconName: 'download' })
            : button(agentDone ? 'Continue' : 'Skip for now', { action: 'cm-sheet-next', variant: agentDone ? 'primary' : 'secondary', iconRight: 'arrow' });
    return {
      eyebrow: 'Step 3 of 4',
      title: run ? (run.state === 'running' ? 'Installing your coding agents' : run.state === 'done' ? 'Your agents are ready' : 'Almost — an agent did not install') : 'Which coding agents do you want?',
      text: run ? 'Installs for your account only. No administrator password.' : 'Claude Code is a good start. You can add or remove agents any time in Settings → CodeMie.',
      body,
      left: run?.state === 'running' ? '' : '',
      note: !run && n ? `Runs codemie install ${d.agents[0]}${n > 1 ? ` + ${n - 1} more` : ''}` : '',
      right,
    };
  },

  apps: (sh, cm) => {
    const d = sh.d;
    const run = d.appsRun;
    let body;
    if (run) {
      body = `<div class="cm-tasks">${run.tasks.map((t) => `<div class="cm-task" data-state="${t.state}">${t.state === 'running' ? spinner('Working') : icon(t.state === 'done' ? 'check-circle' : t.state === 'failed' ? 'alert' : 'clock')}<span>${e(t.label)}</span></div>`).join('')}</div>
        ${run.failed ? `<div class="cm-problem" style="margin-top:14px"><strong>${icon('alert')}${e(run.failed.title)}</strong><p>${e(run.failed.text)}</p>${logBlock(run.failed.cmd || 'codemie proxy connect', run.failed.output, { always: true })}</div>` : ''}`;
    } else {
      body = `<div class="cm-choices">${APPS.map((a) => {
        const st = appState(cm, a.id);
        const on = st === 'connected' || !!d.apps[a.id];
        const side = st === 'connected' ? badge('Connected', 'success') : st === 'not_installed' ? badge('Not on this Mac', 'neutral') : '';
        return `<label class="cm-choice"><input type="checkbox" data-action="cm-app-pick" data-id="${e(a.id)}" ${on ? 'checked' : ''} ${st === 'connected' || st === 'not_installed' ? 'disabled' : ''}><span class="cm-choice-mark cm-choice-check">${icon('check')}</span><span class="cm-app-icon" style="width:32px;height:32px">${icon(a.icon)}</span><span class="cm-choice-copy"><strong>${e(a.name)} ${side}</strong><span>${e(st === 'not_installed' ? 'Install it first — you can connect it later from Settings.' : a.text)}</span></span></label>`;
      }).join('')}</div>
      <p class="ws-muted ws-hint" style="margin-top:12px">They all use one small CodeMie gateway on this Mac with your active profile.</p>`;
    }
    const picked = APPS.filter((a) => d.apps[a.id] && appState(cm, a.id) === 'not_set');
    const right = run?.state === 'running' ? button('Connecting…', { variant: 'primary', disabled: true })
      : run?.state === 'done' || run?.state === 'failed' ? button('Continue', { action: 'cm-sheet-next', variant: 'primary', iconRight: 'arrow' })
        : picked.length ? button(picked.length === 1 ? `Connect ${picked[0].name.split(' — ')[0]}` : `Connect ${picked.length} apps`, { action: 'cm-setup-apps', variant: 'primary', iconName: 'plug' })
          : button('Continue', { action: 'cm-apps-skip', variant: 'primary', iconRight: 'arrow' });
    return {
      eyebrow: 'Step 4 of 4 · optional', title: 'Use CodeMie in the apps you already have',
      text: 'Apps found on this Mac are listed. Restart an app after connecting it to see CodeMie models.',
      body,
      left: run?.state === 'running' ? '' : `${button('Back', { action: 'cm-sheet-go', variant: 'ghost', attrs: { 'data-step': 'agents' } })}${!run && picked.length ? button('Skip', { action: 'cm-apps-skip', variant: 'ghost' }) : ''}`,
      note: picked.length && !run ? `Runs codemie proxy connect ${picked.map((a) => a.connectFlag).join(' ')}` : '',
      right,
    };
  },

  done: (sh, cm) => {
    if (sh.mode !== 'setup') {
      const p = cm.profiles.find((x) => x.name === sh.saved) || activeProfile(cm);
      const active = p && p.name === cm.config.active;
      return {
        eyebrow: sh.mode === 'edit' ? `Profile ${p?.name || ''}` : 'New profile',
        title: sh.mode === 'edit' ? `Saved “${p?.name || ''}”` : `Profile “${p?.name || ''}” is ready`,
        text: sh.mode === 'edit' ? 'Agents use the new project and model the next time they start.' : active ? 'It is now the active profile.' : 'Make it active to use it for coding agents.',
        body: `<div class="cm-done"><span class="cm-done-mark">${icon('check')}</span><div class="cm-summary">
          <div class="cm-summary-row">${icon('user')}<span>Provider</span><strong>${e(providerShort(p?.provider))}</strong></div>
          <div class="cm-summary-row">${icon('building')}<span>Project</span><strong>${e(p?.codemieProject || '—')}</strong></div>
          <div class="cm-summary-row">${icon('cpu')}<span>Model</span><strong>${e(p?.model || '—')}</strong></div>
          ${sh.mode === 'add' && p ? `<div class="cm-summary-row">${icon('swap')}<span>Active profile</span><strong>${e(cm.config.active || '—')}</strong>${!active ? button(`Make “${p.name}” active`, { action: 'cm-profile-activate', size: 'sm', attrs: { 'data-id': p.name } }) : badge('Active', 'purple')}</div>` : ''}
        </div></div>`,
        right: button('Done', { action: 'cm-sheet-close', variant: 'primary' }),
      };
    }
    const p = activeProfile(cm);
    const inst = installed(cm);
    const first = inst[0];
    const launcher = first ? agentDisplay(first).launcher : '';
    return {
      eyebrow: 'All set', title: 'CodeMie is ready',
      text: 'Everything below is saved. Change any of it in Settings → CodeMie.',
      body: `<div class="cm-done">
        <span class="cm-done-mark">${icon('check')}</span>
        <div class="cm-summary">
          <div class="cm-summary-row">${icon('user')}<span>Signed in</span><strong>${e(cm.config.account || p?.name || '—')}</strong></div>
          <div class="cm-summary-row">${icon('building')}<span>Project · model</span><strong>${e(p ? [p.codemieProject, p.model].filter(Boolean).join(' · ') || '—' : '—')}</strong></div>
          <div class="cm-summary-row">${icon('terminal')}<span>Coding agents</span><strong>${e(inst.map((a) => agentDisplay(a).name).join(', ') || 'None yet — add one any time')}</strong></div>
          <div class="cm-summary-row">${icon('plug')}<span>Apps</span><strong>${e(connected(cm).map((a) => a.name).join(', ') || 'None — connect any time')}</strong></div>
        </div>
        ${first && cm.config.active ? `<div class="cm-how"><strong>Start coding with ${e(agentDisplay(first).name)}</strong><p>Coding agents run in Terminal, inside your project folder. Connect can open it for you — or type the command yourself.</p><div class="cm-how-cmd">${icon('terminal')}<code>${e(launcher)}</code>${button('Copy', { action: 'cm-copy', size: 'sm', variant: 'ghost', iconName: 'copy', attrs: { 'data-copy': launcher } })}</div><div class="ws-actions">${button('Open in Terminal…', { action: 'cm-open-terminal', variant: 'primary', iconName: 'terminal', attrs: { 'data-id': first.command } })}</div></div>` : ''}
      </div>`,
      left: button('Open CodeMie settings', { action: 'cm-sheet-settings', variant: 'ghost', iconName: 'settings' }),
      right: button('Done', { action: 'cm-sheet-close', variant: 'primary' }),
    };
  },
};
