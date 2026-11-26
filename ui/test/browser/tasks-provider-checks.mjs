// Browser checks of the task provider (task provider design §§8–10) across both views (Board/By
// date), both themes and three widths, run by workspace-e2e.mjs with its MOCKED native bridge.
// P1–P12 below; P1's matrix and P10's parity are the only things here that repeat a shape already
// covered once at a single width/theme by tasks-dates-checks.mjs or settings-tasks-checks.mjs —
// everywhere else this file deliberately tests what those two don't: the responsive matrix, the
// state banners' and header line's exact text, a non-empty parked sentence, a mixed Local/Todoist
// snapshot's filtering (Today's widget, the meeting column, switching back), nothing-written-by-
// rendering, and that the Todoist token never reaches the DOM, storage or a later native request
// (spec §8's surfaces this Chromium harness can exercise — its frame/IPC boundary is native, see
// P2's own comment). Reference, don't duplicate: row controls, Nudge/Snooze mechanics, the copy
// dialog's own wiring, Open in Todoist ↗, delete-with-a-provider and the removed-plugin fallback
// are already proven once by tasks-dates-checks.mjs / settings-tasks-checks.mjs.
import { readFileSync } from 'node:fs';
import { CLIP_SELECTORS, FIXED_NOW } from './compact-checks.mjs';

const STATES = JSON.parse(readFileSync(new URL('../fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
const CASES = JSON.parse(readFileSync(new URL('../fixtures/contract/task-sync-cases.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;

/** A named state from task-provider-states.json, with any fields the caller wants to override
 *  (e.g. a `lastSync` relative to FIXED_NOW). */
const taskProvider = (name, overrides = {}) => ({ ...STATES[name], ...overrides });

/** Every commitment in the fixture stamped as Todoist's, state `ready` (the same base shape
 *  tasks-dates-checks.mjs's own `todoist()` helper uses, so the two files' fixtures agree).
 *  Exported for the tour seed builder (`scripts/tour/seed.mjs`, Task 4), which reuses it as-is. */
export function allTodoist(snapshot) {
  snapshot.taskProvider = taskProvider('ready', { lastSync: Math.floor(FIXED_NOW / 1000) - 60 });
  for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
}

/** Only `task-legal`, `task-demo` and `task-hr` are Todoist's; the rest (task-tenant, task-names,
 *  task-pilot, task-room, task-dashboard, and the two review tasks) stay Local's — for the checks
 *  that prove the active provider's filter actually filters (P7, P9). */
const TODOIST_IDS = ['task-legal', 'task-demo', 'task-hr'];
function mixedProviders(snapshot) {
  snapshot.taskProvider = taskProvider('ready', { lastSync: Math.floor(FIXED_NOW / 1000) - 60 });
  for (const r of snapshot.records.filter(x => x.kind === 'commitment' && TODOIST_IDS.includes(x.id))) r.data.provider = 'plugin:todoist';
}

/** task-legal, task-hr and task-tenant moved into the past: exactly three late, open, Todoist
 *  tasks (task-demo stays Today, task-names stays Later, the two review tasks stay To review). */
function lateThree(snapshot) {
  allTodoist(snapshot);
  const dayAgo = n => new Date(FIXED_NOW - n * DAY).toLocaleDateString('sv', { timeZone: snapshot.settings.timeZone });
  const task = id => snapshot.records.find(r => r.id === id).data;
  Object.assign(task('task-legal'), { due: dayAgo(3), status: 'todo' });
  Object.assign(task('task-hr'), { due: dayAgo(1), status: 'todo' });
  Object.assign(task('task-tenant'), { due: dayAgo(2), status: 'todo' });
}

/** A new check-in task owned by someone the fixture doesn't otherwise use (Marek Novak), due
 *  yesterday (Late, visible without unfolding anything), its source a synced mail thread so Nudge
 *  can open it. Exported for the tour seed builder (`scripts/tour/seed.mjs`, Task 4). */
export function marekCheckIn(snapshot) {
  allTodoist(snapshot);
  const now = Math.floor(FIXED_NOW / 1000);
  const yesterday = new Date(FIXED_NOW - DAY).toLocaleDateString('sv', { timeZone: snapshot.settings.timeZone });
  snapshot.records.push({
    id: 'task-marek', kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal',
    revision: 'r-task-marek', updatedAt: now - 600,
    data: {
      text: 'Send the pilot deck to Philips', owner: 'marek.novak@example.test', ownerName: 'Marek Novak',
      status: 'todo', due: yesterday, notes: null, meetingId: null, sourceId: 'm-reply-1', provider: 'plugin:todoist',
      createdAt: now - 3600, history: [{ at: now - 3600, text: 'Added by you' }], order: now,
    },
  });
}

/** task-demo (due today) looks handled: the same evidence tasks-dates-checks.mjs uses for its
 *  "Done" path, so P5 can prove the other button, "Keep open". Exported for the tour seed
 *  builder (`scripts/tour/seed.mjs`, Task 4). */
export function demoHandled(snapshot) {
  allTodoist(snapshot);
  const task = snapshot.records.find(r => r.id === 'task-demo').data;
  task.handled = { evidence: 'you replied in Teams 17:32', at: 0, auto: false };
}

/** Local, Todoist installed and on, exactly three open Local tasks (so the first choice offers
 *  "Copy 3 tasks"), nothing offered yet — the settings-tasks-checks.mjs `readyToOffer` shape, with
 *  three tasks instead of one. */
function readyToOfferThree(snapshot) {
  snapshot.taskProvider = {
    active: 'local', name: 'Connect',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true, pending: 0 }],
    state: 'local', pending: 0, parked: 0, lastSync: null, retryAt: null, message: null, copyOffered: false,
  };
  snapshot.settings.tasks = { provider: 'local', copyOffered: [] };
  snapshot.records = snapshot.records.filter(r => r.kind !== 'commitment');
  const now = Math.floor(FIXED_NOW / 1000);
  ['a', 'b', 'c'].forEach((suffix, i) => snapshot.records.push({
    id: `t-${suffix}`, kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: `r-${suffix}`, updatedAt: now,
    data: { text: `Open task ${i + 1}`, status: 'todo', order: i + 1, history: [{ at: now, text: 'Added by you' }] },
  }));
}

/** The one commitment of task-sync-cases.json's "parked" case: a real, non-empty refusal sentence
 *  ("Todoist needs a date like 2026-11-20."), unlike tasks-dates-checks.mjs's own parked check,
 *  which covers only the withheld (empty-string) sentence. */
const PARKED = CASES.parked.find(r => r.kind === 'commitment');

/** tasks-dates-checks.mjs's own `footer`/`controls` helpers, repeated here rather than imported
 *  (that file exports neither): the footer's text, and a row's visible controls besides its
 *  unfold button and done box. */
const footer = page => page.locator('.ws-tdate-foot').innerText().then(t => t.replace(/\s+/g, ' ').trim());
const controls = (page, id) => page.locator(`.ws-tdate-row[data-task="${id}"]`).evaluate(row => [...row.querySelectorAll('button, summary')]
  .filter(el => !el.classList.contains('ws-tdate-main') && !el.closest('.ws-menu-panel') && el.checkVisibility())
  .map(el => el.textContent.trim() || 'icon'));

/** compact-checks.mjs's `noClip`, widened with By date's own row controls (P1's own ask). */
const noClip = page => page.evaluate(selectors => {
  const out = [];
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if (!el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true })) return;
    const cs = getComputedStyle(el);
    const heightClip = el.scrollHeight > el.clientHeight + 1;
    const widthClip = el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis';
    if (!heightClip && !widthClip) return;
    const sel = selectors.find(s => el.matches(s)) || el.tagName.toLowerCase();
    out.push(`${sel}${el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : ''} "${(el.textContent || '').trim().slice(0, 40)}" (${heightClip ? 'height' : 'width'})`);
  });
  return out;
}, [...CLIP_SELECTORS, '.ws-tdate-row button']);

/** reply-checks.mjs's `noOverflow` pattern, widened to By date's own scrolling parts. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - window.innerWidth,
    ...[...document.querySelectorAll('.ws-main, .ws-tdate, .ws-modal[open] .ws-modal-body')]
      .filter(el => el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map(el => el.scrollWidth - el.clientWidth),
  ));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

/** Two columns (the design's ≥1100px container query) when the two `.ws-tdate-col`s sit side by
 *  side; one column when the second sits below the first. */
const columnLayout = async page => {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.ws-tdate-cols > .ws-tdate-col')].map(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; }));
  if (boxes.length !== 2) return 'other';
  if (Math.abs(boxes[0].y - boxes[1].y) < 5 && boxes[1].x > boxes[0].x + 50) return 'two';
  if (boxes[1].y > boxes[0].y + 20) return 'one';
  return 'other';
};

export async function tasksProviderChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- P1: both views, both themes, three widths

  for (const theme of ['dark', 'light']) {
    for (const width of [1000, 1440, 1680]) {
      const dark1440default = theme === 'dark' && width === 1440;
      const { page, context, errors } = await open({ theme, width, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: allTodoist });
      await check(`tasks-provider P1: ${theme} default ${width}`, async () => {
        await page.waitForSelector('.ws-tdate[data-provider]');
        await settled(page);
        assert(await page.locator('section.ws-tdate-late').count() === 1, 'the Late section');
        assert(await page.locator('section.ws-tdate-today').count() === 1, 'the Today section');
        assert(await page.locator('section.ws-tdate-later').count() === 1, 'the Later section');
        const layout = await columnLayout(page);
        const expected = width === 1000 ? 'one' : 'two';
        assert(layout === expected, `columns at ${width}px: ${layout}`);
        await noOverflow(page, assert, `${theme} default ${width}`);
        const clipped = await noClip(page);
        assert(clipped.length === 0, clipped.join(' | '));
        await shot(page, `tasks-provider-${theme}-default-${width}`);
        assert(errors.length === 0, errors.join(' | '));
      });
      if (dark1440default) {
        await check('tasks-provider P1: a Later fold opens', async () => {
          await page.click('[data-action="tasks-fold"][data-fold="noDate"]');
          await page.waitForSelector('#tdate-fold-noDate:not([hidden])');
          await settled(page);
          await shot(page, 'tasks-provider-folds-open');
          assert(errors.length === 0, errors.join(' | '));
        });
      }
      await context.close().catch(() => {});

      const { page: cp, context: cc, errors: ce } = await open({ theme, width, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: allTodoist, settings: { view: 'compact' } });
      await check(`tasks-provider P1: ${theme} compact ${width}`, async () => {
        await cp.waitForSelector('.ws-tdate[data-provider]');
        await settled(cp);
        assert(await cp.locator('section.ws-tdate-late').count() === 1, 'the Late section');
        assert(await cp.locator('section.ws-tdate-today').count() === 1, 'the Today section');
        assert(await cp.locator('section.ws-tdate-later').count() === 1, 'the Later section');
        const layout = await columnLayout(cp);
        const expected = width === 1000 ? 'one' : 'two';
        assert(layout === expected, `columns at ${width}px: ${layout}`);
        await noOverflow(cp, assert, `${theme} compact ${width}`);
        const clipped = await noClip(cp);
        assert(clipped.length === 0, clipped.join(' | '));
        await shot(cp, `tasks-provider-${theme}-compact-${width}`);
        assert(ce.length === 0, ce.join(' | '));
      });
      await cc.close().catch(() => {});
    }
  }

  {
    const patch = snapshot => {
      snapshot.taskProvider = STATES.needs_token;
      for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check('tasks-provider P1: the needs_token banner', async () => {
      await page.waitForSelector('.ws-tdate-banner');
      await settled(page);
      await shot(page, 'tasks-provider-banner-needs-token');
      assert((await page.locator('.ws-tdate-banner').innerText()).includes('Todoist needs your API token.'), 'banner text');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P2: Settings › Tasks (Review Focus 4), spec §8

  {
    const SENTINEL = 'tk_SENTINEL_do_not_log_0123456789';
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/settings/meetings-tasks', patch: readyToOfferThree });
    await check('tasks-provider P2: the radio, "Copy 3 tasks", the token never leaks (DOM, storage, a later request), choosing again shows no dialog', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      assert(await page.locator('input[name="tasks-provider"]:checked').getAttribute('value') === 'local', 'Local starts checked');
      await page.click('.ws-ms-radio-card:has(input[value="plugin:todoist"])');
      await page.waitForSelector('.ws-modal[open]:has-text("Copy your open tasks to Todoist?")');
      const body = await page.locator('.ws-modal[open] .ws-modal-body').innerText();
      assert(body.includes('Connect has 3 open tasks.'), body);
      await page.click('.ws-modal[open] button:has-text("Copy 3 tasks")');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'plugin:todoist' && sent.copy === true, JSON.stringify(sent));
      await page.waitForSelector('input[name="tasks-provider"][value="plugin:todoist"]:checked');

      // The token: Save empties the field; the sentinel is in no DOM text or attribute, no
      // localStorage or sessionStorage value, and reaches no later native request.
      await page.waitForSelector('[data-provider-secret="token"] input[type=password]');
      await page.fill('[data-provider-secret="token"] input[type=password]', SENTINEL);
      await page.click('[data-provider-secret="token"] [data-action="tasks-provider-secret-save"]');
      await page.waitForSelector('[data-provider-secret="token"]:has-text("Saved on this Mac")');
      const value = await page.locator('[data-provider-secret="token"] input[type=password]').inputValue();
      assert(value === '', `field not cleared: ${value}`);
      assert(!(await page.content()).includes(SENTINEL), 'the sentinel reached the page markup');
      const storageDump = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      assert(!storageDump.includes(SENTINEL), 'the sentinel reached localStorage or sessionStorage');
      const saved = (await calls(page, 'set_setting')).at(-1);
      assert(saved.id === 'todoist' && saved.key === 'token' && saved.value === SENTINEL, JSON.stringify(saved));
      // A further render (as a background refresh would cause) still shows nothing of it.
      await page.evaluate(() => window.__workspace.render());
      await settled(page);
      assert(!(await page.content()).includes(SENTINEL), 'a later render leaked the sentinel');
      const allCalls = await page.evaluate(() => window.__bridgeCalls);
      const leaked = allCalls.filter(([op, d]) => op !== 'set_setting' && JSON.stringify(d).includes(SENTINEL));
      assert(leaked.length === 0, `the sentinel reached a later request: ${JSON.stringify(leaked)}`);

      // Spec §8's "no plugin frame ever gets the token" is enforced natively, not by this harness:
      // the real frame/IPC boundary (main-frame-only invoke key, IPC Origin checks, frame
      // sandbox/CSP) lives in src-tauri/src/plugins/caller.rs and is covered by its own Rust
      // tests. A Chromium/Playwright probe against a fixture plugin's static frame.html has no
      // path to the Todoist token either way, so it would only prove this harness's own mock
      // `installBridge` guard (workspace-e2e.mjs) works as written, not the production guarantee
      // (review: task-11-review.md). The DOM/localStorage/sessionStorage/later-call assertions
      // above already cover the leak surfaces this browser harness can actually exercise.

      // Choosing Connect, then Todoist again: no dialog either way (already offered), only the quiet link.
      await page.click('.ws-ms-radio-card:has(input[value="local"])');
      await page.waitForSelector('input[name="tasks-provider"][value="local"]:checked');
      assert(await page.locator('.ws-modal[open]').count() === 0, 'a dialog switching to Connect');
      await page.click('.ws-ms-radio-card:has(input[value="plugin:todoist"])');
      await page.waitForSelector('input[name="tasks-provider"][value="plugin:todoist"]:checked');
      assert(await page.locator('.ws-modal[open]').count() === 0, 'a dialog choosing Todoist a second time');
      assert(await page.locator('[data-action="tasks-provider-copy"]').count() === 1, 'the quiet "Copy open tasks…" link');
      await settled(page);
      await shot(page, 'tasks-provider-settings-dark');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P3: Late ⋯ over exactly three tasks

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: lateThree });
    await check('tasks-provider P3: Late ⋯ "Move all to Tomorrow" sends one task_bulk of the 3 late tasks; Undo sends their due/status back', async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const late = await page.locator('.ws-tdate-late .ws-tdate-row').evaluateAll(rows => rows.map(r => r.dataset.task));
      assert(late.length === 3, `late: ${late}`);
      const before = (await calls(page, 'task_bulk')).length;
      await page.click('[data-menu="tasks-late"] > summary');
      await page.click('[data-menu="tasks-late"] [data-action="tasks-late-move"][data-to="tomorrow"]');
      await page.waitForFunction(() => document.querySelector('.ws-tdate-foot')?.textContent.includes('Moved'));
      const moveCalls = (await calls(page, 'task_bulk')).slice(before);
      assert(moveCalls.length === 1 && moveCalls[0].items.length === 3, JSON.stringify(moveCalls));
      assert(/Moved 3 to Tomorrow · Undo$/.test(await footer(page)), await footer(page));
      await page.click('.ws-tdate-foot [data-action="tasks-undo"]');
      await page.waitForFunction(() => !(document.querySelector('.ws-tdate-foot')?.textContent.includes('Undo')));
      const undoCalls = (await calls(page, 'task_bulk')).slice(before + 1);
      assert(undoCalls.length === 1 && undoCalls[0].items.length === 3, JSON.stringify(undoCalls));
      assert(JSON.stringify(undoCalls[0].items.map(i => i.id).sort()) === JSON.stringify(['task-hr', 'task-legal', 'task-tenant']), JSON.stringify(undoCalls[0].items));
      assert(undoCalls[0].items.every(i => i.status === 'todo' && i.due), JSON.stringify(undoCalls[0].items));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: lateThree });
    await check('tasks-provider P3: Late ⋯ "Done all" marks the 3 late tasks done', async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const before = (await calls(page, 'task_bulk')).length;
      await page.click('[data-menu="tasks-late"] > summary');
      await page.click('[data-menu="tasks-late"] [data-action="tasks-late-done"]');
      await page.waitForFunction(() => document.querySelector('.ws-tdate-foot')?.textContent.includes('Marked'));
      const doneCalls = (await calls(page, 'task_bulk')).slice(before);
      assert(doneCalls.length === 1 && doneCalls[0].items.length === 3 && doneCalls[0].items.every(i => i.status === 'done'), JSON.stringify(doneCalls));
      assert(/Marked 3 done · Undo$/.test(await footer(page)), await footer(page));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P4: a check-in row for Marek

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: marekCheckIn });
    await check('tasks-provider P4: "Check with Marek: …"; Nudge fills the reply box and sends nothing', async () => {
      await page.waitForSelector('.ws-tdate-row[data-task="task-marek"]');
      const label = await page.locator('.ws-tdate-row[data-task="task-marek"] .ws-tdate-text').innerText();
      assert(label === 'Check with Marek: Send the pilot deck to Philips', label);
      await page.click('.ws-tdate-row[data-task="task-marek"] .ws-tdate-main');
      assert((await page.locator('.ws-tdate-row[data-task="task-marek"] .ws-btn-primary').innerText()) === 'Nudge Marek', 'Nudge is the row primary');
      await page.click('.ws-tdate-row[data-task="task-marek"] [data-action="task-nudge"]');
      await page.waitForSelector('#reply-body');
      await page.waitForFunction(() => document.getElementById('reply-body').value.startsWith('Hi Marek'));
      const line = await page.locator('#reply-body').inputValue();
      assert(line === 'Hi Marek, any news on Send the pilot deck to Philips?', line);
      assert((await calls(page, 'action_prepare')).length === 0 && (await calls(page, 'action_confirm')).length === 0, 'something was sent');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: marekCheckIn });
    await check('tasks-provider P4: Snooze ▾ › Monday saves the due date with task_save', async () => {
      await page.waitForSelector('.ws-tdate-row[data-task="task-marek"]');
      await page.click('.ws-tdate-row[data-task="task-marek"] .ws-tdate-main');
      await page.click('.ws-tdate-row[data-task="task-marek"] .ws-tdate-snooze > summary');
      await page.click('.ws-tdate-row[data-task="task-marek"] [data-action="task-snooze"]:has-text("Monday")');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'task_save' && d.id === 'task-marek' && 'due' in d));
      const saved = (await calls(page, 'task_save')).at(-1);
      assert(saved.id === 'task-marek' && /^\d{4}-\d{2}-\d{2}$/.test(saved.due), JSON.stringify(saved));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P5: "Looks handled" › Keep open

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: demoHandled });
    await check('tasks-provider P5: "Looks handled · you replied in Teams 17:32"; Keep open clears the flag', async () => {
      await page.waitForSelector('.ws-tdate-row[data-task="task-demo"]');
      const note = await page.locator('.ws-tdate-row[data-task="task-demo"] .ws-tdate-handled').innerText();
      assert(note.includes('Looks handled · you replied in Teams 17:32'), note);
      await page.click('.ws-tdate-row[data-task="task-demo"] .ws-tdate-main');
      await page.click('.ws-tdate-row[data-task="task-demo"] [data-action="task-handled"][data-act="keep"]');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'task_handled' && d.action === 'keep'));
      await settled(page);
      assert(await page.locator('.ws-tdate-row[data-task="task-demo"] .ws-tdate-handled').count() === 0, 'the flag is gone after render');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P6: the meeting column (singular)

  {
    const { page, context, errors } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, patch: allTodoist });
    await check('tasks-provider P6: "Add 1 to Todoist" saves once; "Added 1 to Todoist · Undo" withdraws once; "In Todoist" heading', async () => {
      await page.waitForSelector('.ws-mtg-items');
      assert(/Add 1 to Todoist/.test(await page.locator('[data-action="meeting-items-add"]').innerText()), 'Add 1 to Todoist');
      const saves = (await calls(page, 'task_save')).length;
      await page.click('[data-action="meeting-items-add"]');
      await page.waitForSelector('.ws-mtg-items-foot:has-text("Added 1 to Todoist")');
      const saved = (await calls(page, 'task_save')).slice(saves);
      assert(saved.length === 1 && saved[0].id === 'task-endpoint' && saved[0].status === 'todo', JSON.stringify(saved));
      assert(await page.locator('.ws-mtg-items-sub:has-text("In Todoist")').count() === 1, 'the In Todoist heading');
      await page.click('.ws-mtg-items-foot [data-action="meeting-items-undo"]');
      await page.waitForSelector('[data-task="task-endpoint"] [data-action="meeting-item-tick"]:checked');
      const withdrawn = await calls(page, 'task_withdraw');
      assert(withdrawn.length === 1 && JSON.stringify(withdrawn.at(-1).ids) === JSON.stringify(['task-endpoint']), JSON.stringify(withdrawn));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P7: Today's widget shows only the active provider's tasks

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/today', patch: mixedProviders });
    await check('tasks-provider P7: Today’s Tasks widget shows Todoist’s tasks only, no trash, "Tasks", quick add saves', async () => {
      await page.waitForSelector('.ws-commitments');
      const tile = page.locator('.ws-commitments');
      const texts = await tile.locator('.ws-todo .ws-link-title').allInnerTexts();
      assert(texts.some(t => /legal-hold/.test(t)), `Todoist’s task-legal is missing: ${texts}`);
      assert(!texts.some(t => /throttling test tenant/.test(t)), `Local’s task-tenant leaked into Todoist’s widget: ${texts}`);
      assert(await tile.locator('[data-action="task-delete"]').count() === 0, 'no trash with a provider');
      assert(await tile.locator('[data-action="commitment-toggle"]').count() > 0, 'done boxes');
      assert((await tile.locator('.ws-card-actions [data-action="route"][data-route="tasks"]').innerText()).trim() === 'Tasks', 'the Tasks button');
      const saves = (await calls(page, 'task_save')).length;
      await tile.locator('[data-form="commitment-add"] [name="text"]').fill('Send the Todoist-only summary');
      await tile.locator('[data-form="commitment-add"] button[type="submit"]').click();
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'task_save').length > n, saves);
      await page.waitForSelector('.ws-commitments .ws-todo:has-text("Send the Todoist-only summary")');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P8: states, pending and a real parked sentence

  for (const [name, pattern] of [['offline', /^Todoist can't be reached · 1 change waits · trying again at \d{1,2}:\d{2}(\s?[AP]M)?$/], ['rate_limited', /^Todoist asked Connect to slow down · trying again at \d{1,2}:\d{2}(\s?[AP]M)?$/]]) {
    const patch = snapshot => {
      snapshot.taskProvider = STATES[name];
      for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check(`tasks-provider P8: the ${name} header line`, async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const line = await page.locator('.ws-tasks-line').innerText();
      assert(pattern.test(line), line);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  for (const [name, expected] of [['needs_token', 'Todoist needs your API token.'], ['off', "Todoist is turned off in Settings › Plugins. You're seeing the last copy; changes wait."], ['failed', "The Todoist plugin didn't load."]]) {
    const patch = snapshot => {
      snapshot.taskProvider = STATES[name];
      for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check(`tasks-provider P8: the ${name} banner`, async () => {
      await page.waitForSelector('.ws-tdate-banner');
      await settled(page);
      const text = (await page.locator('.ws-tdate-banner').innerText()).trim();
      assert(text.startsWith(expected), text);
      if (name === 'needs_token') assert(await page.locator('.ws-tdate-banner [data-action="settings-tab"][data-tab="meetings-tasks"]').count() === 1, 'Open Settings');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // I1: a plugin still loading reads as neutral, never the "didn't load" banner.
  {
    const patch = snapshot => {
      snapshot.taskProvider = STATES.loading;
      for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check('tasks-provider P8: the loading state shows no banner and a neutral header line', async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      assert(await page.locator('.ws-tdate-banner').count() === 0, 'no banner while loading');
      const line = await page.locator('.ws-tasks-line').innerText();
      assert(line.trim() === 'Todoist', line);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const patch = snapshot => {
      allTodoist(snapshot);
      snapshot.records.find(r => r.id === 'task-demo').data.pending = true;
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check('tasks-provider P8: a pending row shows "Not in Todoist yet"', async () => {
      await page.waitForSelector('.ws-tdate-row[data-task="task-demo"]');
      const title = await page.locator('.ws-tdate-row[data-task="task-demo"] .ws-tdate-pending').getAttribute('title');
      assert(title === 'Not in Todoist yet', title);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const patch = snapshot => {
      allTodoist(snapshot);
      snapshot.records = snapshot.records.filter(r => r.id !== PARKED.id).concat({ ...PARKED, workspaceId: 'personal' });
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check('tasks-provider P8: a parked row shows the provider’s own sentence, with Try again and Discard change', async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      await page.click('[data-action="tasks-fold"][data-fold="next7"]');
      await page.waitForSelector(`.ws-tdate-row[data-task="${PARKED.id}"] .ws-tdate-error`);
      const text = await page.locator(`.ws-tdate-row[data-task="${PARKED.id}"] .ws-tdate-error`).innerText();
      assert(text === PARKED.data.syncError, text);
      await page.click(`.ws-tdate-row[data-task="${PARKED.id}"] .ws-tdate-main`);
      const parkedControls = await controls(page, PARKED.id);
      assert(parkedControls.join() === 'Try again,Discard change,icon', `parked controls: ${parkedControls}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P9: back to Local

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/settings/meetings-tasks', patch: mixedProviders });
    await check('tasks-provider P9: switching back to Connect makes Board the default again, with only Local’s tasks', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      assert(await page.locator('input[name="tasks-provider"]:checked').getAttribute('value') === 'plugin:todoist', 'Todoist starts chosen');
      await page.click('.ws-ms-radio-card:has(input[value="local"])');
      await page.waitForSelector('input[name="tasks-provider"][value="local"]:checked');
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'local', JSON.stringify(sent));
      await page.click('.ws-nav [data-action="route"][data-route="tasks"]');
      await page.waitForSelector('.ws-page-tasks .ws-task-board');
      await settled(page);
      assert(await page.locator('.ws-tdate').count() === 0, 'By date, not Board, is shown');
      assert(await page.locator('[data-task="task-tenant"]').count() === 1, 'Local’s task-tenant is shown');
      assert(await page.locator('[data-task="task-legal"]').count() === 0, 'Todoist’s task-legal still shows');
      assert(await page.locator('[data-task="task-demo"]').count() === 0, 'Todoist’s task-demo still shows');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P10: Default/Compact markup parity

  {
    const normalize = html => html.replace(/\s(id|aria-controls|aria-describedby)="[^"]*"/g, '');
    const capture = async settings => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: allTodoist, settings });
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const html = await page.locator('.ws-tdate').evaluate(el => el.outerHTML);
      return { context, html: normalize(html) };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('tasks-provider P10: .ws-tdate draws the same markup in Default and Compact (ids stripped)', async () => {
      assert(def.html === compact.html, `markup differs:\n${def.html}\n${compact.html}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P11: nothing written without a click

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, hash: '#/tasks', patch: allTodoist });
    await check('tasks-provider P11: opening Tasks, Today, a meeting and Settings › Tasks, switching views and rendering never writes', async () => {
      const counts = async () => Promise.all(['task_save', 'task_bulk', 'task_withdraw', 'task_provider_set'].map(op => calls(page, op).then(c => c.length)));
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      assert((await counts()).every(n => n === 0), 'nothing sent yet');
      await page.evaluate(() => window.__workspace.route('today'));
      await settled(page);
      await page.evaluate(() => window.__workspace.route('meetings'));
      await settled(page);
      await page.evaluate(() => window.__workspace.route('tasks'));
      await settled(page);
      await page.click('[data-action="tasks-view"][data-view="list"]');
      await settled(page);
      await page.click('[data-action="tasks-view"][data-view="dates"]');
      await settled(page);
      await page.evaluate(() => window.__workspace.route('settings', 'meetings-tasks'));
      await settled(page);
      await page.evaluate(async () => { for (let i = 0; i < 5; i++) window.__workspace.render(); });
      await settled(page);
      assert((await counts()).every(n => n === 0), `nothing was sent or written: ${JSON.stringify(await counts())}`);
      assert((await calls(page, 'task_sync_now')).length <= 2, 'task_sync_now was asked for too often');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P12: Local untouched (Review Focus 3)

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, meetings: true, hash: '#/meetings/mtg-philips/summary' });
    await check('tasks-provider P12: with no taskProvider, the meeting column, Today’s widget and the Tasks views stay Local’s own', async () => {
      await page.waitForSelector('.ws-mtg-items');
      assert(await page.locator('[data-task="task-endpoint"] [data-action="meeting-item-tick"]').isChecked(), 'task-endpoint ticks itself (mine, sure)');
      assert(/Add 1 to Tasks/.test(await page.locator('[data-action="meeting-items-add"]').innerText()), 'Add 1 to Tasks, not a provider label');
      await page.click('.ws-nav [data-action="route"][data-route="today"]');
      await page.waitForSelector('.ws-commitments');
      const tile = page.locator('.ws-commitments');
      assert(await tile.locator('[data-action="task-delete"]').count() > 0, 'the trash button is still there for Local');
      assert((await tile.locator('.ws-card-actions [data-action="route"][data-route="tasks"]').innerText()).trim() === 'Board', 'the Board button');
      await page.click('.ws-nav [data-action="route"][data-route="tasks"]');
      await page.waitForSelector('.ws-page-tasks .ws-task-board');
      const views = await page.locator('.ws-segmented[aria-label="View"] button').allInnerTexts();
      assert(JSON.stringify(views.map(v => v.trim())) === JSON.stringify(['Board', 'List', 'By date']), JSON.stringify(views));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- P13: quick capture (ask-capture design § 9)
  // ⌘N over the Inbox in both views and both themes at 1000 px: the bar over the page (no shift,
  // nothing sideways), "Task in Todoist", the selected mail as its source, the date read from the
  // words; ⌘↩ adds and stays without sending the touched reply; Enter adds and closes; Undo;
  // Esc clears then closes and gives focus back; a note on Today.

  const captureRow = async (page, settled, view) => {
    if (!(await page.locator('.ws-lane[data-lane="reply"][aria-selected="true"]').count())) {
      await page.click('.ws-lane[data-lane="reply"]');
      await settled(page);
    }
    await page.click('.ws-inbox-row[data-id="m-reply-1"]');
    await settled(page);
    await page.waitForSelector(view === 'compact' ? '.ws-crow-body[data-message-id="m-reply-1"] #reply-body' : '.ws-read[data-message-id="m-reply-1"] #reply-body');
  };
  const sideways = page => page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-capture, .ws-main')].map(el => el.scrollWidth - el.clientWidth)));
  for (const [view, theme] of [['default', 'light'], ['default', 'dark'], ['compact', 'light'], ['compact', 'dark']]) {
    const { page, context, errors } = await open({ theme, width: 1000, height: 800, now: FIXED_NOW, hash: '#/inbox', enable: ['mail_send'], settings: view === 'compact' ? { view: 'compact' } : null, patch: allTodoist });
    await check(`tasks-provider P13: ⌘N over the Inbox, ${view} ${theme} 1000: the bar, its line and the read date; nothing moves or scrolls sideways`, async () => {
      await captureRow(page, settled, view);
      const before = await page.locator('#workspace-page').boundingBox();
      await page.keyboard.press('ControlOrMeta+n');
      await page.waitForSelector('.ws-capture');
      assert(await page.evaluate(() => document.activeElement?.id) === 'capture-input', 'the box takes focus');
      assert((await page.locator('[data-capture-target]').innerText()).trim() === 'Task in Todoist', 'Task in Todoist');
      assert(/^From: Review: Q4 workspace roadmap/.test((await page.locator('[data-capture-source]').innerText()).trim()), await page.locator('[data-capture-source]').innerText());
      await page.keyboard.type('send the deck by fri');
      await page.waitForSelector('[data-capture-due="2026-11-27"]');
      assert(/^Due Fri 27 Nov/.test((await page.locator('[data-capture-due]').innerText()).trim()), 'Due Fri 27 Nov');
      const after = await page.locator('#workspace-page').boundingBox();
      assert(before.y === after.y && before.height === after.height, `the page moved: ${JSON.stringify([before, after])}`);
      const over = await sideways(page);
      assert(over <= 0, `scrolls sideways by ${over}px`);
      await shot(page, `capture-inbox-${view}-${theme}-1000`);
      assert(errors.length === 0, errors.join(' | '));
    });
    if (view === 'default' && theme === 'light') {
      await check('tasks-provider P13: ⌘↩ in the bar adds one task and stays open, never sending the touched reply; Enter adds and closes; Undo deletes it', async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.ws-capture', { state: 'detached' });
        await page.click('#reply-body');
        await page.keyboard.type('Thanks, on it.');
        await page.keyboard.press('ControlOrMeta+n');
        await page.waitForSelector('.ws-capture');
        await page.keyboard.type('send the deck by fri');
        await page.waitForTimeout(200);
        const saves = (await calls(page, 'task_save')).length;
        await page.keyboard.press('ControlOrMeta+Enter');
        await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'task_save').length === n + 1, saves);
        await page.waitForTimeout(400);
        assert((await calls(page, 'action_prepare')).length === 0 && (await calls(page, 'action_confirm')).length === 0, 'the reply was sent');
        assert(await page.locator('.ws-capture').count() === 1 && await page.inputValue('#capture-input') === '', 'the bar stays open and empty');
        assert(await page.inputValue('#reply-body') === 'Thanks, on it.', 'the reply box keeps its words');
        const saved = (await calls(page, 'task_save')).at(-1);
        assert(saved.text === 'send the deck' && saved.due === '2026-11-27' && saved.status === 'todo' && saved.sourceId === 'm-reply-1' && saved.owner, JSON.stringify(saved));
        await page.keyboard.type('Book the room');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.ws-capture', { state: 'detached' });
        await page.waitForSelector('.ws-toast:has-text("Added to Todoist") .ws-toast-action:has-text("Undo")');
        assert((await calls(page, 'task_save')).length === saves + 2, 'Enter added one more');
        await page.locator('.ws-toast:has-text("Added to Todoist") .ws-toast-action').last().click();
        await page.waitForFunction(() => window.__bridgeCalls.some(([op]) => op === 'task_delete'));
        assert((await calls(page, 'task_delete')).length === 1, 'one task_delete');
        assert(errors.length === 0, errors.join(' | '));
      });
      await check('tasks-provider P13: Esc clears the words first, then closes and puts focus back', async () => {
        await page.click('#reply-body');
        await page.keyboard.press('ControlOrMeta+n');
        await page.waitForSelector('.ws-capture');
        await page.keyboard.type('Half a thought');
        await page.keyboard.press('Escape');
        assert(await page.locator('.ws-capture').count() === 1 && await page.inputValue('#capture-input') === '', 'the first Esc clears');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.ws-capture', { state: 'detached' });
        assert(await page.evaluate(() => document.activeElement?.id) === 'reply-body', `focus went to ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)}`);
        assert(await page.locator('.ws-read[data-message-id="m-reply-1"]').count() === 1, 'the message stays open');
        assert(errors.length === 0, errors.join(' | '));
      });
    }
    await context.close().catch(() => {});
  }

  {
    const { page, context, errors } = await open({ theme: 'light', width: 1440, height: 900, now: FIXED_NOW, hash: '#/today', settings: { view: 'compact' }, patch: allTodoist });
    await check('tasks-provider P13: ⌘N on Today, Note: "Adds a line to Notes on Today"; Enter sends one note_append; the line shows in the Notes widget', async () => {
      await page.waitForSelector('#today-note');
      await page.keyboard.press('ControlOrMeta+n');
      await page.waitForSelector('.ws-capture');
      await page.click('[data-capture-mode="note"]');
      await page.waitForSelector('[data-capture-mode="note"][aria-checked="true"]');
      assert((await page.locator('[data-capture-target]').innerText()).trim() === 'Adds a line to Notes on Today', 'the note line');
      await page.click('#capture-input');
      await page.keyboard.type('Ask Marek about the Q1 headcount tomorrow');
      await page.waitForTimeout(250);
      assert(await page.locator('[data-capture-due]').count() === 0, 'a note reads no date');
      await shot(page, 'capture-today-note-compact-light-1440');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ws-capture', { state: 'detached' });
      const appended = await calls(page, 'note_append');
      assert(appended.length === 1 && appended[0].text === 'Ask Marek about the Q1 headcount tomorrow' && !appended[0].sourceId, JSON.stringify(appended));
      assert((await calls(page, 'capture_parse')).length === 0, 'no parse in a note');
      await page.waitForFunction(() => document.getElementById('today-note')?.value.includes('- Ask Marek about the Q1 headcount tomorrow'));
      await page.waitForSelector('.ws-toast:has-text("Added to Notes on Today") .ws-toast-action:has-text("Open")');
      // The choice is kept for the session: ⌘N opens Note again.
      await page.keyboard.press('ControlOrMeta+n');
      await page.waitForSelector('[data-capture-mode="note"][aria-checked="true"]');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
