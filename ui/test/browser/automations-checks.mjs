// Browser checks of the habit templates and the create-tasks delivery
// (docs/superpowers/specs/2026-11-24-create-tasks-templates-design.md), run by workspace-e2e.mjs
// with its MOCKED native bridge. A1–A9 below: the Templates gallery lists the five new habit
// cards first, the editor's "Tasks in <provider>" switch (on with Todoist, named for Connect
// without a provider, hidden once nothing read gives messages), the backend's "no message"
// refusal shown inline at Deliver, the Formal summary editor (Make, Wishes, no Read/Claude), the
// Budget request reply template's From field, a triage run's made tasks and a summary run's
// meeting link in the Run log, Today's "Made N tasks" line, Default/Compact editor parity, and
// nothing written or sent by rendering alone. `open({ automations: 'habits' })` (task-6-report.md)
// adds the Inbox triage and Formal meeting summary automations and their runs; A2, A4, A6, A7 and
// A8 open with it — the others test the static templates or the editor alone, so it would add
// nothing.
import { readFileSync } from 'node:fs';
import { noClip, FIXED_NOW } from './compact-checks.mjs';

const STATES = JSON.parse(readFileSync(new URL('../fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));

/** Todoist, ready (task-provider-states.json `STATES.ready`): `providerNameOf` then reads "Todoist". */
const todoistReady = snapshot => { snapshot.taskProvider = { ...STATES.ready }; };

/** The default workspace layout (workspace-fixture.mjs) with the `automations` widget pinned to
 *  Today, the way a save that turns Today delivery on would add it (task-6-report.md). */
const WITH_TODAY_CARD = { layout: ['automations', 'brief', 'focus', 'calendar', 'inbox', 'commitments'] };

/** reply-checks.mjs's `noOverflow` pattern, widened (as workspace-e2e.mjs's own copy is) to the
 *  automations editor's dialog body. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - window.innerWidth,
    ...[...document.querySelectorAll('.ws-main, .ws-modal[open] .ws-modal-body')].filter(el => el.clientWidth > 0).map(el => el.scrollWidth - el.clientWidth),
  ));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

const editorOpen = async page => {
  await page.waitForSelector('.ws-modal[open] #automation-editor');
  await page.waitForTimeout(250);
};

/** The visible text of the hint under a Deliver switch (`[data-deliver="<key>"]`'s `<small>`). */
const switchHint = (page, key) => page.locator(`.ws-auto-switch:has([data-deliver="${key}"]) small`).innerText();
const switchLabel = (page, key) => page.locator(`.ws-auto-switch:has([data-deliver="${key}"]) .ws-switch-label`).innerText();

const TASKS_HINT = 'One task per message that needs it. A rerun, or a task you deleted or finished, never makes it again.';
const NO_MESSAGE_REFUSAL = 'Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.';

export async function automationsChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- A1: the Templates gallery, both views, both themes, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context, errors } = await open({ theme, width, height: 900, now: FIXED_NOW, hash: '#/automations/templates', settings: view === 'compact' ? { view: 'compact' } : null });
        await check(`automations A1: ${theme} ${view} ${width}`, async () => {
          await page.waitForSelector('.ws-auto-template');
          await settled(page);
          const ids = await page.locator('.ws-auto-template [data-action="automation-template"]').evaluateAll(els => els.map(el => el.dataset.id));
          assert(JSON.stringify(ids.slice(0, 5)) === JSON.stringify(['morning-brief', 'inbox-triage', 'commitments', 'budget-reply', 'formal-summary']), `the five habit cards first: ${JSON.stringify(ids)}`);
          await noOverflow(page, assert, `${theme} ${view} ${width}`);
          const clipped = await noClip(page);
          assert(clipped.length === 0, clipped.join(' | '));
          await shot(page, `automations-gallery-${theme}-${view}-${width}`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- A2: the editor's Tasks switch, both views, both themes, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const canonical = theme === 'dark' && view === 'default' && width === 1440;
        const { page, context, errors } = await open({ theme, width, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/automations/templates', settings: view === 'compact' ? { view: 'compact' } : null, patch: todoistReady });
        await check(`automations A2: ${theme} ${view} ${width}`, async () => {
          await page.click('[data-action="automation-template"][data-id="inbox-triage"]');
          await editorOpen(page);
          assert(await page.locator('[data-deliver="createTasks"]').isVisible(), 'the Tasks switch is hidden');
          assert(await page.locator('[data-deliver="createTasks"]').isChecked(), 'Tasks in Todoist is not on');
          assert(await switchLabel(page, 'createTasks') === 'Tasks in Todoist', await switchLabel(page, 'createTasks'));
          assert(await switchHint(page, 'createTasks') === TASKS_HINT, await switchHint(page, 'createTasks'));
          await noOverflow(page, assert, `${theme} ${view} ${width} editor`);
          await shot(page, `automations-editor-${theme}-${view}-${width}`);
          assert(errors.length === 0, errors.join(' | '));

          if (canonical) {
            // Unticking "Needs your reply" leaves no read that gives messages: the switch hides
            // (readsMessages(draft) is false), but stays in the form (checked, just hidden).
            await page.click('.ws-check:has([data-read="needsReply"])');
            await page.waitForFunction(() => document.querySelector('[data-deliver="createTasks"]')?.closest('[hidden]'));
            assert(!(await page.locator('[data-deliver="createTasks"]').isVisible()), 'the Tasks switch stayed visible');
            assert(await page.locator('[data-deliver="createTasks"]').isChecked(), 'the hidden switch lost its own checked state');
            await page.click('.ws-modal[open] .ws-modal-footer [data-modal-close]');
            await page.waitForSelector('.ws-modal[open]', { state: 'detached' });

            // A fresh template, saved as it prefills: one automation_save with the Tasks delivery on.
            await page.click('[data-action="dock-tab"][data-tab="auto-templates"]');
            await page.click('[data-action="automation-template"][data-id="inbox-triage"]');
            await editorOpen(page);
            const before = (await calls(page, 'automation_save')).length;
            await page.click('.ws-modal[open] button[type=submit]');
            await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'automation_save').length > n, before);
            const saved = (await calls(page, 'automation_save')).at(-1);
            assert(saved.deliver.createTasks === true && saved.read.needsReply === true && saved.trigger.time === '08:00', JSON.stringify(saved));
          }
        });
        await context.close().catch(() => {});
      }
    }
  }

  {
    // Without a task provider, the switch is named for Connect itself.
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/automations/templates' });
    await check('automations A2: with Local, the switch reads "Tasks in Connect"', async () => {
      await page.click('[data-action="automation-template"][data-id="inbox-triage"]');
      await editorOpen(page);
      assert(await switchLabel(page, 'createTasks') === 'Tasks in Connect', await switchLabel(page, 'createTasks'));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A3: the backend's "no message" refusal, shown at Deliver

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/automations/templates' });
    await check('automations A3: the "Tasks are made from messages…" refusal shows at Deliver, role=alert and aria-invalid', async () => {
      await page.click('[data-action="automation-template"][data-id="morning-brief"]');
      await editorOpen(page);
      await page.evaluate(sentence => { window.__automationDeliverError = sentence; }, NO_MESSAGE_REFUSAL);
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('#auto-deliver[aria-invalid="true"]');
      const sentence = await page.locator('#auto-deliver .ws-field-error[role="alert"]').innerText();
      assert(sentence === NO_MESSAGE_REFUSAL, sentence);
      await page.evaluate(() => { window.__automationDeliverError = null; });
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A4: the Formal summary editor, both themes

  for (const theme of ['dark', 'light']) {
    const { page, context, errors } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/automations/templates' });
    await check(`automations A4 (${theme}): the summary editor shows Make, Wishes, no Read or Claude`, async () => {
      await page.click('[data-action="automation-template"][data-id="formal-summary"]');
      await editorOpen(page);
      assert(await page.locator('#auto-summary').inputValue() === 'formal-summary', 'Make defaults to formal-summary');
      assert(await page.evaluate(() => document.getElementById('auto-summary').selectedOptions[0].textContent) === 'Formal summary', 'Make reads "Formal summary"');
      assert(!(await page.locator('#auto-read').isVisible()), 'Read is visible');
      assert(!(await page.locator('fieldset:has(legend:has-text("Claude"))').isVisible()), 'Claude is visible');
      assert(await page.locator('label[for="auto-prompt"]').innerText() === 'Wishes (optional)', 'no "Instructions" label');
      assert(await page.locator('#auto-prompt').inputValue() === '', 'Wishes is not empty');
      await noOverflow(page, assert, `${theme} summary editor`);
      await shot(page, `automations-summary-${theme}`);
      await page.click('.ws-modal[open] button[type=submit]');
      await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
      const saved = (await calls(page, 'automation_save')).at(-1);
      assert(saved.deliver.meetingSummary === 'formal-summary' && saved.trigger.event === 'meeting_ready', JSON.stringify(saved));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A5: the Budget request reply template's From field

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, hash: '#/automations/templates' });
    await check('automations A5: Budget request reply opens with From focused, keywords "budget", Tasks and Reply draft on', async () => {
      await page.click('[data-action="automation-template"][data-id="budget-reply"]');
      await editorOpen(page);
      assert(await page.evaluate(() => document.activeElement?.id) === 'auto-senders', 'From is not focused');
      assert(await page.locator('.ws-field:has(#auto-senders) .ws-field-label').innerText() === 'From', 'the field is not named From');
      assert(await page.locator('#auto-keywords').inputValue() === 'budget', 'keywords prefilled with "budget"');
      assert(await page.locator('[data-deliver="createTasks"]').isChecked(), 'Tasks is not on');
      assert(await page.locator('[data-deliver="draftReply"]').isChecked(), 'Reply draft is not on');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A6: a triage run's made tasks and a summary run's meeting link

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/automations/runs', settings: view === 'compact' ? { view: 'compact' } : null, patch: todoistReady });
      await check(`automations A6: ${theme} ${view}: the triage run's made tasks and the summary run's meeting link`, async () => {
        await page.waitForSelector('.ws-run-log .ws-run');
        await settled(page);
        // Each run's detail is targeted by its own id (`#run-<id>`, not `.ws-run.ws-open`): both
        // runs stay expanded at once below, which would otherwise make every selector ambiguous.
        await page.click('.ws-run-row:has-text("Inbox triage")');
        await page.waitForSelector('#run-run-triage .ws-run-made');
        const triage = await page.locator('#run-run-triage').innerText();
        assert(triage.includes('Tasks: 2 made in Todoist, 1 already there'), triage);
        assert(triage.includes('Looks handled: 1 task flagged'), triage);
        const links = await page.locator('#run-run-triage .ws-run-made a.ws-run-task').allInnerTexts();
        assert(links.length === 2 && links.some(t => t.includes('Reply to Olga about SOW section 4')) && links.some(t => t.includes('Reply to Marek about the pilot users')), JSON.stringify(links));

        await page.click('.ws-run-row:has-text("Formal meeting summary")');
        await page.waitForSelector('#run-run-summary .ws-run-title');
        const summary = await page.locator('#run-run-summary').innerText();
        assert(summary.includes('Formal summary queued for Daily stand-up'), summary);
        assert((await page.locator('#run-run-summary a.ws-run-task[href="#/meetings/ev-standup/summary"]').innerText()).includes('Open meeting'), 'no Open meeting link');
        await shot(page, `automations-run-${theme}-${view}`);

        await page.locator('#run-run-triage .ws-run-made a.ws-run-task').first().click();
        await page.waitForFunction(() => location.hash === '#/tasks');
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- A7: Today's "Made N tasks" line under Inbox triage's result

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/today', workspace: WITH_TODAY_CARD, patch: todoistReady });
    await check('automations A7: Today shows "Made 2 tasks in Todoist ›" under Inbox triage’s result', async () => {
      await page.waitForSelector('.ws-auto-card .ws-auto-result');
      await settled(page);
      const triage = page.locator('.ws-auto-result:has(.ws-auto-result-name:has-text("Inbox triage"))');
      assert(await triage.count() === 1, 'no Inbox triage result on Today');
      assert((await triage.locator('a.ws-auto-made').innerText()).includes('Made 2 tasks in Todoist ›'), await triage.locator('a.ws-auto-made').innerText());
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A8: Default/Compact editor parity

  {
    const normalize = html => html.replace(/\s(id|aria-controls|aria-describedby)="[^"]*"/g, '');
    const capture = async settings => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', hash: '#/automations', settings, patch: todoistReady });
      await page.waitForSelector('[data-action="automation-edit"][data-id="auto-triage"]');
      await page.click('[data-action="automation-edit"][data-id="auto-triage"]');
      await editorOpen(page);
      const html = await page.locator('#automation-editor').evaluate(el => el.outerHTML);
      return { context, html: normalize(html) };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('automations A8: the editor draws the same markup in Default and Compact (ids stripped)', async () => {
      assert(def.html === compact.html, `editor markup differs:\n${def.html}\n${compact.html}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- A9: nothing written or sent without a click

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, automations: true, hash: '#/automations' });
    await check('automations A9: opening every tab, Today and a run detail, and rendering five times, writes and sends nothing', async () => {
      const counts = async () => Promise.all(['automation_save', 'automation_run_now', 'task_save', 'action_prepare', 'action_confirm'].map(op => calls(page, op).then(c => c.length)));
      await page.waitForSelector('.ws-auto-list, .ws-auto-empty');
      await settled(page);
      assert((await counts()).every(n => n === 0), 'nothing sent yet');
      await page.click('[data-action="dock-tab"][data-tab="auto-runs"]');
      await page.waitForSelector('.ws-run-log .ws-run');
      await page.click('.ws-run-row >> nth=0');
      await page.waitForSelector('.ws-run.ws-open');
      await page.click('[data-action="dock-tab"][data-tab="auto-templates"]');
      await page.waitForSelector('.ws-auto-template');
      await page.evaluate(() => window.__workspace.route('today'));
      await settled(page);
      await page.evaluate(() => window.__workspace.route('automations'));
      await settled(page);
      await page.evaluate(async () => { for (let i = 0; i < 5; i++) window.__workspace.render(); });
      await settled(page);
      assert((await counts()).every(n => n === 0), `nothing was sent or written: ${JSON.stringify(await counts())}`);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
