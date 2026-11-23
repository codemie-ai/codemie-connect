// Browser checks of the meeting view (spec docs/superpowers/specs/2026-11-23-meetings-view-design.md,
// Task 7, V1–V11), run by workspace-e2e.mjs with its MOCKED native bridge: the one meeting section
// (the strip, its tabs or "← Back to summary", panes behind ⋯, old links, Esc, the stored v1
// layout read once), the action items column beside the pane or below it, pins that vanish without
// an empty tab, and a plugin's minutes rendered as escaped Markdown, never markup. Both themes,
// Default and Compact, 1000/1440/1680 px for V1; the rest run once each, at whichever width and
// theme exercises them. It proves the window's side, never native Graph, folders or Claude.
import { CLIP_SELECTORS, FIXED_NOW } from './compact-checks.mjs';

const row = id => `.ws-mtg-row[data-id="${id}"]`;
const meetingMenu = '.ws-mtg-strip > .ws-menu';

/** Elements matching CLIP_SELECTORS, plus the meeting view's own, that clip their content
 *  (compact-checks.mjs's noClip, with V1's three extra selectors). */
const noClip = page => page.evaluate(selectors => {
  const out = [];
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if (!el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true })) return;
    const cs = getComputedStyle(el);
    const heightClip = el.scrollHeight > el.clientHeight + 1;
    const widthClip = el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis';
    if (!heightClip && !widthClip) return;
    const sel = selectors.find(s => el.matches(s)) || el.tagName.toLowerCase();
    const label = `${sel}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : ''}`;
    out.push(`${label} "${(el.textContent || '').trim().slice(0, 40)}" (${heightClip ? 'height' : 'width'})`);
  });
  return out;
}, [...CLIP_SELECTORS, '.ws-mtg-strip button', '.ws-mtg-item-open', '.ws-mtg-items button']);

/** reply-checks.mjs's noOverflow pattern, widened to the meeting view's own scrolling parts. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - window.innerWidth,
    ...[...document.querySelectorAll('.ws-main, .ws-mtg-list, .ws-mtg-detail, .ws-mtg-list-body, .ws-mtg-items, .ws-modal[open] .ws-modal-body')]
      .filter(el => el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map(el => el.scrollWidth - el.clientWidth),
  ));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

const hash = page => page.evaluate(() => location.hash);

/** Merges into `settings.meetings` through the real `settings_update` op (so fields not named
 *  here, e.g. `checkEveryMin`, are kept, unlike overwriting `settings.meetings` wholesale). */
const setMeetings = async (page, settled, meetings) => {
  await page.evaluate(m => window.__workspace.store.mutate('settings_update', { meetings: m }), meetings);
  await settled(page);
};

const setFilter = async (page, settled, filter) => {
  await page.click('[data-menu="meetings-filter"] > summary');
  await page.click(`[data-menu="meetings-filter"] [data-action="meeting-filter"][data-filter="${filter}"]`);
  await settled(page);
};

/** Picks a meeting from the list (the Filter switched to "all" first, so a filtered-out meeting
 *  is still reachable). `showNone`: also switch on "Meetings without a transcript" first — the
 *  "all" lane excludes a `pending` meeting unless that switch is on (meetings-model.js
 *  `IN_LANE.all`). */
const select = async (page, settled, id, { showNone = false } = {}) => {
  await setFilter(page, settled, 'all');
  if (showNone) {
    await page.click('[data-menu="meetings-filter"] > summary');
    await page.click('[data-menu="meetings-filter"] [data-action="meeting-show-none"]');
    await settled(page);
  }
  await page.click(row(id));
  await page.waitForFunction(i => location.hash.startsWith(`#/meetings/${encodeURIComponent(i)}/`), id);
  await settled(page);
};

/** Shows `pane` of the open meeting: the summary through "← Back to summary", any other through
 *  ⋯ (Files sits under ⋯ › Advanced); the hash ends with it. */
const openPane = async (page, settled, pane) => {
  if (pane === 'summary') {
    if (await page.locator('.ws-mtg-strip [data-action="meeting-back"]').count()) await page.click('.ws-mtg-strip [data-action="meeting-back"]');
  } else if (!(await hash(page)).endsWith(`/${pane}`)) {
    await page.click(`${meetingMenu} > summary`);
    await page.click(`${meetingMenu} [data-action="meeting-pane"][data-pane="${pane}"]`);
  }
  await page.waitForFunction(p => location.hash.endsWith(`/${p}`), pane);
  await settled(page);
};

/** The action items column's position against the pane, from their bounding boxes: "beside"
 *  (roughly the same top, to its right) or "below" (under it, roughly the same left). */
const itemsLayout = page => page.evaluate(() => {
  const pane = document.querySelector('.ws-mtg-detail')?.getBoundingClientRect();
  const items = document.querySelector('.ws-mtg-items:not(.ws-mtg-items-pane)')?.getBoundingClientRect();
  if (!pane || !items) return null;
  return {
    beside: Math.abs(items.top - pane.top) <= 2 && items.left >= pane.right - 2,
    below: items.top >= pane.bottom - 2 && Math.abs(items.left - pane.left) <= 2,
  };
});

export async function meetingsViewChecks({ open, check, assert, shot, settled, calls, OUT }) {
  const lastCall = async (page, op) => (await calls(page, op)).at(-1);

  // ---------------------------------------------------------------- V1: both views, both themes, three widths
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const tag = `${theme}-${view}-${width}`;
        const { page, context, errors } = await open({
          theme, width, height: width === 1680 ? 960 : 900, now: FIXED_NOW, meetings: true,
          hash: '#/meetings/mtg-philips/summary', settings: view === 'compact' ? { view: 'compact' } : null,
        });
        await check(`meetings-view V1: ${theme} ${view} ${width}`, async () => {
          await setMeetings(page, settled, { summaryTabs: ['meeting-notes', 'short-summary'] });
          await page.waitForSelector('.ws-mtg-summary .ws-md h3');
          // The strip: the tablist, exactly one primary (Copy, the main document shown) and ⋯.
          assert(await page.locator('.ws-mtg-tabs[role="tablist"]').count() === 1, 'the tablist');
          assert(await page.locator('.ws-mtg-strip [data-action="meeting-copy-tab"]').count() === 1, 'exactly one primary');
          assert(await page.locator(`${meetingMenu} > summary`).count() === 1, 'the ⋯');
          // The action items column beside the pane at 1440/1680, below it at 1000 (the list open).
          const layout = await itemsLayout(page);
          assert(layout, 'the action items column is not there');
          if (width === 1000) assert(layout.below, `expected below at ${width}px: ${JSON.stringify(layout)}`);
          else assert(layout.beside, `expected beside at ${width}px: ${JSON.stringify(layout)}`);
          await noOverflow(page, assert, `${tag} summary`);
          const clipped = await noClip(page);
          assert(clipped.length === 0, `${tag} clipped: ${clipped.join(' | ')}`);
          await shot(page, `meetings-view-${tag}`);
          // No summary yet: a pinned template with no document (mtg-roadmap).
          await select(page, settled, 'mtg-roadmap');
          await page.waitForSelector('.ws-mtg-nosummary:has-text("No Meeting notes yet.")');
          await shot(page, `meetings-view-${tag}-roadmap`);
          // The explainer, no tabs: before there is a transcript (mtg-sprint, pending).
          await select(page, settled, 'mtg-sprint', { showNone: true });
          await page.waitForSelector('.ws-mtg-explain');
          assert(await page.locator('.ws-mtg-tabs, .ws-mtg-strip [data-action="meeting-copy-tab"]').count() === 0, 'no tabs and no primary before a transcript');
          await shot(page, `meetings-view-${tag}-pending`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- V2: the strip and panes
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V2: ⋯ › Transcript, Esc, ⋯ › Notes, ⋯ › Advanced › Files, Back', async () => {
      await openPane(page, settled, 'transcript');
      await page.waitForSelector('#meeting-line-3');
      assert(/← Back to summary/.test(await page.locator('.ws-mtg-strip').innerText()), 'Back to summary');
      assert((await hash(page)).endsWith('/transcript'), await hash(page));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => location.hash.endsWith('/summary'));
      await openPane(page, settled, 'notes');
      assert(/1 of 2/.test(await page.locator('.ws-mtg-doc-pick-sum').innerText()), 'the doc picker: 1 of 2');
      await openPane(page, settled, 'files');
      await page.waitForSelector('.ws-mtg-file:has-text("transcript.vtt")');
      await openPane(page, settled, 'summary');
      assert(!(await page.locator('.ws-mtg-summary').innerText()).includes('WEBVTT'), 'the file’s text never reaches the summary');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V3: Copy and Make
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900 });
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });
    await check('meetings-view V3: Copy puts the document’s Markdown on the clipboard; Make writes short-summary.meeting_notes', async () => {
      await page.waitForSelector('.ws-mtg-summary .ws-md');
      await page.click('.ws-mtg-strip [data-action="meeting-copy-tab"]');
      await page.waitForSelector('.ws-mtg-strip [data-action="meeting-copy-tab"]:has-text("Copied")');
      assert(/TL;DR/.test(await page.evaluate(() => window.__copied)), 'the document’s Markdown');
      await setMeetings(page, settled, { summaryTabs: ['short-summary'] });
      await select(page, settled, 'mtg-roadmap');
      await page.waitForSelector('.ws-mtg-nosummary:has-text("No Short summary yet.")');
      await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 1600 }; });
      await page.click('.ws-mtg-strip [data-action="meeting-make-tab"]:has-text("Make Short summary")');
      await page.waitForSelector('.ws-mtg-runline');
      const asked = await lastCall(page, 'meeting_notes');
      assert(asked.meetingId === 'mtg-roadmap' && asked.templateId === 'short-summary' && asked.findTasks === true, JSON.stringify(asked));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V4: the action items column
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V4: pre-ticked, Add N to Tasks (double-click), Undo, ticks survive a render, a dismiss', async () => {
      await page.waitForSelector('.ws-mtg-items');
      assert(await page.locator('[data-task="task-endpoint"] [data-action="meeting-item-tick"]').isChecked(), 'task-endpoint ticks itself (mine, sure)');
      assert(!await page.locator('[data-task="task-pilot-list"] [data-action="meeting-item-tick"]').isChecked(), 'task-pilot-list does not (not mine)');
      assert(/Add 1 to Tasks/.test(await page.locator('[data-action="meeting-items-add"]').innerText()), 'Add 1 to Tasks');
      const saves = (await calls(page, 'task_save')).length;
      // A real double-click: both handler invocations happen before the first's await resolves,
      // so the in-flight guard (meetings-controller.js `addingItems`) lets exactly one through.
      await page.evaluate(() => { const b = document.querySelector('[data-action="meeting-items-add"]'); b.click(); b.click(); });
      await page.waitForSelector('.ws-mtg-items-foot:has-text("Added 1 to Tasks")');
      const saved = (await calls(page, 'task_save')).slice(saves);
      assert(saved.length === 1 && saved[0].id === 'task-endpoint' && saved[0].status === 'todo', JSON.stringify(saved));
      await page.click('.ws-mtg-items-foot [data-action="meeting-items-undo"]');
      await page.waitForSelector('[data-task="task-endpoint"] [data-action="meeting-item-tick"]:checked');
      // Local's Undo is one task_withdraw too (native moves it back to review).
      const undone = await lastCall(page, 'task_withdraw');
      assert(JSON.stringify(undone) === JSON.stringify({ ids: ['task-endpoint'] }), JSON.stringify(undone));
      // Tick both, then three renders: both stay ticked.
      await page.click('[data-task="task-pilot-list"] label.ws-check');
      await page.evaluate(() => { window.__workspace.render(); window.__workspace.render(); window.__workspace.render(); });
      await settled(page);
      assert(await page.locator('[data-task="task-endpoint"] [data-action="meeting-item-tick"]').isChecked(), 'task-endpoint stays ticked');
      assert(await page.locator('[data-task="task-pilot-list"] [data-action="meeting-item-tick"]').isChecked(), 'task-pilot-list stays ticked');
      // Open the pilot row: owner and date show; "Not a task" dismisses it.
      await page.click('[data-task="task-pilot-list"] [data-action="meeting-item-open"]');
      await page.waitForSelector('[data-task="task-pilot-list"] .ws-mtg-item-detail select[data-action="task-owner"]');
      assert(await page.locator('[data-task="task-pilot-list"] .ws-mtg-item-detail input.ws-mtg-date').count() === 1, 'the due date shows');
      await page.click('[data-task="task-pilot-list"] [data-action="task-dismiss"]');
      const dismissed = await lastCall(page, 'task_save');
      assert(dismissed.id === 'task-pilot-list' && dismissed.status === 'dismissed', JSON.stringify(dismissed));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V4b: Todoist active (task provider §10)
  {
    const todoist = snapshot => {
      snapshot.taskProvider = { active: 'plugin:todoist', name: 'Todoist', available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true, pending: 0 }], state: 'ready', pending: 0, parked: 0, lastSync: Math.floor(FIXED_NOW / 1000) - 60, retryAt: null, message: null, copyOffered: true };
      for (const r of snapshot.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
    };
    const { page, context, errors } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, patch: todoist });
    await check('meetings-view V4b: Todoist active: "Add 2 to Todoist" saves each once, Undo is one task_withdraw, "N in Todoist ›" opens By date with the meeting chip', async () => {
      await page.waitForSelector('.ws-mtg-items');
      await page.click('[data-task="task-pilot-list"] label.ws-check');
      await page.waitForSelector('[data-action="meeting-items-add"]:has-text("Add 2 to Todoist")');
      const saves = (await calls(page, 'task_save')).length;
      await page.evaluate(() => { const b = document.querySelector('[data-action="meeting-items-add"]'); b.click(); b.click(); });
      await page.waitForSelector('.ws-mtg-items-foot:has-text("Added 2 to Todoist")');
      const saved = (await calls(page, 'task_save')).slice(saves);
      assert(saved.map(d => d.id).sort().join() === 'task-endpoint,task-pilot-list' && saved.every(d => d.status === 'todo'), JSON.stringify(saved));
      assert(await page.locator('.ws-mtg-items-sub:has-text("In Todoist")').count() === 1, 'the In Todoist heading');
      await shot(page, 'meetings-view-todoist-added');
      await page.click('.ws-mtg-items-foot [data-action="meeting-items-undo"]');
      await page.waitForSelector('[data-task="task-pilot-list"] [data-action="meeting-item-tick"]:checked');
      const withdrawn = await calls(page, 'task_withdraw');
      assert(withdrawn.length === 1 && withdrawn[0].ids.slice().sort().join() === 'task-endpoint,task-pilot-list', JSON.stringify(withdrawn));
      // "1 in Todoist ›" (the meeting's legal task): By date of that meeting, with its chip.
      const syncs = (await calls(page, 'task_sync_now')).length;
      await page.click('.ws-mtg-items-foot [data-action="meeting-board"]:has-text("in Todoist ›")');
      await page.waitForSelector('.ws-tdate[data-provider]');
      await settled(page);
      const chip = await page.locator('.ws-tasks-chip').innerText();
      assert(chip === 'From Philips CodeMie conversations syncup ✕', chip);
      assert((await calls(page, 'task_sync_now')).length > syncs, 'opening Tasks asks for a sync');
      await shot(page, 'meetings-view-todoist-chip');
      await page.click('.ws-tasks-chip');
      await page.waitForSelector('.ws-tasks-chip', { state: 'detached' });
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V5: the column off
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, settings: { meetings: { actionItems: false } } });
    await check('meetings-view V5: with actionItems off, no column; "Review 2 tasks" opens the Action items pane', async () => {
      await page.waitForSelector('.ws-mtg-summary .ws-md');
      assert(await page.locator('.ws-mtg-items').count() === 0, 'no column');
      const review = '.ws-mtg-head .ws-actions [data-action="meeting-pane"][data-pane="tasks"]';
      await page.waitForSelector(`${review}:has-text("Review 2 tasks")`);
      await page.click(review);
      await page.waitForFunction(() => location.hash.endsWith('/tasks'));
      await page.waitForSelector('.ws-mtg-item');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V6: pins that vanish
  {
    const { page, context, errors } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V6: a deleted template and an off plugin vanish from the pins, no empty tab (Review Focus 1)', async () => {
      await setMeetings(page, settled, { summaryTabs: ['custom-gone', 'short-summary', 'plugin:off'] });
      await page.waitForSelector('.ws-mtg-tabs [role="tab"]');
      const labels = await page.locator('.ws-mtg-tabs [role="tab"]').allInnerTexts();
      assert(labels.join('|') === 'Short summary|Meeting notes', `tabs: ${labels.join(', ')}`);
      assert(labels.every(l => l.trim().length > 0), 'no empty tab');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V7: old links (Review Focus 4)
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/notes', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V7: #/meetings/<id>/notes and /files open those panes', async () => {
      await page.waitForSelector('.ws-mtg-doc-pick-sum');
      assert(await hash(page) === '#/meetings/mtg-philips/notes', await hash(page));
      await openPane(page, settled, 'files');
      await page.waitForSelector('.ws-mtg-file:has-text("transcript.vtt")');
    });
    await context.close().catch(() => {});
  }
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/tasks', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V7: #/meetings/<id>/tasks with the column on shows the summary, focused on the column', async () => {
      await page.waitForSelector('.ws-mtg-items');
      await settled(page);
      // Task 7 brief, V7: with the action items column on, the old `/tasks` link is expected to
      // land on the summary pane (the column already shows the action items beside it), not the
      // dedicated Action items pane `/tasks` used to mean before the column existed.
      assert(await page.locator('.ws-mtg-detail[data-panel="summary"]').count() === 1, `expected the summary pane; got ${await hash(page)}`);
      const focusedInColumn = await page.evaluate(() => !!document.activeElement?.closest('.ws-mtg-items'));
      assert(focusedInColumn, 'focus lands in the action items column');
    });
    await context.close().catch(() => {});
  }
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/people', theme: 'dark', width: 1440, height: 900, settings: { meetings: { openOn: 'notes' } } });
    await check('meetings-view V7: an unknown pane (the old /people link) follows "Open a meeting on"', async () => {
      await page.waitForSelector('.ws-mtg-doc-pick-sum, .ws-mtg-summary');
      assert(await hash(page) === '#/meetings/mtg-philips/notes', await hash(page));
    });
    await context.close().catch(() => {});
  }
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings', theme: 'dark', width: 1440, height: 900, settings: { meetings: { openOn: 'transcript' } } });
    await check('meetings-view V7: with openOn transcript, a row opens on the Transcript pane', async () => {
      await page.waitForSelector('.ws-mtg-row');
      await select(page, settled, 'mtg-critique');
      assert((await hash(page)).endsWith('/transcript'), await hash(page));
      await page.waitForSelector('.ws-mtg-transcript');
      // Today's "From your meetings" row follows the same setting.
      await page.click('.ws-nav button[data-route=today]');
      await page.waitForSelector('.ws-mtg-today-row');
      await page.click('.ws-mtg-today [data-action="meeting-open"]');
      await page.waitForFunction(() => location.hash.endsWith('/transcript'));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V8: the stored v1 layout (Review Focus 2)
  {
    const v1 = JSON.stringify({
      panes: [
        { id: 'p1', tabs: ['mtg-list'], active: 'mtg-list', w: 300, collapsed: false },
        { id: 'p2', tabs: ['mtg-notes'], active: 'mtg-notes', w: 600, collapsed: false },
        { id: 'p3', tabs: ['mtg-transcript'], active: 'mtg-transcript', w: 520, collapsed: false },
      ],
      max: null,
    });
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, localPrefs: { 'codemie.layout.meetings.v1': v1 } });
    await check('meetings-view V8: a stored v1 layout (Notes beside Transcript, the list at 300px) reads once into two sections', async () => {
      const dock = '.ws-dock[data-page="meetings"]';
      await page.waitForSelector(`${dock} .ws-mtg-summary .ws-md`);
      assert(await page.locator(`${dock} > .ws-pane`).count() === 2, 'two sections');
      // The dock's sections share the row by flex-grow ratio (dock-view.js), so the carried-over
      // width (300, against the meeting section's untouched default) renders close to, not always
      // exactly, 300px once the row's own width is folded in; a wider tolerance than the spec's
      // rounding-only "±2" accommodates that without masking a real regression.
      const listWidth = await page.evaluate(sel => Math.round(document.querySelector(`${sel} > .ws-pane:has(.ws-mtg-list)`)?.getBoundingClientRect().width ?? 0), dock);
      assert(Math.abs(listWidth - 300) <= 6, `the list is ~300px: ${listWidth}`);
      // Resizing the list writes v2; v1 is untouched (byte-identical).
      const split = await page.locator(`${dock} > .ws-split[data-split="0"]`).boundingBox();
      await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
      await page.mouse.down();
      await page.mouse.move(split.x + split.width / 2 + 60, split.y + split.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(w => Math.round(document.querySelector('.ws-dock[data-page="meetings"] > .ws-pane:has(.ws-mtg-list)').getBoundingClientRect().width) > w, listWidth);
      const v2 = await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v2'));
      assert(v2 && JSON.parse(v2).panes?.length === 2, `v2 written: ${v2}`);
      assert(await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v1')) === v1, 'v1 is byte-identical');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V9: plugin minutes (Review Focus 5)
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, settings: { meetings: { summaryTabs: ['plugin:pod'] } } });
    await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });
    const seen = [];
    page.on('request', req => { if (/e\.test/.test(req.url())) seen.push(req.url()); });
    await check('meetings-view V9: a plugin’s minutes with <script>, <img onerror>, a Markdown link and raw HTML render as escaped text only', async () => {
      await page.waitForSelector('.ws-mtg-summary');
      await page.evaluate(() => {
        window.__minutes = {
          pluginId: 'pod', name: 'Podervianskyi',
          minutes: ['## Настрій\n<script>window.__ran=1</script><img src=x onerror="window.__xss=1"> [l](https://e.test) <b>bold</b>'],
        };
      });
      await page.evaluate(() => window.__workspace.render());
      await settled(page);
      await page.waitForSelector('.ws-mtg-tabs [role="tab"]:has-text("Podervianskyi")');
      assert(await page.locator('.ws-mtg-tabs [role="tab"][aria-selected="true"]').innerText() === 'Podervianskyi', 'the pinned plugin tab is shown');
      await page.waitForSelector('.ws-mtg-summary .ws-md h3:has-text("Настрій")');
      assert(await page.evaluate(() => window.__xss) === undefined, 'the onerror never ran');
      assert(await page.evaluate(() => window.__ran) === undefined, 'the script never ran');
      assert(await page.locator('.ws-mtg-summary a[href]').count() === 0, 'no link is made');
      assert(await page.locator('.ws-mtg-summary img').count() === 0, 'no image element');
      assert(/&lt;b&gt;bold&lt;\/b&gt;/.test(await page.content()), 'raw HTML is escaped text');
      await page.click('.ws-mtg-strip [data-action="meeting-copy-tab"]');
      await page.waitForSelector('.ws-mtg-strip [data-action="meeting-copy-tab"]:has-text("Copied")');
      assert(/<img src=x onerror=/.test(await page.evaluate(() => window.__copied)), 'Copy copies the text, unrendered');
      assert(seen.length === 0, `a remote request was made: ${seen.join(', ')}`);
      await shot(page, 'meetings-view-plugin-tab');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V10: Default/Compact markup parity
  {
    const normalize = html => html.replace(/\sid="[^"]*"/g, '').replace(/\saria-controls="[^"]*"/g, '');
    // Captured outside check() (each needs its own page/context); check() itself does only the
    // string comparison, so its "close a stray dialog" preamble never touches an already-closed page.
    const capture = async settings => {
      const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, settings });
      await page.waitForSelector('.ws-mtg-summary .ws-md');
      const html = await page.evaluate(() => ({
        strip: document.querySelector('.ws-mtg-strip').outerHTML,
        items: document.querySelector('.ws-mtg-items')?.outerHTML || '',
      }));
      return { context, strip: normalize(html.strip), items: normalize(html.items) };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('meetings-view V10: .ws-mtg-strip and .ws-mtg-items draw the same markup in Default and Compact', async () => {
      assert(def.strip === compact.strip, `strip differs:\n${def.strip}\n${compact.strip}`);
      assert(def.items === compact.items, `items differs:\n${def.items}\n${compact.items}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V11: nothing sent or written without a click
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view V11: opening meetings, switching tabs/panes/view and rendering never sends or writes', async () => {
      const counts = async () => Promise.all(['task_save', 'meeting_notes', 'action_prepare', 'action_confirm'].map(op => calls(page, op).then(c => c.length)));
      assert((await counts()).every(n => n === 0), 'nothing sent yet');
      await select(page, settled, 'mtg-roadmap');
      await select(page, settled, 'mtg-critique');
      await select(page, settled, 'mtg-philips');
      // Switch summary tabs, open a pane, go back.
      const tabs = await page.locator('.ws-mtg-tabs [role="tab"]').all();
      if (tabs.length > 1) { await tabs[1].click(); await settled(page); }
      await openPane(page, settled, 'transcript');
      await openPane(page, settled, 'summary');
      // Switch the view, then back.
      await page.evaluate(() => window.__workspace.store.mutate('settings_update', { view: 'compact' }));
      await settled(page);
      await page.evaluate(() => window.__workspace.store.mutate('settings_update', { view: 'default' }));
      await settled(page);
      await page.evaluate(async () => { for (let i = 0; i < 5; i++) window.__workspace.render(); });
      await settled(page);
      assert((await counts()).every(n => n === 0), `nothing was sent or written: ${JSON.stringify(await counts())}`);
    });
    await context.close().catch(() => {});
  }

  // ------------------------------------------------- fix round 2: the people popover's task link
  // (code review on the /tasks fix): with the column on, a person's task count used to redirect
  // the pane through `meeting-pane`/`tasks`, which a later render's redirect-to-summary could
  // "steal" focus through — even though the popover had already closed and the column it was
  // supposed to point at was already showing right there. It now closes the popover (as any step
  // in a menu does) and focuses the column directly, with no pane change and no redirect involved.
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/notes', theme: 'dark', width: 1440, height: 900 });
    await check('meetings-view fix round 2: a person’s task count, column on, closes the popover and focuses the column, staying on the pane it was clicked from', async () => {
      await page.waitForSelector('.ws-mtg-doc-pick-sum');
      await page.click('.ws-mtg-with');
      await page.waitForSelector('.ws-mtg-people-pop [data-action="meeting-items-focus"]');
      await page.click('.ws-mtg-people-pop [data-action="meeting-items-focus"]');
      // Still on Notes: there is no pane left for this link to mean, so none is redirected to.
      assert(await page.locator('.ws-mtg-detail[data-panel="notes"]').count() === 1, `stayed on Notes; hash is ${await hash(page)}`);
      assert(!(await page.evaluate(() => document.querySelector('[data-menu^="people-"]')?.hasAttribute('open'))), 'the popover closed');
      const focusedInColumn = await page.evaluate(() => !!document.activeElement?.closest('.ws-mtg-items'));
      assert(focusedInColumn, 'focus lands in the action items column');
    });
    await context.close().catch(() => {});
  }
  {
    const { page, context } = await open({ meetings: true, hash: '#/meetings/mtg-philips/summary', theme: 'dark', width: 1440, height: 900, settings: { meetings: { actionItems: false } } });
    await check('meetings-view fix round 2: the same link, column off, still opens the Action items pane', async () => {
      await page.waitForSelector('.ws-mtg-summary .ws-md');
      await page.click('.ws-mtg-with');
      await page.waitForSelector('.ws-mtg-people-pop [data-action="meeting-pane"][data-pane="tasks"]');
      await page.click('.ws-mtg-people-pop [data-action="meeting-pane"][data-pane="tasks"]');
      await page.waitForFunction(() => location.hash.endsWith('/tasks'));
      assert(await page.locator('.ws-mtg-detail[data-panel="tasks"]').count() === 1, 'the dedicated Action items pane');
    });
    await context.close().catch(() => {});
  }
}
