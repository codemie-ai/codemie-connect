// Browser checks of Ask and quick capture (spec docs/superpowers/specs/2026-11-26-ask-capture-design.md
// § 2, § 5–§ 12, § Copy, § Accessibility), run by workspace-e2e.mjs with its MOCKED native bridge.
// Run alone with `WORKSPACE_E2E_ONLY=ask`. Q1–Q11 below: the Ask page of a done thread across both
// themes, both views and three widths (history column or "History ▾"), the menu's field with its
// About chip and Recent, ⌘K on every page and where it does nothing (the terminal dock, a dialog,
// the setup sheet), a question answered by the `ask` job and a follow-up, every state from
// ask-states.json (Stop and ⌘., Ask again, Try again, the chooser on `needs_choice`, Microsoft not
// connected), the actions, history with Delete and Clear history, quick capture with every
// when-cases.json text, × and the source fields, ⌘↩, Note and Undo, Settings, Default/Compact
// parity, and nothing sent or kept by rendering. layout-checks.mjs E10–E13, tasks-provider P13
// and plugins-checks.mjs keep their own angles (the field's place and the rail, Back's focus, the
// By-date fold, the bar's live region and Tab order, the bar over plugin frames).
// `open({ ask: '<state>' })` takes an ask-states.json state and makes the mock's `ask_start` and
// Stop write the turn as native does; `window.__askThreads[id]` is what `ask_read` answers, and
// `window.__askJob = {threadId, turn}` settles that thread's running turn as the job would.
import { readFileSync } from 'node:fs';
import { noClip, FIXED_NOW } from './compact-checks.mjs';
import { askStates, askThread } from '../fixtures/workspace-fixture.mjs';
import { dueLabel } from '../../workspace/capture-model.js';
import { NAV } from '../../workspace/shell.js';

const WHEN_CASES = JSON.parse(readFileSync(new URL('../fixtures/contract/when-cases.json', import.meta.url), 'utf8'));
const PRIVACY = 'Answers use what Connect has on this Mac: your tasks, calendar, mail and Teams previews, meeting notes, and facts from Knowledge when your voice is on. Only what fits each question goes to the AI profile Ask uses (Settings › AI). Ask never sends or changes anything; you choose each action.';
const NOT_CONNECTED = 'Microsoft 365 isn’t connected, so this answer leaves out your mail, Teams and calendar.';
const BUSY = 'Connect is still answering. Stop it or wait.';
const SENTINEL = 'ASK_SENTINEL_5c1e';
/** Tue 25 Nov 2025, 12:00 in Kyiv: the seeded mail from Priya lands on "Tue 25 Nov" (spec § 7). */
const TUE_25_NOV = Date.parse('2025-11-25T12:00:00+02:00');
/** The seeded records ask-thread.json's done turn points at here. */
const SEEDED = { a1: 'm-reply-1', t2: 'commit-1', e3: 'ev-standup', m4: 'c-reply-1', n5: 'ev-standup' };
/** Ops that write or send something: none may come from drawing a page. */
const WRITES = ['ask_start', 'ask_delete', 'task_save', 'note_append', 'ai_draft'];

const text = (page, selector) => page.locator(selector).first().innerText();
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const viewSettings = view => (view === 'compact' ? { view: 'compact' } : null);
const hashOf = page => new URL(page.url()).hash;
/** reply-checks.mjs's `noOverflow` pattern. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.getElementById('workspace-main').scrollWidth - document.getElementById('workspace-main').clientWidth));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};
const count = async (page, op) => (await page.evaluate(o => window.__bridgeCalls.filter(([x]) => x === o).length, op));
const waitCount = (page, op, n) => page.waitForFunction(([o, n]) => window.__bridgeCalls.filter(([x]) => x === o).length === n, [op, n]);

/** ask-thread.json's done turn with its cites, About and actions on seeded records, and a done
 *  follow-up: the two turns of ask-states.json's `idle` thread "ask-7f2c". */
function doneThread() {
  const t = structuredClone(askThread());
  const first = t.turns[0];
  for (const c of first.cites) if (SEEDED[c.id]) c.recordId = SEEDED[c.id];
  first.about.recordId = 'm-reply-1';
  first.actions[1].recordId = 'ev-standup';
  first.actions[2].recordId = 'c-reply-1';
  const second = {
    ...structuredClone(first), id: 'turn-2', at: first.at + 60, jobId: 'job-2', question: 'And Jordan Lee?', about: null,
    answer: 'Jordan Lee asked for the QBR deck by Thursday [m8].',
    cites: [{ id: 'm8', kind: 'message', label: 'Jordan Lee · Teams · Wed 18 Nov', recordId: 'c-reply-1', title: null }],
    actions: [], searched: 'tasks 3 (Todoist) · messages 4', cut: false, took: 6,
  };
  t.turns = [first, second];
  t.nextRef = 9;
  return t;
}

/** The done thread whose newest turn is `turn` (merged over its follow-up). */
function threadEndingWith(turn) {
  const t = doneThread();
  t.turns[1] = { ...t.turns[1], answer: null, cites: [], actions: [], searched: null, took: null, ...turn };
  return t;
}

/** What `ask_read` answers for `thread.id` from now on, then the page on it (the route's own
 *  path: app.js's `route`), waiting for its newest turn. */
async function showThread(page, thread) {
  await page.evaluate(t => { window.__askThreads = { ...(window.__askThreads || {}), [t.id]: t }; }, thread);
  await page.evaluate(id => window.__workspace.route('ask', id), thread.id);
  await page.waitForSelector(`article[data-ask-turn="${thread.turns.at(-1).id}"]`);
}

/** The job settles `threadId`'s running turn (workspace-e2e.mjs `__askJob`). */
const finishJob = (page, threadId, turn) => page.evaluate(v => { window.__askJob = v; }, { threadId, turn });

/** The answer the job writes for a fresh question: the done turn's cites and actions. */
function jobAnswer() {
  const { answer, cites, actions, searched, cut, model } = doneThread().turns[0];
  return { state: 'done', answer, cites, actions, searched, cut, model, took: 9 };
}

const RUNNING_JOB = { id: 'job-9', kind: 'ask', key: 'ask:ask-7f2c', state: 'running', dueAt: 1795000401, attempts: 1, connectionId: null, workspaceId: 'personal', policy: {}, payload: { threadId: 'ask-7f2c', turnId: 'turn-2', purpose: 'ask', profile: 'claude', model: null, runModel: 'claude-sonnet-4-5', startedAt: 1795000401 }, result: null };

/** Priya's seeded mail from "Priya N." (spec § 2's chip). */
const priyaN = s => { s.records.find(r => r.id === 'm-reply-1').data.from = 'Priya N.'; };

export async function askChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- Q1: the page, both themes, both views, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context, errors } = await open({ theme, width, height: 900, now: FIXED_NOW, ask: 'idle', voice: 'ready', settings: viewSettings(view) });
        await check(`ask Q1: ${theme} ${view} ${width}`, async () => {
          await showThread(page, doneThread());
          await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
          await settled(page);
          const seen = await page.evaluate(() => {
            const t1 = '[data-ask-turn="turn-1"]';
            const all = sel => [...document.querySelectorAll(sel)];
            return {
              turns: all('article.ws-ask-turn').map(a => a.querySelector('.ws-ask-q').textContent),
              marks: all(`${t1} .ws-ask-mark`).length,
              markButtons: all(`${t1} button.ws-ask-mark`).length,
              chips: all(`${t1} .ws-ask-cites li`).length,
              chipButtons: all(`${t1} button.ws-ask-cite[data-action="ask-cite"]`).length,
              actions: all(`${t1} .ws-ask-actions button`).map(b => b.dataset.action),
              meta: document.querySelector(`${t1} .ws-ask-meta summary`)?.textContent.trim(),
              box: document.getElementById('ask-follow-up')?.placeholder,
              privacy: document.querySelector('.ws-ask-privacy')?.textContent,
              column: !!document.querySelector('.ws-ask-cols .ws-ask-history')?.getClientRects().length,
              menu: document.querySelector('.ws-ask-hmenu summary')?.textContent.trim() || null,
              main: document.getElementById('workspace-main').clientWidth,
              answerWidth: Math.round(document.querySelector('.ws-ask-main')?.getBoundingClientRect().width || 0),
            };
          });
          assert(seen.turns.join('|') === 'What did I promise Priya this week?|And Jordan Lee?', `turns: ${seen.turns.join('|')}`);
          assert(seen.marks === 7 && seen.markButtons === 5, `cite marks: ${seen.marks} (${seen.markButtons} buttons)`);
          assert(seen.chips === 7 && seen.chipButtons === 5, `cite chips: ${seen.chips} (${seen.chipButtons} buttons)`);
          assert(seen.actions.join(',') === 'ask-task,ask-go,ask-reply', `actions: ${seen.actions}`);
          assert(/^Claude Code · 14 s · from 12 tasks, 7 events, 9 messages, 2 meetings, 1 person, 1 fact · Shortened to fit\./.test(seen.meta || ''), `meta: ${seen.meta}`);
          assert(seen.box === 'Ask a follow-up…', `box: ${seen.box}`);
          assert(seen.privacy === PRIVACY, `privacy: ${seen.privacy}`);
          // § 7, § 12: the history column only in Default at a main area of 1,100 px or more.
          const wide = view === 'default' && seen.main >= 1100;
          assert(seen.column === wide && (wide ? seen.menu === null : seen.menu === 'History ▾'), `history at main ${seen.main}: column ${seen.column}, menu ${seen.menu}`);
          assert(seen.answerWidth <= 760, `answer column ${seen.answerWidth}px`);
          await noOverflow(page, assert, `${theme} ${view} ${width}`);
          const clipped = await noClip(page);
          assert(clipped.length === 0, `clipped: ${clipped.join(' | ')}`);
          await shot(page, `ask-${theme}-${view}-${width}`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- Q2: the field, its About chip and Recent

  for (const [view, theme] of [['default', 'light'], ['compact', 'dark']]) {
    // 2025, not 2026: 25 Nov 2026 is a Wednesday, and the chip's date shows no year.
    const { page, context, errors } = await open({ theme, width: 1440, height: 900, now: TUE_25_NOV, hash: '#/inbox', ask: 'idle', patch: priyaN, settings: viewSettings(view) });
    await check(`ask Q2 (${view} ${theme}): the field first in the menu with ⌘K, the About chip follows the selection, none on Today, Recent opens a thread`, async () => {
      const place = await page.evaluate(() => {
        const field = document.querySelector('.ws-ask-field').getBoundingClientRect();
        const first = document.querySelector('.ws-sidebar .ws-nav button').getBoundingClientRect();
        return { first: field.bottom <= first.top, hint: document.querySelector('.ws-ask-hint')?.textContent, placeholder: document.getElementById('ask-input').placeholder };
      });
      assert(place.first && place.hint === '⌘K' && place.placeholder === 'Ask…', `the field: ${JSON.stringify(place)}`);
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await settled(page);
      await page.keyboard.press('Meta+KeyK');
      await page.waitForSelector('.ws-ask-chip');
      assert(squash(await text(page, '.ws-ask-chip span')) === 'About: Priya N. · mail · Tue 25 Nov', `chip: ${await text(page, '.ws-ask-chip span')}`);
      assert(await page.getAttribute('[data-action="ask-about-drop"]', 'aria-label') === 'Don’t ask about Priya N. · mail · Tue 25 Nov', 'the × label');
      await page.keyboard.type('what did I promise?');
      // Jordan's chat chosen while the question waits: the chip moves; the words stay.
      await page.click('.ws-inbox-row[data-id="c-reply-1"]');
      await page.waitForSelector('.ws-ask-chip span:has-text("About: Jordan Lee · Teams · Tue 25 Nov")');
      assert(await page.inputValue('#ask-input') === 'what did I promise?', 'the words went');
      await shot(page, `ask-field-${view}-${theme}-chip`);
      // Today: no chip, Recent with the seeded questions; ↑ Enter opens the oldest one's thread.
      await page.click('#ask-input');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__workspace.route('today'));
      await page.evaluate(t => { window.__askThreads = { 'ask-51bd': t }; }, { ...doneThread(), id: 'ask-51bd', turns: [{ ...doneThread().turns[1], id: 'turn-1', question: 'Who is Marek Novak?' }] });
      await page.keyboard.press('Meta+KeyK');
      await page.waitForSelector('.ws-ask-recent li');
      assert(await page.locator('.ws-ask-chip').count() === 0, 'a chip on Today');
      const recent = await page.locator('.ws-ask-recent li').allInnerTexts();
      assert(recent.join('|') === 'What did I promise Priya this week?|When is the QBR?|Who is Marek Novak?', `Recent: ${recent.join('|')}`);
      await shot(page, `ask-field-${view}-${theme}-recent`);
      await page.keyboard.press('ArrowUp');
      await page.waitForSelector('#ask-recent-2[aria-selected=true]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-q:text-is("Who is Marek Novak?")');
      assert(hashOf(page) === '#/ask/ask-51bd', hashOf(page));
      assert(await count(page, 'ask_start') === 0, 'opening a Recent thread asked');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q3: ⌘K everywhere, and where it does nothing

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, ask: 'idle' });
    await check('ask Q3: ⌘K focuses the field on every page; the rail opens #/ask; nothing in the terminal dock, under a dialog or the setup sheet', async () => {
      const pages = [...NAV.map(([id]) => [id]), ['settings', 'layout'], ['ask', null]];
      for (const [id, tab] of pages) {
        await page.evaluate(([id, tab]) => window.__workspace.route(id, tab), [id, tab]);
        await settled(page);
        await page.keyboard.press('Meta+KeyK');
        await page.waitForFunction(() => document.activeElement?.id === 'ask-input', null, { timeout: 2000 }).catch(() => {});
        assert(await page.evaluate(() => document.activeElement?.id) === 'ask-input', `⌘K on ${id}: focus on ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)}`);
        await page.keyboard.press('Escape');
      }
      // The menu as a rail: ⌘K opens the Ask page with its box focused.
      await page.evaluate(() => window.__workspace.route('today'));
      await page.keyboard.press('Meta+Backslash');
      await page.waitForSelector('.ws-sidebar.ws-sidebar-rail');
      await page.keyboard.press('Meta+KeyK');
      await page.waitForFunction(() => document.activeElement?.id === 'ask-follow-up');
      assert(hashOf(page) === '#/ask', `rail: ${hashOf(page)}`);
      await page.keyboard.press('Meta+Backslash');
      await page.waitForSelector('.ws-sidebar:not(.ws-sidebar-rail)');
      await page.evaluate(() => window.__workspace.route('today'));
      await settled(page);
      const still = async (what, focusIn) => {
        const before = { hash: hashOf(page), focus: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) };
        await page.keyboard.press('Meta+KeyK');
        await page.waitForTimeout(250);
        const after = { hash: hashOf(page), focus: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)), inside: await page.evaluate(sel => !!document.activeElement?.closest(sel), focusIn) };
        assert(after.hash === before.hash && after.focus === before.focus && after.inside, `⌘K ${what}: ${JSON.stringify({ before, after })}`);
      };
      // The terminal dock keeps its own ⌘K (it clears the terminal there).
      await page.evaluate(() => { const t = document.querySelector('.ws-term'); t.hidden = false; t.querySelector('.ws-term-grip').focus(); });
      await still('in the terminal dock', '.ws-term');
      await page.evaluate(() => { document.querySelector('.ws-term').hidden = true; });
      // A dialog open: the first-use chooser.
      await page.evaluate(() => { window.__workspace.ensureClaudeChoice(); });
      await page.waitForSelector('.ws-modal[open] [data-action="ai-choose"]');
      await page.waitForTimeout(250);
      await still('under a dialog', '.ws-modal[open]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      // The setup sheet open.
      await page.evaluate(() => window.__workspace.codemie.handle('cm-setup-open', { dataset: {} }));
      await page.waitForSelector('#cm-sheet-host .cm-sheet-panel');
      await page.waitForTimeout(300);
      await still('with the setup sheet open', '#cm-sheet-host');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#cm-sheet-host .cm-sheet', { state: 'detached' });
      assert(await count(page, 'ask_start') === 0, 'a key asked');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
  // With "Ask in the menu" off, ⌘K opens the Ask page.
  {
    const off = s => { s.settings.askInMenu = false; s.ask.inMenu = false; };
    const { page, context, errors } = await open({ theme: 'light', width: 1440, height: 900, hash: '#/calendar', ask: 'idle', patch: off });
    await check('ask Q3: with the field off the menu, ⌘K opens #/ask with its box focused', async () => {
      assert(await page.locator('.ws-ask-field').count() === 0, 'the field is drawn');
      await page.keyboard.press('Meta+KeyK');
      await page.waitForFunction(() => document.activeElement?.id === 'ask-follow-up');
      assert(hashOf(page) === '#/ask', hashOf(page));
      assert(squash(await text(page, '.ws-ask-back')) === '← Back to Calendar', 'Back names Calendar');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q4: a question, the job's answer, a follow-up

  for (const theme of ['dark', 'light']) {
    const { page, context, errors } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, hash: '#/inbox', ask: 'idle' });
    await check(`ask Q4 (${theme}): Enter sends one ask_start and opens the thread answering; the job answers with cites and actions; a follow-up sends one more`, async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await settled(page);
      await page.keyboard.press('Meta+KeyK');
      await page.keyboard.type('What did I promise Priya?');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^#\/ask\/ask-/.test(location.hash));
      const threadId = decodeURIComponent(hashOf(page).slice('#/ask/'.length));
      const starts = await calls(page, 'ask_start');
      assert(starts.length === 1, `${starts.length} ask_start`);
      assert(starts[0].question === 'What did I promise Priya?' && starts[0].about?.kind === 'message' && starts[0].about.recordId === 'm-reply-1' && !('threadId' in starts[0]), JSON.stringify(starts[0]));
      await page.waitForSelector('[data-ask-run]');
      const answering = squash(await text(page, '[data-ask-tick]'));
      assert(/^Answering with Claude Code · \d+ s$/.test(answering), `answering: ${answering}`);
      assert(await page.getAttribute('#ask-input', 'placeholder') === 'Answering… ⌘. to stop', 'the field does not say Answering');
      assert(await page.locator('#ask-follow-up').isDisabled() && squash(await text(page, '#ask-box-why')) === BUSY, 'the box asks while answering');
      await shot(page, `ask-answering-${theme}`);
      await finishJob(page, threadId, jobAnswer());
      await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
      await page.waitForFunction(() => document.getElementById('ws-live')?.textContent === 'Answer ready');
      const chips = await page.locator('[data-ask-turn="turn-1"] button.ws-ask-cite').count();
      const actions = await page.locator('[data-ask-turn="turn-1"] .ws-ask-actions button').count();
      assert(chips === 5 && actions === 3, `chips ${chips}, actions ${actions}`);
      assert(squash(await text(page, '[data-ask-turn="turn-1"] .ws-ask-about')) === 'About: Priya Natarajan · mail · Wed 18 Nov', 'the turn lost its About');
      await shot(page, `ask-answered-${theme}`);
      // A follow-up: one ask_start {threadId, question}, no About.
      await page.fill('#ask-follow-up', 'And Jordan Lee?');
      await page.keyboard.press('Enter');
      await waitCount(page, 'ask_start', 2);
      const follow = (await calls(page, 'ask_start')).at(-1);
      assert(follow.threadId === threadId && follow.question === 'And Jordan Lee?' && !('about' in follow), JSON.stringify(follow));
      await page.waitForSelector('[data-ask-turn="turn-2"] [data-ask-run]');
      assert(await page.inputValue('#ask-follow-up') === '', 'the box kept the follow-up');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q5: every state

  for (const theme of ['dark', 'light']) {
    // Answering: Stop and ⌘. each send one job_cancel {id}.
    {
      const withJob = s => { s.jobs.push(structuredClone(RUNNING_JOB)); };
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, ask: 'running', patch: withJob });
      await check(`ask Q5 (${theme}): running — Stop and ⌘. each send one job_cancel; the turn reads Stopped.`, async () => {
        const running = threadEndingWith({ state: 'running', jobId: 'job-9' });
        await showThread(page, running);
        await page.waitForSelector('.ws-ask-stop[aria-keyshortcuts="Meta+Period"]');
        assert(/^Answering with Claude Code · \d+ s$/.test(squash(await text(page, '[data-ask-tick]'))), 'no Answering line');
        await shot(page, `ask-states-${theme}-running`);
        await page.click('.ws-ask-stop');
        await waitCount(page, 'job_cancel', 1);
        await page.waitForSelector('[data-ask-turn="turn-2"] .ws-ask-stopped:text-is("Stopped.")');
        // Running again (native had settled it): ⌘. stops it.
        await page.evaluate(({ thread, ask, job }) => {
          window.__askThreads[thread.id] = thread;
          window.__askSet(ask, [job]);
        }, { thread: running, ask: askStates().running, job: RUNNING_JOB });
        await page.waitForSelector('.ws-ask-stop');
        await page.keyboard.press('Meta+Period');
        await waitCount(page, 'job_cancel', 2);
        const cancels = await calls(page, 'job_cancel');
        assert(cancels.every(c => c.id === 'job-9' && Object.keys(c).join() === 'id'), JSON.stringify(cancels));
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
    // Stopped: Ask again sends one ask_start; then `needs_choice` opens the chooser and choosing (its "Choose" button; the spec mockup says "Use it") asks again.
    {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, ask: 'stoppedLast' });
      await check(`ask Q5 (${theme}): stoppedLast — Ask again sends one ask_start; needs_choice opens the chooser and choosing asks again`, async () => {
        await showThread(page, threadEndingWith({ state: 'stopped' }));
        assert(squash(await text(page, '[data-ask-turn="turn-2"] .ws-ask-acts')) === 'Stopped. Ask again', 'Stopped. Ask again');
        await page.click('[data-ask-turn="turn-2"] [data-action="ask-again"]');
        await waitCount(page, 'ask_start', 1);
        const again = (await calls(page, 'ask_start'))[0];
        assert(again.threadId === 'ask-7f2c' && again.question === 'And Jordan Lee?', JSON.stringify(again));
        await page.waitForSelector('[data-ask-turn="turn-3"] [data-ask-run]');
        // No profile chosen: the existing first-use chooser, then the same question again.
        await showThread(page, threadEndingWith({ state: 'stopped' }));
        await page.evaluate(s => window.__askSet(s), askStates().stoppedLast);
        await page.waitForSelector('[data-ask-turn="turn-2"] [data-action="ask-again"]');
        await page.evaluate(() => { window.__askRefuse = { op: 'ask_start', code: 'needs_choice', message: 'Choose which AI writes for you.' }; });
        await page.click('[data-ask-turn="turn-2"] [data-action="ask-again"]');
        await page.waitForSelector('.ws-modal[open] [data-action="ai-choose"]');
        assert(squash(await text(page, '.ws-modal[open] .ws-modal-header h2')) === 'Choose which AI writes for you', 'chooser title');
        await page.waitForTimeout(250);
        await shot(page, `ask-states-${theme}-chooser`);
        await page.click('.ws-modal[open] [data-action="ai-choose"][data-profile="claude"]');
        await page.click('.ws-modal[open] .ws-modal-footer button[type=submit]');
        await waitCount(page, 'ask_start', 3);
        await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
        assert((await calls(page, 'ai_settings_save')).length === 1, 'the choice was not saved once');
        const retried = (await calls(page, 'ask_start')).slice(1);
        assert(retried.every(d => d.threadId === 'ask-7f2c' && d.question === 'And Jordan Lee?'), JSON.stringify(retried));
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
    // Failed: Try again sends one ask_start; a profile problem offers "Check Settings › AI".
    {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, ask: 'failedLast' });
      await check(`ask Q5 (${theme}): failedLast — "Couldn’t answer", Try again sends one ask_start, Check Settings › AI for needs_login`, async () => {
        const failed = askThread().turns[1];
        await showThread(page, threadEndingWith({ state: 'failed', error: failed.error, profile: failed.profile, fellBackFrom: failed.fellBackFrom, fallbackReason: failed.fallbackReason }));
        assert(squash(await text(page, '[data-ask-turn="turn-2"] .ws-ask-failed')) === '✕ Couldn’t answer: CodeMie is not signed in.', 'the failed line');
        assert(squash(await text(page, '[data-ask-turn="turn-2"] .ws-ask-fallback')) === 'Ran on CodeMie · prod because Claude Code wasn’t signed in.', 'the fallback line');
        assert(await page.locator('[data-ask-turn="turn-2"] [data-action="ask-settings"]:text-is("Check Settings › AI")').count() === 1, 'no Check Settings › AI');
        await shot(page, `ask-states-${theme}`);
        await page.click('[data-ask-turn="turn-2"] [data-action="ask-retry"]');
        await waitCount(page, 'ask_start', 1);
        assert(JSON.stringify((await calls(page, 'ask_start')).map(d => [d.threadId, d.question])) === '[["ask-7f2c","And Jordan Lee?"]]', 'Try again');
        await page.click('[data-ask-turn="turn-2"] [data-action="ask-settings"]');
        await page.waitForFunction(() => location.hash === '#/settings/ai');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
    // Microsoft 365 not connected: its line above the answer.
    {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, ask: 'idle' });
      await check(`ask Q5 (${theme}): an answer made without Microsoft 365 says so above it`, async () => {
        const t = doneThread();
        t.turns[1].searched = `${t.turns[1].searched} · Microsoft 365 isn't connected`;
        await showThread(page, t);
        assert(squash(await text(page, '[data-ask-turn="turn-2"] .ws-ask-note')) === NOT_CONNECTED, 'the Microsoft line');
        assert(await page.locator('[data-ask-turn="turn-1"] .ws-ask-note').count() === 0, 'the line on a turn that had Microsoft');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- Q6: actions run only on a click

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, ask: 'idle' });
    await check('ask Q6: Add as task fills the bar and saves nothing; a cite chip and Open go to the record with "← Back to Ask"; Draft a reply sends one ai_draft with the hint; nothing sent', async () => {
      await showThread(page, doneThread());
      const before = await page.evaluate(() => window.__bridgeCalls.length);
      await page.click('[data-ask-turn="turn-1"] [data-action="ask-task"]');
      await page.waitForSelector('.ws-capture');
      const bar = await page.evaluate(() => ({
        text: document.getElementById('capture-input')?.value,
        due: document.querySelector('[data-capture-due]')?.textContent.replace('×', '').trim(),
        source: document.querySelector('[data-capture-source]')?.textContent.replace('×', '').trim(),
      }));
      assert(bar.text === 'Send Priya the Atlas budget' && bar.due === 'Due Fri 27 Nov' && bar.source === 'From: Review: Q4 workspace roadmap', JSON.stringify(bar));
      await shot(page, 'ask-action-add-task');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ws-capture', { state: 'detached' });
      assert(await count(page, 'task_save') === 0, 'Add as task saved');
      // Priya's chip: her mail selected, and the way back.
      await page.click('[data-ask-turn="turn-1"] [data-action="ask-cite"][data-ask-cite="a1"]');
      await page.waitForSelector('.ws-inbox-row.ws-selected[data-id="m-reply-1"]');
      assert(hashOf(page) === '#/inbox', hashOf(page));
      await page.click('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
      await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
      assert(hashOf(page) === '#/ask/ask-7f2c', hashOf(page));
      // Open: as the event's chip goes, the event open on its day.
      await page.click('[data-ask-turn="turn-1"] [data-action="ask-go"]');
      await page.waitForSelector('dialog.ws-event-modal[open][data-event-id="ev-standup"]');
      assert(hashOf(page).startsWith('#/calendar'), hashOf(page));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.ws-event-modal[open]'));
      await page.click('.ws-toast .ws-toast-action:text-is("← Back to Ask")');
      await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
      // ✦ Draft a reply: Jordan's chat open, one ai_draft whose instructions hold the hint.
      await page.click('[data-ask-turn="turn-1"] [data-action="ask-reply"]');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op]) => op === 'ai_draft'));
      const drafts = await calls(page, 'ai_draft');
      assert(drafts.length === 1 && drafts[0].sourceId === 'c-reply-1' && drafts[0].instructions.includes('Say the deck comes Thursday.'), JSON.stringify(drafts));
      await page.waitForTimeout(300);
      const after = await page.evaluate(n => window.__bridgeCalls.slice(n).map(([op]) => op), before);
      assert(!after.some(op => /send|action_prepare|action_confirm|task_save|note_append|ask_start|ask_delete/.test(op)), `sent: ${after.join(',')}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q7: history, Delete and Clear history (Compact's History ▾)

  {
    const more = s => {
      const day = 86_400;
      const at = Math.floor(FIXED_NOW / 1000);
      s.ask.threads.push({ id: 'ask-week', title: 'What’s due this week?', updatedAt: at - 3 * day, turns: 1, last: 'done' }, { id: 'ask-old', title: 'Who’s waiting on me?', updatedAt: at - 20 * day, turns: 1, last: 'done' });
    };
    const { page, context, errors } = await open({ theme: 'light', width: 1000, height: 900, now: FIXED_NOW, ask: 'idle', patch: more, settings: { view: 'compact' } });
    await check('ask Q7: History ▾ groups the threads by day and marks the open one; ⋯ Delete sends one ask_delete; Clear history asks first, Return cancels, then one ask_delete {all:true}', async () => {
      await showThread(page, doneThread());
      const menu = '.ws-ask-hmenu';
      // History ▾ open with Clear history on screen (a redraw after Delete may close it).
      const openMenu = async () => {
        for (let i = 0; i < 4 && !(await page.locator(`${menu} [data-action="ask-clear"]`).isVisible()); i++) {
          await settled(page);
          if (!(await page.locator(`${menu}[open]`).count())) await page.click(`${menu} summary`);
          await page.waitForTimeout(150);
        }
      };
      await page.click(`${menu} summary`);
      await page.waitForSelector(`${menu}[open] .ws-ask-history`);
      const groups = await page.locator(`${menu} .ws-ask-hgroup`).allTextContents();
      assert(groups.join('|') === 'Today|Yesterday|This week|Earlier', `groups: ${groups.join('|')}`);
      assert(await page.getAttribute(`${menu} .ws-ask-hrow[aria-current=page]`, 'data-ask-thread') === 'ask-7f2c', 'the open thread is not marked');
      await shot(page, 'ask-history-compact-light-1000');
      // A thread's ⋯ inside History ▾: Esc closes the ⋯ first and leaves History ▾ open; Esc again closes it.
      await page.click(`${menu} [data-menu="ask-thread-ask-week"] summary`);
      await page.waitForSelector(`${menu}[open] [data-menu="ask-thread-ask-week"][open]`);
      await page.keyboard.press('Escape');
      await page.waitForSelector(`${menu} [data-menu="ask-thread-ask-week"]:not([open])`);
      assert(await page.locator(`${menu}[open]`).count() === 1, 'Esc on the ⋯ closed History ▾ too');
      await page.keyboard.press('Escape');
      await page.waitForSelector(`${menu}:not([open])`);
      await page.click(`${menu} summary`);
      await page.waitForSelector(`${menu}[open] .ws-ask-history`);
      await page.click(`${menu} [data-menu="ask-thread-ask-old"] summary`);
      await page.click(`${menu} [data-action="ask-delete"][data-ask-thread="ask-old"]`);
      await page.waitForSelector('[data-ask-thread="ask-old"]', { state: 'detached' });
      assert(JSON.stringify(await calls(page, 'ask_delete')) === '[{"threadId":"ask-old"}]', 'one ask_delete {threadId}');
      assert(await page.locator('dialog.ws-modal').count() === 0, 'Delete asked first');
      await openMenu();
      await page.click(`${menu} [data-action="ask-clear"]`);
      await page.waitForSelector('dialog.ws-modal h2:text-is("Clear Ask history?")');
      assert(await page.evaluate(() => document.activeElement?.textContent) === 'Cancel', 'Cancel is not focused');
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      await page.waitForSelector('dialog.ws-modal', { state: 'detached' });
      assert(await count(page, 'ask_delete') === 1, 'Return cleared the history');
      await openMenu();
      await page.click(`${menu} [data-action="ask-clear"]`);
      await page.waitForSelector('dialog.ws-modal');
      await page.waitForTimeout(600);
      await page.click('dialog.ws-modal button[type=submit]:text-is("Clear history")');
      await page.waitForFunction(() => location.hash === '#/ask');
      assert(JSON.stringify((await calls(page, 'ask_delete')).at(-1)) === '{"all":true}', 'no ask_delete {all:true}');
      await page.waitForSelector('.ws-ask-empty-line');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q8: quick capture

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1000, height: 800, now: FIXED_NOW, hash: '#/inbox', settings: viewSettings(view) });
      await check(`ask Q8 (${theme} ${view} 1000): ⌘N opens the bar with the selected mail as its source and the read date`, async () => {
        await page.click('.ws-inbox-row[data-id="m-reply-1"]');
        await settled(page);
        await page.keyboard.press('Meta+KeyN');
        await page.waitForSelector('.ws-capture');
        await page.keyboard.type('send the deck by fri');
        await page.waitForSelector('[data-capture-due="2026-11-27"]:not([data-stale] *)');
        const line = squash((await text(page, '#capture-line')).replace(/×/g, ' '));
        assert(line === 'Task in Connect · Due Fri 27 Nov · From: Review: Q4 workspace roadmap', `line: ${line}`);
        await noOverflow(page, assert, `${theme} ${view} capture`);
        const clipped = (await noClip(page)).filter(c => /capture/.test(c));
        assert(clipped.length === 0, `clipped: ${clipped.join(' | ')}`);
        await shot(page, `capture-${theme}-${view}`);
        assert(await count(page, 'task_save') === 0, 'typing saved');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
  // Every when-cases.json capture text shows its date line, or none.
  {
    const { page, context, errors } = await open({ theme: 'light', width: 1440, height: 900, now: FIXED_NOW, hash: '#/today' });
    await check('ask Q8: every when-cases.json capture text shows its date line (or none)', async () => {
      await page.keyboard.press('Meta+KeyN');
      await page.waitForSelector('.ws-capture');
      const seen = new Set();
      const wrong = [];
      for (const c of WHEN_CASES.filter(x => x.kind === 'parse')) {
        if (seen.has(c.input)) continue;
        seen.add(c.input);
        await page.fill('#capture-input', c.input);
        const due = c.expected.due;
        const ok = await page.waitForFunction(due => {
          const chip = document.querySelector('[data-capture-due]');
          return due ? chip?.dataset.captureDue === due && !chip.closest('[data-stale]') : !chip;
        }, due, { timeout: 2000 }).then(() => true, () => false);
        const shown = squash((await page.locator('[data-capture-due]').first().innerText().catch(() => '')).replace(/×/g, ''));
        if (!ok || (due ? shown !== dueLabel(due) : shown !== '')) wrong.push(`${c.name}: "${c.input}" → ${shown || 'none'} (want ${due ? dueLabel(due) : 'none'})`);
      }
      assert(wrong.length === 0, wrong.join(' | '));
      assert(await count(page, 'task_save') === 0, 'a parse saved');
      assert(errors.length === 0, errors.join(' | '));
    });
    await check('ask Q8: × keeps the words and Add sends due: null; Undo sends one task_delete', async () => {
      await page.fill('#capture-input', 'send the deck by fri');
      await page.waitForSelector('[data-capture-due="2026-11-27"]:not([data-stale] *)');
      await page.click('[data-action="capture-due-drop"]');
      await page.waitForSelector('[data-capture-due]', { state: 'detached' });
      assert(await page.inputValue('#capture-input') === 'send the deck by fri', 'the words went');
      await page.click('[data-action="capture-add"]');
      await waitCount(page, 'task_save', 1);
      const saved = (await calls(page, 'task_save'))[0];
      assert(saved.text === 'send the deck by fri' && saved.due === null && saved.status === 'todo' && !('sourceId' in saved), JSON.stringify(saved));
      await page.waitForSelector('.ws-capture', { state: 'detached' });
      await page.locator('.ws-toast:has-text("Added to") .ws-toast-action:text-is("Undo")').last().click();
      await waitCount(page, 'task_delete', 1);
      assert(errors.length === 0, errors.join(' | '));
    });
    await check('ask Q8: Note saves the Notes widget’s typed text first, then sends one note_append', async () => {
      await page.click('#today-note');
      await page.keyboard.press('End');
      await page.keyboard.type(' Pending words.');
      await page.keyboard.press('Meta+KeyN');
      await page.waitForSelector('.ws-capture');
      await page.click('[data-capture-mode="note"]');
      await page.fill('#capture-input', 'Ask Marek about the Q1 headcount');
      await page.keyboard.press('Enter');
      await waitCount(page, 'note_append', 1);
      // The mock's note_append adds its line to the stored note: had the typed words been saved
      // after it (or not at all), the stored note would lack them or the line.
      await page.waitForTimeout(1200);
      const stored = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.kind === 'note')?.data.text || '');
      assert(stored.includes('Pending words.') && stored.trimEnd().endsWith('- Ask Marek about the Q1 headcount'), `stored note: ${JSON.stringify(stored)}`);
      assert(JSON.stringify(await calls(page, 'note_append')) === '[{"text":"Ask Marek about the Q1 headcount"}]', JSON.stringify(await calls(page, 'note_append')));
      await page.waitForFunction(() => { const v = document.getElementById('today-note')?.value || ''; return v.includes('Pending words.') && v.includes('- Ask Marek about the Q1 headcount'); });
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
  // A selected message as the source; ⌘↩ adds and stays without sending the touched reply (Compact).
  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/inbox', enable: ['mail_send'], settings: { view: 'compact' } });
    await check('ask Q8 (compact): Add sends one task_save with sourceId, sourceRevision, quote and status todo; ⌘↩ adds and stays, the touched reply never sent', async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await page.waitForSelector('.ws-crow-body[data-message-id="m-reply-1"] #reply-body');
      await page.click('#reply-body');
      await page.keyboard.type('Thanks, on it.');
      await page.keyboard.press('Meta+KeyN');
      await page.waitForSelector('[data-capture-source="message"]');
      await page.keyboard.type('Book the review room');
      await page.waitForTimeout(250);
      await page.keyboard.press('Meta+Enter');
      await waitCount(page, 'task_save', 1);
      await page.waitForTimeout(300);
      const record = await page.evaluate(() => window.__workspace.store.get().snapshot.records.find(r => r.id === 'm-reply-1'));
      const saved = (await calls(page, 'task_save'))[0];
      assert(saved.text === 'Book the review room' && saved.due === null && saved.status === 'todo' && saved.sourceId === 'm-reply-1' && saved.sourceRevision === record.revision && saved.quote === record.data.text.slice(0, 2000), JSON.stringify(saved));
      assert(await page.locator('.ws-capture').count() === 1 && await page.inputValue('#capture-input') === '', 'the bar did not stay open and empty');
      const sent = await page.evaluate(() => window.__bridgeCalls.map(([op]) => op).filter(op => /send|action_prepare|action_confirm/.test(op)));
      assert(sent.length === 0, `sent: ${sent.join(',')}`);
      assert(await page.inputValue('#reply-body') === 'Thanks, on it.', 'the reply lost its words');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q9: Settings

  {
    const { page, context, errors } = await open({ theme: 'light', width: 1440, height: 900, hash: '#/settings/ai', ai: 'all' });
    await check('ask Q9: Settings › AI shows the Ask group and row; Settings › Layout’s "Ask in the menu" sends one settings_update; the shortcut list holds ⌘K, ⌘N and ⌘.', async () => {
      await page.waitForSelector('[data-ai-route-row="ask"]');
      assert(await page.locator('th[scope=rowgroup]:text-is("Ask")').count() === 1, 'no Ask group');
      assert(/Questions you type in ⌘K\./.test(await text(page, '[data-ai-route-row="ask"]')), 'Ask row hint');
      await page.evaluate(() => window.__workspace.route('settings', 'layout'));
      await page.waitForSelector('[data-setting="askInMenu"]');
      const rows = await page.evaluate(() => [...document.querySelectorAll('.ws-setting-row')].filter(r => r.querySelector('kbd.ws-kbd')).map(r => `${r.querySelector('kbd').textContent} — ${r.querySelector('strong').textContent}`));
      for (const line of ['⌘K — Ask', '⌘N — Quick capture', '⌘. — Stop an answer']) assert(rows.includes(line), `no "${line}" in ${rows.join(' | ')}`);
      await page.click('.ws-switch:has([data-setting="askInMenu"])');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'settings_update' && 'askInMenu' in d));
      const updates = (await calls(page, 'settings_update')).filter(d => 'askInMenu' in d);
      assert(JSON.stringify(updates) === '[{"askInMenu":false}]', JSON.stringify(updates));
      await page.waitForSelector('.ws-ask-field', { state: 'detached' });
      await shot(page, 'ask-settings-layout-light');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q10: Default/Compact parity

  {
    const normalize = html => html.replace(/\s(id|aria-controls|aria-describedby|aria-labelledby|aria-activedescendant|for)="[^"]*"/g, '');
    const capture = async view => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, ask: 'idle', settings: viewSettings(view) });
      await showThread(page, doneThread());
      await page.waitForSelector('[data-ask-turn="turn-1"] .ws-ask-actions');
      const turn = await page.locator('article[data-ask-turn="turn-1"]').evaluate(el => el.outerHTML);
      const field = await page.locator('.ws-ask-field').evaluate(el => el.outerHTML);
      await page.keyboard.press('Meta+KeyN');
      await page.waitForSelector('.ws-capture');
      await page.keyboard.type('send the deck by fri');
      await page.waitForSelector('[data-capture-due="2026-11-27"]:not([data-stale] *)');
      const bar = await page.locator('.ws-capture').evaluate(el => el.outerHTML);
      return { context, turn: normalize(turn), field: normalize(field), bar: normalize(bar) };
    };
    // Taken before `check` (which looks at the page opened last); a failure is reported there.
    let def = null;
    let compact = null;
    let failed = null;
    try {
      def = await capture('default');
      await def.context.close().catch(() => {});
      compact = await capture('compact');
    } catch (err) {
      failed = err;
    }
    await check('ask Q10: the turn block, the field and the capture bar draw the same markup in Default and Compact (ids stripped)', async () => {
      if (failed) throw failed;
      for (const part of ['turn', 'field', 'bar']) assert(def[part] === compact[part], `${part} differs:\n${def[part]}\n${compact[part]}`);
    });
    await compact?.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Q11: nothing from rendering

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, ask: 'idle', voice: 'ready', tasks: true, meetings: true, automations: 'habits' });
    await check('ask Q11: opening every page and the Ask page sends no ask_start, ask_delete, task_save, note_append or ai_draft; localStorage keeps no question or answer', async () => {
      for (const [id] of NAV) {
        await page.evaluate(id => window.__workspace.route(id), id);
        await settled(page);
      }
      for (const tab of ['ai', 'layout']) {
        await page.evaluate(tab => window.__workspace.route('settings', tab), tab);
        await settled(page);
      }
      await page.evaluate(() => window.__workspace.route('ask'));
      await settled(page);
      await showThread(page, doneThread());
      await settled(page);
      // Words typed and left unasked are not kept either.
      await page.fill('#ask-follow-up', `${SENTINEL} follow-up`);
      await page.keyboard.press('Meta+KeyK');
      await page.keyboard.type(`${SENTINEL} question`);
      await page.keyboard.press('Meta+KeyN');
      await page.waitForSelector('.ws-capture');
      await page.keyboard.type(`${SENTINEL} task`);
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const written = await page.evaluate(ops => window.__bridgeCalls.filter(([op]) => ops.includes(op)).map(([op]) => op), WRITES);
      assert(written.length === 0, `rendering sent: ${written.join(',')}`);
      const stored = await page.evaluate(() => Object.keys(localStorage).map(k => `${k}=${localStorage.getItem(k)}`).join('\n'));
      for (const words of [SENTINEL, 'What did I promise Priya', 'When is the QBR', 'Atlas budget', 'And Jordan Lee?', 'Say the deck comes Thursday']) assert(!stored.includes(words), `localStorage holds "${words}"`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
