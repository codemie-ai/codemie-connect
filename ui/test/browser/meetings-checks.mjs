// Browser checks of the Meetings page, the calendar's transcript badges and Today's "From your
// meetings" card (spec "Meetings page", Task 4; the calmer page, 2026-11-19-meetings-calm), run by
// workspace-e2e.mjs with its MOCKED native
// bridge: the fixture's meetings in every state (withMeetings), what `meeting_read` answers for
// their folders (meetingFolders), and checks, saves and notes runs the mock carries out. Both
// themes; 1440, 1000 and 1680 px; no horizontal overflow on any screen. It proves the window's
// side, never native Graph, folders or Claude.
const dialog = '.ws-modal[open]';
const submit = `${dialog} .ws-modal-footer button[type=submit]`;
const row = id => `.ws-mtg-row[data-id="${id}"]`;
const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Hannah Lee>Thanks for joining. Let’s go through the partnership terms.</v>

00:00:05.000 --> 00:00:09.000
<v Speaker 2>I can share the pricing sheet tomorrow. <script>window.__xss=1</script></v>

00:00:10.000 --> 00:00:14.000
<v Taylor Morgan>Great, I’ll send the draft agreement on Friday.</v>
`;

export async function meetingChecks({ open, check, assert, shot, settled, OUT }) {
  const calls = async (page, op) => (await page.evaluate(() => window.__bridgeCalls)).filter(([o]) => o === op).map(([, d]) => d);
  const lastCall = async (page, op) => (await calls(page, op)).at(-1);
  const noOverflow = async (page, what) => {
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-main, .ws-mtg-list, .ws-mtg-detail, .ws-mtg-list-body, .ws-mtg-items, .ws-modal[open] .ws-modal-body, .ws-mtg-legend')].filter(el => el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden').map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `${what} overflows by ${overflow}px`);
  };
  /** The meeting's header and strip fit the section they sit in: the title row's actions, the
   *  strip's tabs, primary and ⋯, and the line with when and "with …" end inside it. */
  const headerFits = async (page, what) => {
    const fit = await page.evaluate(() => {
      const top = document.querySelector('.ws-dock[data-page="meetings"] .ws-mtg-meeting-section');
      const pane = top.closest('.ws-pane').getBoundingClientRect();
      const out = el => { const r = el.getBoundingClientRect(); return r.left < pane.left || r.right > pane.right - 1; };
      const name = el => el.textContent.trim() || el.querySelector('[aria-label]')?.getAttribute('aria-label') || el.tagName;
      const actions = [...top.querySelectorAll('.ws-mtg-head-title .ws-actions > *, .ws-mtg-strip > :not(.ws-spacer)')];
      const meta = top.querySelector('.ws-mtg-meta');
      return {
        pane: Math.round(pane.width),
        actions: actions.map(name),
        outside: actions.filter(out).map(name),
        meta: !!meta && out(meta),
      };
    });
    assert(fit.actions.length && !fit.outside.length, `${what}: the header's actions leave the section ${JSON.stringify(fit)}`);
    assert(fit.meta === false, `${what}: when and the people leave the section ${JSON.stringify(fit)}`);
    return fit;
  };
  const hash = page => page.evaluate(() => location.hash);
  /** A screenshot once a dialog has finished opening (its fade-in is 160 ms). */
  const dialogShot = async (page, name) => {
    await page.waitForTimeout(300);
    await shot(page, name);
  };
  /** Picks a filter from the list's Filter menu (All meetings, Needs you, With notes, Coming up). */
  const setFilter = async (page, filter) => {
    await page.click('[data-menu="meetings-filter"] > summary');
    await page.click(`[data-menu="meetings-filter"] [data-action="meeting-filter"][data-filter="${filter}"]`);
    await settled(page);
  };
  /** A switch of the Filter menu (Meetings without a transcript, Hidden meetings). */
  const filterSwitch = async (page, action) => {
    await page.click('[data-menu="meetings-filter"] > summary');
    await page.click(`[data-menu="meetings-filter"] [data-action="${action}"]`);
    await settled(page);
  };
  /** The meeting's ⋯ menu, at the end of the strip. */
  const meetingMenu = '.ws-mtg-strip > .ws-menu';
  /** Shows the meeting's `pane`: the summary through "← Back to summary", any other through ⋯
   *  (Files sits under ⋯ › Advanced); the hash ends with it. */
  const openPane = async (page, pane) => {
    if (pane === 'summary') {
      if (await page.locator('.ws-mtg-strip [data-action="meeting-back"]').count()) await page.click('.ws-mtg-strip [data-action="meeting-back"]');
    } else if (!(await hash(page)).endsWith(`/${pane}`)) {
      await page.click(`${meetingMenu} > summary`);
      await page.click(`${meetingMenu} [data-action="meeting-pane"][data-pane="${pane}"]`);
    }
    await page.waitForFunction(p => location.hash.endsWith(`/${p}`), pane);
    await settled(page);
  };
  /** Picks a meeting from the list, then `pane` (a meeting picked opens on the summary). */
  const select = async (page, id, filter = 'all', pane = 'summary') => {
    await setFilter(page, filter);
    await page.click(row(id));
    await page.waitForFunction(i => location.hash.startsWith(`#/meetings/${encodeURIComponent(i)}/`), id);
    await settled(page);
    if (pane) await openPane(page, pane);
  };
  const toMeetings = async page => {
    await page.click('.ws-nav button[data-route=meetings]');
    await page.waitForSelector('.ws-dock[data-page="meetings"]');
  };
  /** Waits until no transcript check, save or notes run is queued or running in the snapshot the
   *  page shows, then for the page to settle. Every step of a run changes the workspace and the
   *  window refreshes at most every 1.2 s, so a 200 ms quiet spell alone can fall between two of
   *  its renders, and the next render detaches what the check holds. */
  const runsDone = async page => {
    await page.waitForFunction(() => !(window.__workspace.store.get()?.snapshot.jobs || []).some(j => ['transcript_check', 'transcript_download', 'meeting_notes'].includes(j.kind) && ['queued', 'running'].includes(j.state)));
    await settled(page);
  };

  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
      const tag = `${theme}-${width}`;
      const { page, context, errors } = await open({ theme, width, height, hash: '#/meetings', meetings: true });
      await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });
      /** A check of this page starts on Meetings whatever the last one left (one that failed
       *  part-way can leave Today or Tasks showing), so one failure doesn't fail the rest. */
      const step = (name, fn) => check(name, async () => {
        if (!(await hash(page)).startsWith('#/meetings')) {
          await toMeetings(page);
          await settled(page);
        }
        await fn();
      });

      await step(`${tag}: meetings list and the Philips sync: the summary, two documents in Notes, side by side, make main`, async () => {
        await page.waitForSelector('.ws-dock[data-page="meetings"]');
        assert(await page.locator('.ws-nav button[data-route=meetings][aria-current=page]').count() === 1, 'Meetings is current');
        assert((await page.locator('.ws-nav button[data-route=meetings] .ws-count').innerText()) === '5', 'five meetings wait in the sidebar');
        assert(/^#\/meetings\/[^/]+\/summary$/.test(await hash(page)), `the first meeting is selected, on its summary: ${await hash(page)}`);
        // One header row; the Needs you card first; rows hold no button and colour only what needs you.
        assert(await page.locator('.ws-mtg-filters, .ws-mtg-bulk, .ws-mtg-list-foot').count() === 0, 'no filter bar, banner or footer switch');
        assert(await page.locator('.ws-mtg-needs .ws-mtg-row').count() === 5, 'five meetings need you');
        assert(/Make notes for 3/.test(await page.locator('.ws-mtg-needs [data-action="meeting-make-all"]').innerText()), 'Make notes for 3');
        assert(await page.locator('.ws-mtg-row button').count() === 0, 'no row holds a button');
        assert(await page.locator(`${row('mtg-critique')} .ws-tone-error`).innerText() === 'Notes failed', 'failed in red');
        assert(await page.locator(`${row('mtg-philips')} svg`).count() === 0, 'no status icons');
        assert(await page.locator(`${row('mtg-philips')} [class*="ws-tone-"]`).count() === 0, 'a ready meeting is grey');
        await noOverflow(page, 'meetings list');
        await shot(page, `${tag}-meetings-list`);
        // The summary first: the documents as tabs, the main one shown, Copy and ⋯ in the strip.
        await select(page, 'mtg-philips');
        await page.waitForSelector('.ws-mtg-summary .ws-md h3');
        assert(await page.locator('.ws-mtg-tabs[role="tablist"] [role="tab"]').count() === 2, 'two summary tabs');
        assert(/Meeting notes/.test(await page.locator('.ws-mtg-tabs [role="tab"][aria-selected="true"]').innerText()), 'the main document shown');
        assert(await page.locator('.ws-mtg-strip [data-action="meeting-copy-tab"]').count() === 1, 'Copy, the primary');
        assert(await page.locator('[data-tab="mtg-notes"], [data-tab="mtg-transcript"], .ws-mtg-faces').count() === 0, 'no section per tab, no faces');
        await page.click('.ws-mtg-strip [data-action="meeting-copy-tab"]');
        await page.waitForSelector('.ws-mtg-strip [data-action="meeting-copy-tab"]:has-text("Copied")');
        assert(/TL;DR/.test(await page.evaluate(() => window.__copied)), 'the document’s Markdown copied');
        await headerFits(page, 'summary');
        await noOverflow(page, 'meeting summary');
        await shot(page, `${tag}-meetings-summary`);
        // Notes, behind ⋯: the document picker with both documents.
        await openPane(page, 'notes');
        await page.waitForSelector('.ws-mtg-docpage .ws-md h3');
        assert(/← Back to summary/.test(await page.locator('.ws-mtg-strip').innerText()), 'Back to summary in the strip');
        assert(/Meeting notes[\s\S]*1 of 2/.test(await page.locator('.ws-mtg-doc-pick-sum').innerText()), 'the picker: Meeting notes, 1 of 2');
        assert(await page.locator('.ws-mtg-pchip, .ws-md-front, [data-tab="people"], [data-tab="mtg-people"]').count() === 0, 'no chips, properties table or People tab');
        assert(await page.locator('.ws-mtg-docpage .ws-md-tags .ws-md-tag').count() === 3, 'the tags');
        assert(/You asked/.test(await page.locator('.ws-mtg-docfoot').innerText()), 'who made it, under the notes');
        assert(await page.evaluate(() => window.__xss) === undefined, 'notes are escaped');
        await noOverflow(page, 'meeting notes');
        await shot(page, `${tag}-meetings-notes`);
        // People: "with …"; the popover says who they are and who never spoke.
        assert(/^with /.test(await page.locator('.ws-mtg-with').innerText()), 'the with-line');
        await page.click('.ws-mtg-with');
        await page.waitForSelector('.ws-mtg-people-pop .ws-mtg-person');
        assert(await page.locator('.ws-mtg-people-pop .ws-mtg-person').count() === 6, 'six people');
        assert(await page.locator('.ws-mtg-people-pop .ws-mtg-person.ws-mtg-quiet').count() === 1, 'one person never spoke');
        assert(/Philips/i.test(await page.locator('.ws-mtg-people-pop .ws-mtg-person').first().innerText()), 'the guest’s company');
        await noOverflow(page, 'people');
        await shot(page, `${tag}-meetings-people`);
        await page.keyboard.press('Escape');
        // Side by side collapses the list's section; the toggle again brings it back.
        await page.click('.ws-mtg-doctools > [data-action="meeting-compare"][data-v="1"]');
        await page.waitForSelector('.ws-mtg-compare .ws-mtg-doc:nth-child(2) .ws-md');
        assert(await page.locator('[data-action="meeting-list-toggle"][aria-pressed="false"]').count() === 1, 'the list is collapsed');
        assert(!(await page.locator('.ws-mtg-list').isVisible()), 'the list is out of sight');
        await noOverflow(page, 'side by side');
        await shot(page, `${tag}-meetings-side-by-side`);
        await page.click('.ws-mtg-doctools > [data-action="meeting-compare"][data-v="0"]');
        await page.waitForSelector('.ws-mtg-list');
        // Short summary becomes the main notes.
        await page.click('.ws-mtg-doc-picker > summary');
        await page.click('.ws-mtg-doc-picker [data-action="doc-view"][data-doc="short-summary"]');
        await page.click('.ws-mtg-docfoot [data-action="doc-main"]');
        await page.waitForFunction(() => /Short summary \(main\)/.test(document.querySelector('.ws-mtg-doc-picker .ws-menu-panel')?.textContent || ''));
        const main = await lastCall(page, 'meeting_doc');
        assert(main.action === 'main' && main.docId === 'short-summary', JSON.stringify(main));
        // Edit it; meanwhile another window saves a change: the newer text shows, nothing is
        // overwritten, and the edit goes in once it starts from the newer text.
        await page.click('.ws-mtg-doctools [data-action="doc-edit"]');
        await page.waitForSelector('#meeting-doc-editor');
        await page.fill('#meeting-doc-editor', '# Short summary\n\nMy own words.');
        await page.evaluate(() => window.__docChanged('mtg-philips', 'short-summary'));
        await page.click('.ws-mtg-doctools [data-action="doc-edit-save"]');
        await page.waitForSelector('.ws-mtg-conflict');
        assert(await page.inputValue('#meeting-doc-editor') === '# Short summary\n\nMy own words.', 'the edit stays');
        await noOverflow(page, 'edit conflict');
        await shot(page, `${tag}-meetings-edit-conflict`);
        await page.click('.ws-mtg-conflict [data-action="doc-edit-rebase"]');
        assert(/Added in another window/.test(await page.inputValue('#meeting-doc-editor')), 'the newer text to edit');
        await page.fill('#meeting-doc-editor', `${await page.inputValue('#meeting-doc-editor')}\n\nMy own words.`);
        await page.click('.ws-mtg-doctools [data-action="doc-edit-save"]');
        await page.waitForSelector('#meeting-doc-editor', { state: 'detached' });
        const edits = (await calls(page, 'meeting_doc')).filter(x => x.action === 'edit');
        assert(edits.length === 2 && edits[1].baseRev === edits[0].baseRev + 1 && edits[1].baseVersion === edits[0].baseVersion, JSON.stringify(edits.map(x => [x.baseVersion, x.baseRev])));
        await page.waitForSelector('.ws-mtg-docpage .ws-md:has-text("My own words.")');
        // Files, under ⋯ › Advanced.
        await page.click(`${meetingMenu} > summary`);
        assert(await page.evaluate(sel => { const items = [...document.querySelectorAll(`${sel} .ws-menu-panel > *`)]; const at = items.findIndex(x => x.textContent.trim() === 'Advanced'); return at > 0 && items.slice(at).some(x => x.dataset.pane === 'files'); }, meetingMenu), 'Files under Advanced');
        await page.click(`${meetingMenu} [data-action="meeting-pane"][data-pane="files"]`);
        await page.waitForSelector('.ws-mtg-file:has-text("notes.md") >> text=Short summary — the main notes');
        assert(/#\/meetings\/mtg-philips\/files$/.test(await hash(page)), 'the pane is in the hash');
        await noOverflow(page, 'files');
        await shot(page, `${tag}-meetings-files`);
        await page.click('.ws-mtg-file:has-text("segments.json") [data-action="meeting-file-preview"]');
        await page.waitForSelector(`${dialog} .ws-mtg-pre`);
        await noOverflow(page, 'file preview');
        await page.keyboard.press('Escape');
      });

      await step(`${tag}: calendar badge → event card → Make notes → one progress line → Ready`, async () => {
        await page.evaluate(async () => {
          const w = window.__workspace;
          const ev = w.store.get().snapshot.records.find(r => r.kind === 'event' && r.id === 'mtg-roadmap');
          w.state.calendarDate = new Date(ev.data.start);
          w.state.calendarMode = 'week';
          await w.route('calendar');
        });
        await page.waitForSelector('.ws-ev[data-id="mtg-roadmap"] .ws-tb-process');
        assert(await page.locator('.ws-ev[data-id="mtg-philips"] .ws-tb-ready').count() + await page.locator('.ws-ev[data-id="mtg-roadmap"] .ws-tb-process').count() >= 1, 'badges');
        if (await page.locator('.ws-ev[data-id="mtg-lunch"]').count()) assert(await page.locator('.ws-ev[data-id="mtg-lunch"] .ws-tb').count() === 0, 'no badge in person');
        assert(await page.locator('.ws-mtg-legend .ws-mtg-legend-row').count() === 5, 'the legend');
        await noOverflow(page, 'calendar');
        await shot(page, `${tag}-calendar-badges`);
        // Only meetings with transcripts dims the rest (the side panel, like the calendar list, is
        // there from 1180 px up).
        if (await page.locator('.ws-mtg-legend .ws-switch').isVisible()) {
          await page.click('.ws-mtg-legend .ws-switch');
          await page.waitForSelector('.ws-ev.ws-mtg-dim');
          assert(await page.locator('.ws-ev[data-id="mtg-roadmap"].ws-mtg-dim').count() === 0, 'the roadmap review stays');
          await shot(page, `${tag}-calendar-only-transcripts`);
          await page.click('.ws-mtg-legend .ws-switch');
          await page.waitForSelector('.ws-ev.ws-mtg-dim', { state: 'detached' });
        }
        // Month and agenda carry the badge too; the agenda says it in words.
        await page.click('[data-action="calendar-mode"][data-mode="month"]');
        await page.waitForSelector('.ws-month-ev[data-id="mtg-philips"] .ws-tb-ready'); // today's cell folds into “+N more”
        await noOverflow(page, 'month');
        await shot(page, `${tag}-calendar-month`);
        await page.click('[data-action="calendar-mode"][data-mode="agenda"]');
        await page.waitForSelector('.ws-agenda-row .ws-tb-label');
        await noOverflow(page, 'agenda');
        await shot(page, `${tag}-calendar-agenda`);
        await page.click('[data-action="calendar-mode"][data-mode="week"]');
        await page.waitForSelector('.ws-ev[data-id="mtg-roadmap"] .ws-tb-process');
        // The event card: Transcript & notes, Make notes, Show in Meetings.
        await page.click('.ws-ev[data-id="mtg-roadmap"]');
        await page.waitForSelector(`${dialog} .ws-mtg-ev`);
        assert(/Transcript & notes/.test(await page.locator(`${dialog} .ws-mtg-ev`).innerText()), 'the section');
        assert(await page.locator(`${dialog} .ws-modal-footer [data-action="meeting-open"]`).count() === 1, 'Show in Meetings');
        await noOverflow(page, 'event card');
        await dialogShot(page, `${tag}-event-card`);
        await page.click(`${dialog} .ws-mtg-ev [data-action="meeting-make-notes"]`);
        await page.waitForSelector(`${dialog} .ws-tpl-options`);
        assert(await page.locator(dialog).count() === 1, 'the event card closed for the dialog');
        assert(await page.locator(`${dialog} input[name="template"][value="meeting-notes"]`).isChecked(), 'the template it would use');
        await noOverflow(page, 'make notes dialog');
        await dialogShot(page, `${tag}-make-notes-dialog`);
        await page.fill(`${dialog} textarea[name="wishes"]`, 'Focus on the release date');
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 1600 }; });
        await page.click(submit);
        await page.waitForSelector(dialog, { state: 'detached' });
        const asked = await lastCall(page, 'meeting_notes');
        assert(asked.meetingId === 'mtg-roadmap' && asked.templateId === 'meeting-notes' && asked.wishes === 'Focus on the release date' && asked.findTasks === true, JSON.stringify(asked));
        await page.waitForSelector('.ws-ev[data-id="mtg-roadmap"] .ws-tb-busy');
        await page.click('.ws-ev[data-id="mtg-roadmap"]');
        await page.waitForSelector(`${dialog} .ws-mtg-ev-run`);
        await page.click(`${dialog} .ws-modal-footer [data-action="meeting-open"]`);
        await page.waitForSelector('.ws-mtg-runline');
        assert(await hash(page) === '#/meetings/mtg-roadmap/summary', await hash(page));
        assert(/Making Meeting notes/.test(await page.locator('.ws-mtg-runline').innerText()), 'the run');
        assert(await page.locator('[role="progressbar"]').count() === 1, 'said once');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 1, 'a spinner on the row');
        await noOverflow(page, 'running');
        await shot(page, `${tag}-meetings-progress`);
        assert(/Writing Meeting notes…/.test(await page.locator('.ws-mtg-strip .ws-mtg-writing').innerText()), 'the primary says it is writing');
        await page.waitForSelector('.ws-mtg-runline', { state: 'detached', timeout: 12000 });
        await page.waitForSelector('.ws-mtg-summary .ws-md h3');
        assert(/Meeting notes/.test(await page.locator(row('mtg-roadmap')).innerText()), 'the row names its notes');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 0, 'the spinner is gone');
      });

      await step(`${tag}: blocked meeting → import a .vtt → name the speaker`, async () => {
        await toMeetings(page);
        await select(page, 'mtg-northwind', 'needs');
        await page.waitForSelector('.ws-mtg-explain:has-text("doesn’t share this transcript")');
        assert(await page.locator('.ws-mtg-panel-alone .ws-mtg-explain').count() === 1, 'the explainer stands in for the summary before there is a transcript');
        assert(await page.locator('.ws-mtg-tabs, .ws-mtg-strip [data-action="meeting-copy-tab"], .ws-mtg-strip [data-action="meeting-make-tab"]').count() === 0, 'no tabs and no primary: the strip holds ⋯ alone');
        await page.click('[data-action="meeting-copy-ask"]');
        assert(/^Hi Hannah, could you send me the transcript of “Northwind partnership call”/.test(await page.evaluate(() => window.__copied)), 'the message to the organizer');
        await noOverflow(page, 'blocked');
        await shot(page, `${tag}-meetings-blocked`);
        await page.click('.ws-mtg-explain [data-action="meeting-import"]');
        await page.waitForSelector(`${dialog} .ws-mtg-drop`);
        assert(await page.locator(`${dialog} select[name="meetingId"]`).inputValue() === 'mtg-northwind', 'the meeting is chosen');
        await page.setInputFiles(`${dialog} input[type=file]`, { name: 'northwind-partnership.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT) });
        await page.waitForSelector(`${dialog} .ws-mtg-drop-file:not([hidden])`);
        await noOverflow(page, 'import dialog');
        await dialogShot(page, `${tag}-meetings-import`);
        await page.click(submit);
        await page.waitForSelector('.ws-mtg-speakers-banner');
        assert(await hash(page) === '#/meetings/mtg-northwind/transcript', await hash(page));
        assert((await lastCall(page, 'meeting_import')).fileName === 'northwind-partnership.vtt', 'imported');
        assert(await page.evaluate(() => window.__xss) === undefined, 'the transcript is escaped');
        await noOverflow(page, 'speakers');
        // The header in the default sections: its actions and when stay inside the section.
        await headerFits(page, 'speakers');
        await shot(page, `${tag}-meetings-speakers`);
        await page.selectOption('.ws-mtg-speakers-banner select', 'jordan.lee@example.test');
        await page.waitForSelector('.ws-mtg-speakers-banner', { state: 'detached' });
        const named = await lastCall(page, 'meeting_speakers');
        assert(named.voice === 'Speaker 2' && named.address === 'jordan.lee@example.test', JSON.stringify(named));
        assert(/Jordan Lee/.test(await page.locator('.ws-mtg-lines').innerText()), 'the line has its name');
      });

      await step(`${tag}: Filter › Meetings without a transcript shows them, and hides them again`, async () => {
        await setFilter(page, 'all');
        assert(await page.locator(row('mtg-sprint')).count() === 0, 'a meeting waiting for Teams is out of All');
        const item = '[data-menu="meetings-filter"] [data-action="meeting-show-none"]';
        await page.click('[data-menu="meetings-filter"] > summary');
        assert(/Without a transcript \(\d+\)/.test(await page.locator(item).innerText()), await page.locator(item).innerText());
        // The menu stays inside the list, however narrow (it used to be cut off on the left).
        const [pane, panel] = await Promise.all(['.ws-mtg-list', '[data-menu="meetings-filter"] .ws-menu-panel'].map(s => page.locator(s).boundingBox()));
        assert(panel.x >= pane.x && panel.x + panel.width <= pane.x + pane.width + 0.5, `the filter menu fits the list: ${JSON.stringify({ pane, panel })}`);
        await page.screenshot({ path: `${OUT}/${tag}-meetings-filter-menu.png` });
        await page.click(item);
        await page.waitForSelector(row('mtg-sprint'));
        assert(await page.locator(`${item}[aria-checked="true"]`).count() === 1, 'the switch is on');
        await filterSwitch(page, 'meeting-show-none');
        await page.waitForSelector(row('mtg-sprint'), { state: 'detached' });
        assert(await page.locator(`${item}[aria-checked="false"]`).count() === 1, 'the switch is off');
        await filterSwitch(page, 'meeting-show-none');
        await page.waitForSelector(row('mtg-sprint'));
      });

      await step(`${tag}: waiting meeting → Make notes as soon as it arrives → Check now → saved and notes made`, async () => {
        await select(page, 'mtg-sprint');
        await page.waitForSelector('.ws-mtg-explain:has-text("still preparing the transcript")');
        await shot(page, `${tag}-meetings-waiting`);
        await page.click('.ws-mtg-explain .ws-switch');
        await page.waitForSelector(`${row('mtg-sprint')}:has-text("notes when it arrives")`);
        const set = await lastCall(page, 'meeting_set');
        assert(set.meetingId === 'mtg-sprint' && set.auto === true && !('template' in set), JSON.stringify(set));
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 350 }; });
        await page.click('.ws-mtg-explain [data-action="meeting-check"]');
        // Saved and notes made: the explainer gives way to the summary, which shows them.
        await page.waitForSelector('.ws-mtg-panel-alone', { state: 'detached', timeout: 12000 });
        await page.waitForSelector('.ws-mtg-summary .ws-md h3', { timeout: 12000 });
        assert(/automatically/.test(await page.locator('.ws-mtg-docfoot').innerText()), 'made by itself');
        assert(/Meeting notes/.test(await page.locator(row('mtg-sprint')).innerText()), 'notes ready, nothing else clicked');
        await noOverflow(page, 'notes made');
      });

      await step(`${tag}: failed save → Try again`, async () => {
        await select(page, 'mtg-vendor', 'needs');
        assert(/Couldn’t get the transcript from Teams/.test(await page.locator('.ws-mtg-run-failed').innerText()), 'the failed save');
        assert(await page.locator('text=/^Download$/').count() === 0, 'no Download button');
        await shot(page, `${tag}-meetings-save-failed`);
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'fail', ms: 300 }; });
        await page.click('.ws-mtg-run-failed [data-action="meeting-download"]');
        await page.waitForSelector('.ws-mtg-runline');
        await page.waitForSelector('.ws-mtg-run-failed [data-action="meeting-download"]', { timeout: 8000 });
        // Stopped while it saves: it says so and stays stopped; only Try again starts it again.
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'ok', ms: 5000 }; });
        await page.click('.ws-mtg-run-failed [data-action="meeting-download"]');
        await page.waitForSelector('.ws-mtg-runline [data-action="meeting-cancel"]');
        await page.click('.ws-mtg-runline [data-action="meeting-cancel"]');
        await page.waitForSelector('.ws-toast:has-text("Connect won’t try again by itself")');
        await page.waitForSelector('.ws-mtg-run-failed:has-text("Saving the transcript stopped") [data-action="meeting-download"]');
        await page.waitForSelector(`${row('mtg-vendor')}:has-text("Saving stopped")`);
        await shot(page, `${tag}-meetings-save-stopped`);
        await page.evaluate(() => { window.__downloadPlan = null; });
        await page.click('.ws-mtg-run-failed [data-action="meeting-download"]');
        await page.waitForSelector(`${row('mtg-vendor')} .ws-tone-info:has-text("No notes yet")`, { timeout: 8000 });
        assert((await calls(page, 'meeting_download')).length === 3, 'three tries');
        // Saved, no notes yet: "No Meeting notes yet." and Make Meeting notes in the strip.
        await page.waitForSelector('.ws-mtg-nosummary:has-text("No Meeting notes yet.")');
        assert(/Make Meeting notes/.test(await page.locator('.ws-mtg-strip [data-action="meeting-make-tab"]').innerText()), 'Make, the primary');
      });

      await step(`${tag}: a failed Download again shows on the meeting, apart from the notes`, async () => {
        await select(page, 'mtg-philips', 'all');
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'fail', ms: 300 }; });
        await page.click(`${meetingMenu} > summary`);
        await page.click(`${meetingMenu} [data-action="meeting-download"]`);
        await page.waitForSelector('.ws-mtg-run-failed:has-text("Download again didn’t work")', { timeout: 8000 });
        assert(await page.locator('.ws-mtg-run-failed [data-action="meeting-retry"]').count() === 0, 'not offered as a notes failure');
        await noOverflow(page, 'a failed Download again');
        await shot(page, `${tag}-meetings-redownload-failed`);
        // Its Try again downloads it again: the banner goes, the notes stay.
        await page.click('.ws-mtg-run-failed [data-action="meeting-download"]');
        await page.waitForFunction(() => !document.querySelector('.ws-mtg-run-failed, .ws-mtg-runline'), null, { timeout: 8000 });
        assert(await page.locator('.ws-mtg-docpage .ws-md').count() === 1, 'the notes stay');
      });

      await step(`${tag}: the Notes pane’s Make notes form keeps a template and wishes through a refresh`, async () => {
        const make = 'form[data-form="meeting-notes"][data-id="mtg-vendor"]';
        await select(page, 'mtg-vendor', 'all', 'notes');
        await page.waitForSelector(make);
        await page.click(`${make} label.ws-tpl-option:has(input[value="short-summary"])`);
        await page.fill(`${make} textarea[name="wishes"]`, 'Only the decisions, please');
        await page.click(`${make} label.ws-check:has(input[name="findTasks"])`);
        // Focus leaves the fields, then the store refreshes and the page renders again.
        await page.click(`${make} .ws-card-title`);
        const before = await page.$(make);
        await page.evaluate(() => window.__refresh());
        await page.waitForFunction(old => { const now = document.querySelector('form[data-form="meeting-notes"][data-id="mtg-vendor"]'); return now && now !== old; }, before);
        assert(await page.isChecked(`${make} input[value="short-summary"]`), 'the template is kept');
        assert(await page.inputValue(`${make} textarea[name="wishes"]`) === 'Only the decisions, please', 'the wishes are kept');
        assert(!await page.isChecked(`${make} input[name="findTasks"]`), 'Find tasks is kept');
        await noOverflow(page, 'the Make notes form');
        const sends = (await calls(page, 'meeting_notes')).length;
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 200 }; });
        await page.click(`${make} button[type=submit]`);
        await page.waitForFunction(n => window.__bridgeCalls.filter(([o]) => o === 'meeting_notes').length > n, sends);
        const sent = await lastCall(page, 'meeting_notes');
        assert(sent.meetingId === 'mtg-vendor' && sent.templateId === 'short-summary' && sent.wishes === 'Only the decisions, please' && sent.findTasks === false, JSON.stringify(sent));
        await page.waitForSelector(`${row('mtg-vendor')}:has-text("Short summary")`, { timeout: 8000 });
      });

      await step(`${tag}: Add N to Tasks in the action items column reads what changed, not the whole workspace`, async () => {
        await select(page, 'mtg-philips', 'all');
        const add = '.ws-dock[data-page="meetings"] [data-action="meeting-items-add"]';
        await page.waitForSelector(add);
        await page.evaluate(() => { window.__readCalls = []; window.__recordReads = true; });
        await page.click(add);
        await page.waitForSelector('.ws-mtg-items-foot:has-text("Added 1 to Tasks")');
        await page.waitForFunction(() => window.__readCalls.includes('changes_since'), null, { timeout: 8000 });
        const reads = await page.evaluate(() => { window.__recordReads = false; return window.__readCalls; });
        assert(!reads.includes('snapshot'), `a full read after Add: ${reads.join(', ')}`);
        // Undo puts it back to review, ticked, for the checks after this one.
        await page.click('.ws-mtg-items-foot [data-action="meeting-items-undo"]');
        await page.waitForSelector('[data-task="task-endpoint"] [data-action="meeting-item-tick"]:checked');
      });

      await step(`${tag}: Make notes for all goes on past a meeting whose folder is gone`, async () => {
        await setFilter(page, 'all');
        // What Make notes for N takes: the card's transcripts without notes (saved or still in Teams).
        const todo = await page.locator('.ws-mtg-needs .ws-mtg-row').evaluateAll(rows => rows.filter(r => !r.querySelector('.ws-mtg-row-spin') && /No notes yet|Saving the transcript|Couldn’t get the transcript|Saving stopped/.test(r.innerText)).map(r => ({ id: r.dataset.id, title: r.querySelector('strong').innerText.trim(), saved: /No notes yet/.test(r.innerText) })));
        const gone = todo.find(x => x.saved);
        assert(gone && todo.length >= 2, JSON.stringify(todo));
        await page.evaluate(id => window.__folderMissing(id), gone.id);
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 150 }; });
        const sends = (await calls(page, 'meeting_notes')).length;
        await page.click('[data-action="meeting-make-all"]');
        const summary = page.locator(`.ws-toast:has-text("needs you: “${gone.title}” (its folder is gone)")`);
        await summary.waitFor();
        const text = await summary.innerText();
        assert(text.startsWith(`Making notes for ${todo.length - 1} of ${todo.length} meetings`), text);
        assert((await calls(page, 'meeting_notes')).length - sends === todo.length, 'every meeting was tried');
        await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => { if (!/needs you/.test(t.innerText)) t.remove(); }));
        await page.screenshot({ path: `${OUT}/${tag}-meetings-make-all-skipped.png` });
        await summary.locator('.ws-toast-action').click();
        await page.waitForFunction(id => location.hash.startsWith(`#/meetings/${encodeURIComponent(id)}/`), gone.id);
      });

      await step(`${tag}: Today card → meeting`, async () => {
        await page.click('.ws-nav button[data-route=today]');
        await page.waitForSelector('.ws-mtg-today');
        const first = await page.locator('.ws-mtg-today [data-action="meeting-open"]').first().getAttribute('data-id');
        assert(['mtg-critique', 'mtg-northwind'].includes(first), `needs you first: ${first}`);
        await noOverflow(page, 'Today');
        // The notes runs Make notes for all started re-render Today as they step: act once they
        // have ended and the page has settled.
        await runsDone(page);
        await page.locator('.ws-mtg-today').scrollIntoViewIfNeeded();
        await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
        await page.locator('.ws-mtg-today').screenshot({ path: `${OUT}/${tag}-today-meetings-card.png` });
        await shot(page, `${tag}-today-meetings`);
        await page.click('.ws-mtg-today [data-action="meeting-open"][data-id="mtg-critique"]');
        await page.waitForFunction(() => location.hash === '#/meetings/mtg-critique/summary');
        await page.waitForSelector('.ws-mtg-run-failed:has-text("The notes weren’t written")');
        assert(await page.locator(`${row('mtg-critique')}.ws-mtg-on`).count() === 1, 'selected in the list');
        await noOverflow(page, 'failed notes');
        await shot(page, `${tag}-meetings-failed`);
      });

      await step(`${tag}: the action items column — Add N to Tasks, Undo, task quote → transcript line highlighted`, async () => {
        await select(page, 'mtg-philips', 'all');
        // With the column off, Review in the header and ⋯ › Action items open the Action items pane.
        assert(await page.locator('.ws-mtg-head .ws-actions [data-action="meeting-pane"][data-pane="tasks"]').count() === 0, 'no Review while the column is on');
        await page.evaluate(() => window.__workspace.store.mutate('settings_update', { meetings: { actionItems: false } }));
        await page.waitForSelector('.ws-mtg-head .ws-actions [data-action="meeting-pane"][data-pane="tasks"]:has-text("Review 2 tasks")');
        await page.click('.ws-mtg-head .ws-actions [data-action="meeting-pane"][data-pane="tasks"]');
        await page.waitForFunction(() => location.hash === '#/meetings/mtg-philips/tasks');
        await page.waitForSelector('.ws-mtg-item');
        assert(/Action items/.test(await page.locator('.ws-mtg-strip .ws-mtg-pane-name').innerText()), 'the Action items pane');
        assert(await page.locator('.ws-mtg-item[data-task]').count() === 2, 'both To review tasks are to add');
        assert(await page.locator('[data-task="task-endpoint"] [data-action="meeting-item-tick"]:checked').count() === 1, 'my sure task ticks itself');
        await page.evaluate(() => window.__workspace.store.mutate('settings_update', { meetings: { actionItems: true } }));
        await page.waitForSelector('.ws-mtg-head .ws-actions [data-action="meeting-pane"][data-pane="tasks"]', { state: 'detached' });
        await noOverflow(page, 'action items pane');
        await shot(page, `${tag}-meetings-tasks`);
        // Add N to Tasks (today's Accept, no click per task): tick Sam's too, add both, then Undo
        // puts them back ticked.
        await page.click('[data-task="task-pilot-list"] label.ws-check');
        await page.click('[data-action="meeting-items-add"]:has-text("Add 2 to Tasks")');
        await page.waitForSelector('.ws-mtg-items-foot:has-text("Added 2 to Tasks")');
        await page.click('.ws-mtg-items-foot [data-action="meeting-items-undo"]');
        await page.waitForSelector('[data-task="task-pilot-list"] [data-action="meeting-item-tick"]:checked');
        // Its quote opens in the open row, and takes to the transcript line.
        await page.click('[data-task="task-pilot-list"] [data-action="meeting-item-open"]');
        await page.click('[data-task="task-pilot-list"] .ws-mtg-quote');
        await page.waitForSelector('#meeting-line-8.ws-mtg-focus');
        assert(await hash(page) === '#/meetings/mtg-philips/transcript', await hash(page));
        const inView = await page.evaluate(() => { const r = document.getElementById('meeting-line-8').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
        assert(inView, 'the line is in view');
        assert(await page.locator('mark.ws-mtg-fix').count() >= 1, 'glossary spellings are underlined');
        await noOverflow(page, 'transcript');
        await shot(page, `${tag}-meetings-transcript`);
        // From the Tasks board's drawer too.
        await page.click('.ws-nav button[data-route=tasks]');
        await page.click('[data-task="task-endpoint"] .ws-task-title');
        await page.click('.ws-task-drawer a[data-action="task-quote"]');
        await page.waitForSelector('#meeting-line-3.ws-mtg-focus');
        // And a time in the notes.
        await openPane(page, 'notes');
        await page.click('.ws-mtg-doc-picker > summary');
        await page.click('.ws-mtg-doc-picker [data-action="doc-view"][data-doc="meeting-notes"]');
        await page.waitForSelector('.ws-md [data-action="meeting-goto-line"][data-t="00:02"]');
        await page.click('.ws-md [data-action="meeting-goto-line"][data-t="00:02"]');
        await page.waitForSelector('#meeting-line-5.ws-mtg-focus');
      });

      await step(`${tag}: ↑/↓ move through the list`, async () => {
        await select(page, 'mtg-philips', 'all');
        await page.focus(`${row('mtg-philips')}`);
        const ids = await page.locator('.ws-mtg-row').evaluateAll(rows => rows.map(r => r.dataset.id));
        const at = ids.indexOf('mtg-philips');
        await page.keyboard.press('ArrowUp');
        await page.waitForFunction(id => document.activeElement?.dataset.id === id && location.hash.startsWith(`#/meetings/${id}/`), ids[at - 1]);
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(id => document.activeElement?.dataset.id === id, 'mtg-philips');
        assert(await page.locator(`${row('mtg-philips')}[aria-selected="true"]`).count() === 1, 'selected');
        // Escape closes a ⋯ menu onto its button.
        await page.click(`${meetingMenu} > summary`);
        await page.waitForSelector(`${meetingMenu}[open]`);
        await page.keyboard.press('Escape');
        assert(await page.locator('.ws-menu[open]').count() === 0, 'menu closed');
      });

      await step(`${tag}: a day folds; ⌥-click keeps only that day open; Unfold all days`, async () => {
        await setFilter(page, 'all');
        const days = await page.locator('.ws-mtg-group').evaluateAll(groups => groups.map(g => g.dataset.day));
        assert(days.length >= 2, days.join());
        await page.click(`[data-action="meeting-day-fold"][data-day="${days[0]}"]`);
        await page.waitForSelector(`.ws-mtg-group[data-day="${days[0]}"] .ws-mtg-row`, { state: 'detached' });
        assert(/\d+ meetings?/.test(await page.locator(`.ws-mtg-group[data-day="${days[0]}"] .ws-mtg-day`).innerText()), 'a folded day says how many');
        await page.click(`[data-action="meeting-day-fold"][data-day="${days[1]}"]`, { modifiers: ['Alt'] });
        await page.waitForFunction(open => [...document.querySelectorAll('.ws-mtg-group')].every(g => (g.dataset.day === open) === !!g.querySelector('.ws-mtg-row')), days[1]);
        await noOverflow(page, 'folded days');
        await shot(page, `${tag}-meetings-folded`);
        await page.click('[data-menu="meetings-more"] > summary');
        await page.click('[data-menu="meetings-more"] [data-action="meeting-unfold-all"]');
        await page.waitForFunction(() => [...document.querySelectorAll('.ws-mtg-group')].every(g => g.querySelector('.ws-mtg-row')));
      });

      await step(`${tag}: right-click → Hide from the list → Undo`, async () => {
        await setFilter(page, 'all');
        const count = async () => Number(await page.locator('.ws-nav button[data-route=meetings] .ws-count').innerText().catch(() => '0'));
        const before = await count();
        await page.click(row('mtg-critique'), { button: 'right' });
        await page.waitForSelector('.ws-mtg-rowmenu');
        await noOverflow(page, 'the row menu');
        await shot(page, `${tag}-meetings-row-menu`);
        await page.click('.ws-mtg-rowmenu [data-action="meeting-hide"]');
        await page.waitForSelector(row('mtg-critique'), { state: 'detached' });
        assert(await count() === before - 1, `the sidebar count drops: ${before} → ${await count()}`);
        await page.waitForSelector('.ws-mtg-hid-foot:has-text("1 hidden meeting")');
        await page.click('.ws-toast:has-text("Hidden from the list") .ws-toast-action');
        await page.waitForSelector(row('mtg-critique'));
        assert(await count() === before, 'Undo brings it back');
        // A click elsewhere closes the menu.
        await page.click(row('mtg-critique'), { button: 'right' });
        await page.waitForSelector('.ws-mtg-rowmenu');
        await page.click('.ws-mtg-list-title h1');
        await page.waitForSelector('.ws-mtg-rowmenu', { state: 'detached' });
        // Another page in between: the menu doesn't come back with Meetings.
        await page.click(row('mtg-critique'), { button: 'right' });
        await page.waitForSelector('.ws-mtg-rowmenu');
        await page.click('.ws-nav button[data-route=today]');
        await page.waitForSelector('.ws-dock[data-page="meetings"]', { state: 'detached' });
        await page.click('.ws-nav button[data-route=meetings]');
        await page.waitForSelector('.ws-dock[data-page="meetings"]');
        await settled(page);
        assert(await page.locator('.ws-mtg-rowmenu').count() === 0, 'the row menu stays closed');
        // With the menu open, a click on Filter opens Filter.
        await page.click(row('mtg-critique'), { button: 'right' });
        await page.waitForSelector('.ws-mtg-rowmenu');
        await page.click('[data-menu="meetings-filter"] > summary');
        await page.waitForSelector('.ws-mtg-rowmenu', { state: 'detached' });
        await settled(page);
        assert(await page.locator('[data-menu="meetings-filter"][open]').count() === 1, 'the filter menu opened');
        await page.keyboard.press('Escape');
      });

      await step(`${tag}: “Who is this?” on a scrolled transcript goes to the speaker list`, async () => {
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width, height: 520 });
        try {
          await select(page, 'mtg-philips', 'all', 'transcript');
          const who = '.ws-mtg-name-it[data-voice="@1"]';
          await page.waitForSelector(who);
          await page.evaluate(() => { const d = document.querySelector('.ws-mtg-detail'); d.scrollTop = d.scrollHeight; });
          await page.click(who);
          const target = 'select[data-action="meeting-speaker"][data-voice="@1"]';
          await page.waitForFunction(sel => document.activeElement === document.querySelector(sel), target);
          const inView = await page.evaluate(sel => {
            const r = document.querySelector(sel).getBoundingClientRect();
            const d = document.querySelector('.ws-mtg-detail').getBoundingClientRect();
            return r.top >= d.top && r.bottom <= d.bottom;
          }, target);
          assert(inView, 'the speaker list is in view');
        } finally {
          await page.setViewportSize(size);
        }
      });

      await step(`${tag}: Hide every “<series>” → N hidden meetings · Show → Show again`, async () => {
        await page.evaluate(() => { window.__eventData('mtg-philips', { seriesId: 'series-sync' }); window.__eventData('mtg-planning', { seriesId: 'series-sync' }); });
        await settled(page);
        await setFilter(page, 'all');
        await page.click(row('mtg-philips'), { button: 'right' });
        await page.click('.ws-mtg-rowmenu [data-action="meeting-hide-series"]');
        await page.waitForSelector(row('mtg-philips'), { state: 'detached' });
        // The footer counts what Show brings back.
        const said = Number((await page.locator('.ws-mtg-hid-foot').innerText()).match(/(\d+) hidden meeting/)[1]);
        await page.click('.ws-mtg-hid-foot');
        await page.waitForSelector(`${row('mtg-philips')}.ws-mtg-hid`);
        assert(await page.locator('.ws-mtg-row.ws-mtg-hid').count() === said, `the footer said ${said}`);
        await noOverflow(page, 'hidden meetings shown');
        await shot(page, `${tag}-meetings-hidden-shown`);
        await page.click(row('mtg-philips'));
        await page.waitForSelector('.ws-mtg-hid-note:has-text("Hidden from the list")');
        await page.click('.ws-mtg-hid-note [data-action="meeting-unhide"]');
        await page.waitForSelector(`${row('mtg-philips')}:not(.ws-mtg-hid)`);
        assert(await page.locator('.ws-mtg-hid-foot').count() === 0, 'nothing hidden any more');
        await filterSwitch(page, 'meeting-show-hidden');
      });

      await step(`${tag}: hiding survives a reload`, async () => {
        await setFilter(page, 'all');
        await page.click(row('mtg-northwind'), { button: 'right' });
        await page.click('.ws-mtg-rowmenu [data-action="meeting-hide"]');
        await page.waitForSelector(row('mtg-northwind'), { state: 'detached' });
        const pref = JSON.parse(await page.evaluate(() => localStorage.getItem('codemie.meetings.hidden')));
        assert(pref.ids.includes('mtg-northwind'), JSON.stringify(pref));
        await page.reload();
        await page.waitForSelector('.ws-dock[data-page="meetings"] .ws-mtg-row');
        assert(await page.locator(row('mtg-northwind')).count() === 0, 'still hidden after a reload');
        assert(await page.locator('.ws-mtg-hid-foot').count() === 1, 'and findable');
        assert(errors.length === 0, errors.join('\n'));
      });
      await context.close().catch(() => {});
    }
  }

  // Page sections (spec "Page sections"), once, at 1000 px: a version 1 layout (Notes beside
  // Transcript, the list narrowed to 300 px and folded) read once into two sections, the hash's
  // pane, the strip's ⋯ inside the section, and a row of sections wider than the window keeping
  // its scroll.
  const v1 = JSON.stringify({
    panes: [
      { id: 'p1', tabs: ['mtg-list'], active: 'mtg-list', w: 300, collapsed: true },
      { id: 'p2', tabs: ['mtg-notes', 'mtg-tasks', 'mtg-files'], active: 'mtg-notes', w: 600, collapsed: false },
      { id: 'p3', tabs: ['mtg-transcript'], active: 'mtg-transcript', w: 520, collapsed: false },
    ],
    max: null,
  });
  const { page, context, errors } = await open({ theme: 'dark', width: 1000, height: 760, hash: '#/meetings/mtg-philips/transcript', meetings: true, localPrefs: { 'codemie.layout.meetings.v1': v1 } });
  await check('meetings sections: v1 layout read once, two sections, the hash’s pane, the header menu inside the section, the row’s scroll', async () => {
    const dock = '.ws-dock[data-page="meetings"]';
    await page.waitForSelector(dock);
    // Two sections, whatever v1 held; its list was folded: a rail.
    assert(await page.locator(`${dock} > .ws-pane`).count() === 2, 'two sections');
    assert(await page.locator('.ws-mtg-list').count() === 0, 'the list is collapsed');
    assert(await page.locator('[data-action="meeting-list-toggle"][aria-pressed="false"]').count() === 1, 'the toggle says so');
    // The hash's pane is the one shown, with Back to summary.
    await page.waitForSelector('.ws-mtg-detail[data-panel="transcript"] #meeting-line-3');
    assert(await hash(page) === '#/meetings/mtg-philips/transcript', await hash(page));
    assert(await page.locator('.ws-mtg-strip [data-action="meeting-back"]').count() === 1, 'Back to summary');
    // The toggle opens the list at v1's width; that is kept under v2, and v1 is never written.
    await page.click('[data-action="meeting-list-toggle"]');
    await page.waitForSelector('.ws-mtg-list');
    const v2 = JSON.parse(await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v2')) || 'null');
    assert(v2?.panes?.length === 2 && v2.panes[0].tabs.join() === 'mtg-list' && v2.panes[0].w === 300 && v2.panes[0].collapsed === false && v2.panes[1].tabs.join() === 'mtg-meeting', `v2: ${JSON.stringify(v2)}`);
    assert(await page.evaluate(() => localStorage.getItem('codemie.layout.meetings.v1')) === v1, 'v1 untouched');
    await page.reload();
    await page.waitForSelector(`${dock} .ws-mtg-list`);
    // Esc in the pane goes back to the summary.
    await page.waitForSelector('.ws-mtg-detail[data-panel="transcript"]');
    await page.locator('.ws-mtg-detail').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#/meetings/mtg-philips/summary');
    await page.waitForSelector('.ws-mtg-tabs [role="tab"][aria-selected="true"]');
    // The meeting's ⋯ opens in the strip, each item on top and inside the section (the panel
    // scrolls when the section is shorter than it).
    await page.click('.ws-mtg-strip > .ws-menu > summary');
    await page.waitForSelector('.ws-mtg-strip > .ws-menu[open] .ws-menu-panel');
    // The panel's height is fitted to the room below the strip once it has opened (its toggle event).
    await page.waitForFunction(() => !!document.querySelector('.ws-mtg-strip > .ws-menu[open] .ws-menu-panel')?.style.maxHeight);
    const stripMenu = await page.evaluate(() => {
      const panel = document.querySelector('.ws-mtg-strip > .ws-menu[open] .ws-menu-panel');
      const box = panel.closest('.ws-pane').getBoundingClientRect();
      const r = panel.getBoundingClientRect();
      const hidden = [...panel.querySelectorAll('.ws-menu-item')].map(item => {
        item.scrollIntoView({ block: 'nearest' });
        const b = item.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { item: item.textContent.trim(), onTop: !!hit && item.contains(hit), inside: b.top >= box.top && b.bottom <= box.bottom };
      }).filter(x => !x.onTop || !x.inside);
      return { hidden, panel: [r.top, r.bottom, r.left, r.right].map(Math.round), pane: [box.top, box.bottom, box.left, box.right].map(Math.round), inside: r.top >= box.top && r.bottom <= box.bottom + 0.5 && r.left >= box.left && r.right <= box.right + 0.5 };
    });
    assert(stripMenu.inside, `the menu stays inside the section: ${JSON.stringify(stripMenu)}`);
    assert(stripMenu.hidden.length === 0, `menu items hidden: ${JSON.stringify(stripMenu.hidden)}`);
    await shot(page, 'dark-1000-meetings-header-menu');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-mtg-strip > .ws-menu[open]', { state: 'detached' });
    await headerFits(page, 'the meeting section at 1000 px');
    // Narrower than both sections' minimums: the row scrolls sideways and an update (a minute
    // tick, a pane chosen) keeps its place.
    await page.setViewportSize({ width: 760, height: 760 });
    const left = await page.evaluate(sel => { const row = document.querySelector(sel); row.scrollLeft = row.scrollWidth; return row.scrollLeft; }, dock);
    assert(left > 0, `the row scrolls sideways: ${left}`);
    await page.evaluate(() => window.__workspace.render());
    assert(await page.evaluate(sel => document.querySelector(sel).scrollLeft, dock) === left, 'a render keeps the row’s scroll');
    await page.locator('.ws-mtg-strip > .ws-menu > summary').dispatchEvent('click');
    await page.locator('.ws-mtg-strip > .ws-menu [data-action="meeting-pane"][data-pane="notes"]').dispatchEvent('click');
    await page.waitForSelector('.ws-mtg-detail[data-panel="notes"]');
    assert(await page.evaluate(sel => document.querySelector(sel).scrollLeft, dock) === left, 'a pane chosen keeps the row’s scroll');
    await page.setViewportSize({ width: 1000, height: 760 });
    // A meeting waiting for notes: its header and strip stay inside the section too.
    await select(page, 'mtg-roadmap');
    await headerFits(page, 'Roadmap review');
    await shot(page, 'dark-1000-meetings-sections-make-notes');
    assert(errors.length === 0, errors.join('\n'));
  });
  await context.close().catch(() => {});
}
