// Browser checks of By date (task provider design §9), run by workspace-e2e.mjs with its MOCKED
// native bridge, Todoist active: every completion leaves its row with "Marked 1 done · Undo" in
// the footer, a folded row has only its done box and an unfolded one at most three controls,
// Nudge fills the reply box and sends nothing, one primary on the page, Late ⋯ acts on the rows
// shown, and the page is drawn again when the day turns.
import { readFileSync } from 'node:fs';
import { FIXED_NOW } from './compact-checks.mjs';

const STATES = JSON.parse(readFileSync(new URL('../fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;

/** Todoist active over the fixture's tasks: Jordan's CSV export a late check-in from Priya's
 *  mail, the export demo (due today) looks handled. */
function todoist(snapshot) {
  snapshot.taskProvider = { ...STATES.ready, lastSync: Math.floor(FIXED_NOW / 1000) - 60 };
  for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
  const task = id => snapshot.records.find(r => r.id === id).data;
  const yesterday = new Date(FIXED_NOW - DAY).toLocaleDateString('sv', { timeZone: snapshot.settings.timeZone });
  Object.assign(task('task-hr'), { kind: 'waiting', due: yesterday, meetingId: null, sourceId: 'm-reply-1' });
  Object.assign(task('task-demo'), { handled: { evidence: 'you replied in Teams 17:32', at: 0, auto: false } });
}

const footer = page => page.locator('.ws-tdate-foot').innerText().then(t => t.replace(/\s+/g, ' ').trim());
/** Visible controls of a row besides its unfold button and done box (menus' panels excluded). */
const controls = (page, id) => page.locator(`.ws-tdate-row[data-task="${id}"]`).evaluate(row => [...row.querySelectorAll('button, summary')]
  .filter(el => !el.classList.contains('ws-tdate-main') && !el.closest('.ws-menu-panel') && el.checkVisibility())
  .map(el => el.textContent.trim() || 'icon'));

export async function tasksDatesChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  for (const view of ['default', 'compact']) {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: todoist, settings: view === 'compact' ? { view: 'compact' } : null });
    await check(`tasks-dates ${view}: completions, row controls, one primary, Nudge`, async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      // One primary: two tasks to review make "Accept all" the page's primary.
      const primaries = await page.locator('.ws-btn-primary').evaluateAll(bs => bs.filter(b => b.checkVisibility()).map(b => b.textContent.trim()));
      assert(primaries.join() === 'Accept all', `primaries: ${primaries}`);
      // A folded row: its done box only.
      for (const id of ['task-legal', 'task-hr', 'task-demo']) assert((await controls(page, id)).length === 0, `${id} folded: ${await controls(page, id)}`);

      // The done box: the row leaves, the footer says so, Undo brings it back.
      await page.click('.ws-tdate-row[data-task="task-legal"] .ws-tdate-box .ws-check-box');
      await page.waitForSelector('.ws-tdate-row[data-task="task-legal"]', { state: 'detached' });
      assert(/Marked 1 done · Undo$/.test(await footer(page)), `footer: ${await footer(page)}`);
      assert(await page.locator('.ws-toast').count() === 0, 'a toast of its own');
      await shot(page, `tasks-dates-${view}-done`);
      await page.click('.ws-tdate-foot [data-action="tasks-undo"]');
      await page.waitForSelector('.ws-tdate-row[data-task="task-legal"]');
      const undo = (await calls(page, 'task_bulk')).at(-1);
      assert(JSON.stringify(undo.items) === JSON.stringify([{ id: 'task-legal', due: undo.items[0].due, status: 'todo' }]) && undo.items[0].due, JSON.stringify(undo));
      assert(!/Undo/.test(await footer(page)), 'Undo used once');

      // Looks handled › Done: the same way out.
      await page.click('.ws-tdate-row[data-task="task-demo"] .ws-tdate-main');
      const handled = await controls(page, 'task-demo');
      assert(handled.join() === 'Done,Keep open,icon', `handled controls: ${handled}`);
      await page.click('.ws-tdate-row[data-task="task-demo"] [data-action="task-handled"][data-act="done"]');
      await page.waitForSelector('.ws-tdate-row[data-task="task-demo"]', { state: 'detached' });
      assert(/Marked 1 done · Undo$/.test(await footer(page)), `footer after handled: ${await footer(page)}`);
      assert(await page.locator('.ws-toast').count() === 0, 'a toast of its own');

      // An unfolded check-in: Nudge, Snooze ▾ (the dates live only there), ⋯.
      await page.click('.ws-tdate-row[data-task="task-hr"] .ws-tdate-main');
      const hr = await controls(page, 'task-hr');
      assert(hr.join() === 'Nudge Jordan,Snooze ▾,icon', `check-in controls: ${hr}`);
      assert(await page.locator('.ws-tdate-row[data-task="task-hr"] .ws-btn-primary').innerText() === 'Nudge Jordan', 'Nudge is the row primary');
      await settled(page);
      await shot(page, `tasks-dates-${view}-check-in`);
      // Nudge: Priya's mail opens with the line in its reply box; nothing is sent.
      await page.click('.ws-tdate-row[data-task="task-hr"] [data-action="task-nudge"]');
      await page.waitForSelector('#reply-body');
      await page.waitForFunction(() => document.getElementById('reply-body').value.startsWith('Hi Jordan'));
      const line = await page.locator('#reply-body').inputValue();
      assert(line === 'Hi Jordan, any news on Ask HR for a user-to-department CSV export?', line);
      assert((await calls(page, 'action_prepare')).length === 0 && (await calls(page, 'action_confirm')).length === 0, 'something was sent');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    // Task 9: the header, Open in Todoist ↗, a withheld refusal, delete with a confirm, Today and
    // the Inbox add with the provider.
    const patch = snapshot => {
      todoist(snapshot);
      const task = id => snapshot.records.find(r => r.id === id).data;
      task('task-legal').remote = { id: '1', url: 'https://app.todoist.com/app/task/1' };
      Object.assign(task('task-tenant'), { pending: true, syncError: '' });
    };
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch });
    await check('tasks-dates provider: header line, ⋯ › Sync now, Open in Todoist ↗ from Connect, a withheld refusal, delete asks first, Today and Inbox', async () => {
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const line = await page.locator('.ws-tasks-line').innerText();
      assert(/^Todoist · synced /.test(line), `status line: ${line}`);
      assert(await page.locator('.ws-tasks-line[role]').count() === 0, 'not a live region');
      const description = await page.locator('.ws-tasks-heading .ws-description').innerText();
      assert(!/Drag cards/.test(description), description);
      assert(await page.locator('.ws-tasks-chip').count() === 0, 'no chip without a meeting');
      // ⋯ › Sync now.
      const syncs = (await calls(page, 'task_sync_now')).length;
      await page.click('[data-menu="tasks-more"] > summary');
      assert(await page.locator('[data-menu="tasks-more"] [data-action="settings-tab"][data-tab="meetings-tasks"]:has-text("Settings › Tasks")').isVisible(), 'Settings › Tasks');
      await shot(page, 'tasks-dates-header-menu');
      await page.click('[data-menu="tasks-more"] [data-action="tasks-sync"]');
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'task_sync_now').length > n, syncs);
      // The window back in front asks for a sync too.
      const focused = (await calls(page, 'task_sync_now')).length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'task_sync_now').length > n, focused);
      // Open in Todoist ↗: the task's own link, straight from Connect (no plugin confirmation).
      await page.click('.ws-tdate-row[data-task="task-legal"] .ws-tdate-main');
      await page.click('.ws-tdate-row[data-task="task-legal"] .ws-tdate-more > summary');
      await page.click('.ws-tdate-row[data-task="task-legal"] [data-action="task-open-remote"]');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'open_source' && d.kind === 'task' && d.id === 'task-legal'));
      assert(await page.locator('.ws-modal[open]').count() === 0, 'no link confirmation');
      // Delete asks first; Cancel deletes nothing.
      await page.click('.ws-tdate-row[data-task="task-legal"] .ws-tdate-more > summary');
      await page.click('.ws-tdate-row[data-task="task-legal"] [data-action="task-delete"]');
      await page.waitForSelector('.ws-modal[open]');
      const ask = (await page.locator('.ws-modal[open] .ws-modal-text').innerText()).trim();
      assert(ask === 'Delete “Send Legal the written legal-hold requirement” in Todoist too? Undo makes it again as a new task.', ask);
      await settled(page);
      await shot(page, 'tasks-dates-delete-confirm');
      await page.click('.ws-modal[open] [data-modal-close]');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      assert((await calls(page, 'task_delete')).length === 0, 'deleted without a yes');
      // A refusal whose sentence was withheld: a plain line, Try again and Discard change.
      await page.click('[data-action="tasks-fold"][data-fold="noDate"]');
      await page.waitForSelector('.ws-tdate-row[data-task="task-tenant"] .ws-tdate-error');
      const refusal = await page.locator('.ws-tdate-row[data-task="task-tenant"] .ws-tdate-error').innerText();
      assert(refusal === 'Todoist refused this change.', refusal);
      await page.click('.ws-tdate-row[data-task="task-tenant"] .ws-tdate-main');
      const parked = await controls(page, 'task-tenant');
      assert(parked.join() === 'Try again,Discard change,icon', `parked controls: ${parked}`);
      await settled(page);
      await shot(page, 'tasks-dates-parked-withheld');
      // Today's Tasks widget: Todoist's tasks, a done box, no trash, "Tasks"; the quick add is Todoist's.
      await page.click('.ws-nav [data-action="route"][data-route="today"]');
      await page.waitForSelector('.ws-commitments');
      const tile = page.locator('.ws-commitments');
      assert(await tile.locator('[data-action="task-delete"]').count() === 0, 'no trash with a provider');
      assert(await tile.locator('[data-action="commitment-toggle"]').count() > 0, 'done boxes');
      assert((await tile.locator('.ws-card-actions [data-action="route"][data-route="tasks"]').innerText()).trim() === 'Tasks', 'the Tasks button');
      // The form sits behind "+ Add task".
      await tile.locator('.ws-task-add > summary').click();
      await tile.locator('[data-form="commitment-add"] [name="text"]').fill('Send the Todoist summary');
      await tile.locator('[data-form="commitment-add"] button[type="submit"]').click();
      await page.waitForSelector('.ws-commitments .ws-todo:has-text("Send the Todoist summary")');
      await tile.scrollIntoViewIfNeeded();
      await settled(page);
      await shot(page, 'tasks-dates-today-widget');
      // Inbox "Add a task": the toast names Todoist.
      await page.click('.ws-nav [data-action="route"][data-route="inbox"]');
      await page.waitForSelector('[data-menu="reply-more"]');
      await page.click('[data-menu="reply-more"] > summary');
      await page.click('[data-menu="reply-more"] [data-action="commitment"]');
      await page.waitForSelector('.ws-modal[open] button[type="submit"]');
      await page.click('.ws-modal[open] button[type="submit"]');
      await page.waitForSelector('.ws-toast:has-text("Added to Todoist")');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  const { page, context, errors } = await open({ theme: 'dark', width: 1000, height: 900, now: FIXED_NOW, tasks: true, hash: '#/tasks', patch: todoist });
  await check('tasks-dates: Late ⋯ moves the rows shown; at midnight the page is drawn again; the footer ends the page below 1100 px', async () => {
    await page.waitForSelector('.ws-tdate[data-provider]');
    const late = await page.locator('.ws-tdate-late .ws-tdate-row').evaluateAll(rows => rows.map(r => r.dataset.task));
    await page.click('[data-menu="tasks-late"] > summary');
    await page.click('[data-menu="tasks-late"] [data-action="tasks-late-move"][data-to="tomorrow"]');
    await page.waitForFunction(() => document.querySelector('.ws-tdate-foot')?.textContent.includes('Moved'));
    const moved = (await calls(page, 'task_bulk')).at(-1).items;
    assert(JSON.stringify(moved.map(i => i.id)) === JSON.stringify(late) && moved.every(i => i.due === '2026-11-19'), JSON.stringify(moved));
    assert(/Moved \d+ to Tomorrow · Undo$/.test(await footer(page)), await footer(page));
    // One column: the footer is the page's last part.
    const last = await page.locator('.ws-tdate').evaluate(el => [...el.children].at(-1).className);
    assert(last === 'ws-tdate-foot', `last part: ${last}`);
    // The day turns: Today's rows are late without a click.
    const todays = await page.locator('.ws-tdate-today .ws-tdate-row').evaluateAll(rows => rows.map(r => r.dataset.task));
    assert(todays.length > 0, 'nothing due today in the fixture');
    // Let the move's own snapshot reload land first, so only the clock can draw the page again.
    await page.clock.runFor(2000);
    await settled(page);
    assert(await page.locator('.ws-tdate-today .ws-tdate-row').count() === todays.length, 'redrawn before midnight');
    await page.clock.setFixedTime(FIXED_NOW + DAY);
    await page.clock.runFor(61_000);
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`.ws-tdate-late [data-task="${id}"]`)), todays, { timeout: 5000 });
    assert(errors.length === 0, errors.join(' | '));
  });
  await context.close().catch(() => {});
}
