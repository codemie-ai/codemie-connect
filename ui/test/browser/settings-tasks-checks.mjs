// Browser checks of Settings › Tasks (task-provider design §11, rulings 1, 2, 12, 13, 16), run by
// workspace-e2e.mjs with its MOCKED native bridge: Todoist as the one installed task-plugin
// fixture (workspace-e2e.mjs's own `td`/`todoistView`, named from `taskProvider.available`). The
// unit tests (`ui/test/settings-tasks.test.mjs`) call `ctl.handle` directly, which is exactly what
// missed both Critical review findings (the radio's `data-action` never reaching a real `change`
// event, and `openModal`'s `FormData` losing the clicked submitter) — these checks click the real
// DOM instead.
const SENTINEL = 'tk_SENTINEL_do_not_log_0123456789';
const dialog = '.ws-modal[open]';

/** Local active, Todoist installed and on, one open Local task (so the first choice offers the
 *  copy), nothing offered yet. */
function readyToOffer(snapshot) {
  snapshot.taskProvider = {
    active: 'local', name: 'Connect',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true, pending: 0 }],
    state: 'local', pending: 0, parked: 0, lastSync: null, retryAt: null, message: null, copyOffered: false,
  };
  snapshot.settings.tasks = { provider: 'local', copyOffered: [] };
  // Exactly one open Local task, whatever the fixture's own commitments are.
  snapshot.records = snapshot.records.filter(r => r.kind !== 'commitment');
  snapshot.records.push({ id: 't1', kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r1', updatedAt: 0,
    data: { text: 'Send the pilot user list', status: 'todo', order: 1, history: [{ at: 0, text: 'Added by you' }] } });
}

/** Todoist active, nothing to Check yet (no token). */
function todoistActive(snapshot) {
  snapshot.taskProvider = {
    active: 'plugin:todoist', name: 'Todoist',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true, pending: 0 }],
    state: 'ready', pending: 0, parked: 0, lastSync: null, retryAt: null, message: null, copyOffered: true,
  };
  snapshot.settings.tasks = { provider: 'plugin:todoist', copyOffered: ['plugin:todoist'] };
}

/** Local active, Todoist installed with three unsent changes still queued from before (ruling 16). */
function localWithWaiting(snapshot) {
  snapshot.taskProvider = {
    active: 'local', name: 'Connect',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true, pending: 3 }],
    state: 'local', pending: 0, parked: 0, lastSync: null, retryAt: null, message: null, copyOffered: true,
  };
  snapshot.settings.tasks = { provider: 'local', copyOffered: ['plugin:todoist'] };
}

export async function settingsTasksChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- choosing the radio, the dialog

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: readyToOffer });
    await check('settings-tasks: choosing Todoist by its radio opens the copy dialog; Copy sends copy:true', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      assert(await page.locator('input[name="tasks-provider"]:checked').getAttribute('value') === 'local', 'Local starts checked');
      // The radio: a real `change`, not a click action (Critical 1 — app.js never forwards a
      // radio's data-action, only its data-change).
      await page.click('.ws-ms-radio-card:has(input[value="plugin:todoist"])');
      await page.waitForSelector(`${dialog}:has-text("Copy your open tasks to Todoist?")`);
      const body = await page.locator(`${dialog} .ws-modal-body`).innerText();
      assert(body.includes('Connect has 1 open task.') && body.includes('project'), body);
      await shot(page, 'settings-tasks-dark-copy-dialog');
      await page.click(`${dialog} button:has-text("Copy 1 task")`);
      await page.waitForSelector(dialog, { state: 'detached' });
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'plugin:todoist' && sent.copy === true, JSON.stringify(sent));
      await page.waitForSelector('input[name="tasks-provider"][value="plugin:todoist"]:checked');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: readyToOffer });
    await check('settings-tasks: "Not now" (clicked) sends copy:false and still switches', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      await page.click('.ws-ms-radio-card:has(input[value="plugin:todoist"])');
      await page.waitForSelector(dialog);
      await page.click(`${dialog} button:has-text("Not now")`);
      await page.waitForSelector(dialog, { state: 'detached' });
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'plugin:todoist' && sent.copy === false, JSON.stringify(sent));
      await page.waitForSelector('input[name="tasks-provider"][value="plugin:todoist"]:checked');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: readyToOffer });
    await check('settings-tasks: Return in the dialog picks "Not now" (named risk, review Critical 2)', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      await page.click('.ws-ms-radio-card:has(input[value="plugin:todoist"])');
      await page.waitForSelector(dialog);
      // No input in the dialog: focus starts on its first [type=submit], "Not now".
      assert(await page.evaluate(() => document.activeElement?.textContent.trim()) === 'Not now', 'Not now is not focused');
      await page.keyboard.press('Enter');
      await page.waitForSelector(dialog, { state: 'detached' });
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'plugin:todoist' && sent.copy === false, JSON.stringify(sent));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- the token (ruling 2)

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: todoistActive });
    await check('settings-tasks: saving the token empties the field; the page never holds its value', async () => {
      await page.waitForSelector('[data-provider-secret="token"] input[type=password]');
      await page.fill('[data-provider-secret="token"] input[type=password]', SENTINEL);
      await page.click('[data-provider-secret="token"] [data-action="tasks-provider-secret-save"]');
      await page.waitForSelector('[data-provider-secret="token"]:has-text("Saved on this Mac")');
      const value = await page.locator('[data-provider-secret="token"] input[type=password]').inputValue();
      assert(value === '', `field not cleared: ${value}`);
      const html = await page.content();
      assert(!html.includes(SENTINEL), 'the sentinel reached the page');
      const sent = (await calls(page, 'set_setting')).at(-1);
      assert(sent.id === 'todoist' && sent.key === 'token' && sent.value === SENTINEL, JSON.stringify(sent));
      await shot(page, 'settings-tasks-dark-token-saved');
      // Check now answers with the account (the mock's `task_provider_check` needs a token).
      await page.click('[data-action="tasks-provider-check"]');
      await page.waitForSelector('.ws-inline-note.ws-success:has-text("Connected to Todoist as Taylor Morgan")');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- Local's waiting count (ruling 16)

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: localWithWaiting });
    await check('settings-tasks: Local reads "3 changes wait for Todoist" while it is chosen', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      const text = await page.locator('#ws-tp-state-local').innerText();
      assert(text === '3 changes wait for Todoist.', text);
      await shot(page, 'settings-tasks-dark-waiting');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- the removed-provider toast

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/meetings-tasks', patch: todoistActive });
    await check('settings-tasks: removing the active provider’s plugin switches to Local, with a toast', async () => {
      await page.waitForSelector('.ws-tasks-provider-list');
      assert(await page.locator('input[name="tasks-provider"][value="plugin:todoist"]:checked').count() === 1, 'Todoist starts chosen');
      await page.evaluate(() => { window.__removeTodoist(); window.__emitNative('plugins:reloaded'); });
      await page.waitForSelector('.ws-toast:has-text("Todoist was removed, so tasks are back in Connect.")');
      await page.waitForSelector('input[name="tasks-provider"][value="local"]:checked');
      const sent = (await calls(page, 'task_provider_set')).at(-1);
      assert(sent.provider === 'local', JSON.stringify(sent));
      await settled(page);
      await shot(page, 'settings-tasks-dark-removed');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
