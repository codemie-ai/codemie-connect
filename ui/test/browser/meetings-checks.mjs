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
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-main, .ws-mtg-list, .ws-mtg-detail, .ws-mtg-list-body, .ws-modal[open] .ws-modal-body, .ws-mtg-legend')].filter(el => el.clientWidth > 0 && getComputedStyle(el).visibility !== 'hidden').map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `${what} overflows by ${overflow}px`);
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
  /** The meeting's own ⋯ menu (the header also holds the people popover). */
  const meetingMenu = '.ws-mtg-head .ws-actions > .ws-menu';
  /** Picks a meeting from the list; with tabs, its Notes tab (the remembered tab may be another). */
  const select = async (page, id, filter = 'all', tab = 'notes') => {
    await setFilter(page, filter);
    await page.click(row(id));
    await page.waitForFunction(i => location.hash.startsWith(`#/meetings/${encodeURIComponent(i)}/`), id);
    await settled(page);
    const tabButton = `.ws-mtg-tabs [data-action="meeting-tab"][data-tab="${tab}"]`;
    if (tab && await page.locator(tabButton).count() && await page.locator(`${tabButton}[aria-selected="true"]`).count() === 0) {
      await page.click(tabButton);
      await settled(page);
    }
  };
  const toMeetings = async page => {
    await page.click('.ws-nav button[data-route=meetings]');
    await page.waitForSelector('.ws-mtg-layout');
  };

  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
      const tag = `${theme}-${width}`;
      const { page, context, errors } = await open({ theme, width, height, hash: '#/meetings', meetings: true });
      await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });

      await check(`${tag}: meetings list and the Philips sync: two documents, side by side, make main`, async () => {
        await page.waitForSelector('.ws-mtg-layout');
        assert(await page.locator('.ws-nav button[data-route=meetings][aria-current=page]').count() === 1, 'Meetings is current');
        assert((await page.locator('.ws-nav button[data-route=meetings] .ws-count').innerText()) === '5', 'five meetings wait in the sidebar');
        assert(/^#\/meetings\/[^/]+\/notes$/.test(await hash(page)), `the first meeting is selected: ${await hash(page)}`);
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
        await select(page, 'mtg-philips');
        await page.waitForSelector('.ws-mtg-docpage .ws-md h3');
        assert(/Meeting notes[\s\S]*1 of 2/.test(await page.locator('.ws-mtg-doc-pick-sum').innerText()), 'the picker: Meeting notes, 1 of 2');
        assert(await page.locator('.ws-mtg-strip, .ws-mtg-pchip, .ws-md-front, [data-tab="people"]').count() === 0, 'no strip, chips, properties table or People tab');
        assert(await page.locator('.ws-mtg-docpage .ws-md-tags .ws-md-tag').count() === 3, 'the tags');
        assert(/You asked/.test(await page.locator('.ws-mtg-docfoot').innerText()), 'who made it, under the notes');
        assert(await page.evaluate(() => window.__xss) === undefined, 'notes are escaped');
        await noOverflow(page, 'meeting notes');
        await shot(page, `${tag}-meetings-notes`);
        // People: four faces; the popover says who they are and who never spoke.
        await page.click('.ws-mtg-stack > summary');
        await page.waitForSelector('.ws-mtg-people-pop .ws-mtg-person');
        assert(await page.locator('.ws-mtg-people-pop .ws-mtg-person').count() === 6, 'six people');
        assert(await page.locator('.ws-mtg-people-pop .ws-mtg-person.ws-mtg-quiet').count() === 1, 'one person never spoke');
        assert(/Philips/i.test(await page.locator('.ws-mtg-people-pop .ws-mtg-person').first().innerText()), 'the guest’s company');
        await noOverflow(page, 'people');
        await shot(page, `${tag}-meetings-people`);
        await page.keyboard.press('Escape');
        // Side by side hides the list; the toggle again brings it back.
        await page.click('.ws-mtg-doctools > [data-action="meeting-compare"][data-v="1"]');
        await page.waitForSelector('.ws-mtg-compare .ws-mtg-doc:nth-child(2) .ws-md');
        assert(await page.locator('.ws-mtg-layout.ws-mtg-wide').count() === 1, 'the list is hidden');
        assert(!(await page.locator('.ws-mtg-list').isVisible()), 'the list is out of sight');
        await noOverflow(page, 'side by side');
        await shot(page, `${tag}-meetings-side-by-side`);
        await page.click('.ws-mtg-doctools > [data-action="meeting-compare"][data-v="0"]');
        await page.waitForSelector('.ws-mtg-layout:not(.ws-mtg-wide)');
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
        await page.click('.ws-mtg-tabs [data-action="meeting-tab"][data-tab="files"]');
        await page.waitForSelector('.ws-mtg-file:has-text("notes.md") >> text=Short summary — the main notes');
        assert(/#\/meetings\/mtg-philips\/files$/.test(await hash(page)), 'the tab is in the hash');
        await noOverflow(page, 'files');
        await shot(page, `${tag}-meetings-files`);
        await page.click('.ws-mtg-file:has-text("segments.json") [data-action="meeting-file-preview"]');
        await page.waitForSelector(`${dialog} .ws-mtg-pre`);
        await noOverflow(page, 'file preview');
        await page.keyboard.press('Escape');
      });

      await check(`${tag}: calendar badge → event card → Make notes → one progress line → Ready`, async () => {
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
        assert(await hash(page) === '#/meetings/mtg-roadmap/notes', await hash(page));
        assert(/Making Meeting notes/.test(await page.locator('.ws-mtg-runline').innerText()), 'the run');
        assert(await page.locator('[role="progressbar"]').count() === 1, 'said once');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 1, 'a spinner on the row');
        await noOverflow(page, 'running');
        await shot(page, `${tag}-meetings-progress`);
        await page.waitForSelector('.ws-mtg-runline', { state: 'detached', timeout: 12000 });
        await page.waitForSelector('.ws-mtg-docpage .ws-md h3');
        assert(/Meeting notes/.test(await page.locator(row('mtg-roadmap')).innerText()), 'the row names its notes');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 0, 'the spinner is gone');
      });

      await check(`${tag}: blocked meeting → import a .vtt → name the speaker`, async () => {
        await toMeetings(page);
        await select(page, 'mtg-northwind', 'needs');
        await page.waitForSelector('.ws-mtg-explain:has-text("doesn’t share this transcript")');
        assert(await page.locator('.ws-mtg-tabs').count() === 0, 'no tabs before there is a transcript');
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
        await shot(page, `${tag}-meetings-speakers`);
        await page.selectOption('.ws-mtg-speakers-banner select', 'jordan.lee@example.test');
        await page.waitForSelector('.ws-mtg-speakers-banner', { state: 'detached' });
        const named = await lastCall(page, 'meeting_speakers');
        assert(named.voice === 'Speaker 2' && named.address === 'jordan.lee@example.test', JSON.stringify(named));
        assert(/Jordan Lee/.test(await page.locator('.ws-mtg-lines').innerText()), 'the line has its name');
      });

      await check(`${tag}: Filter › Meetings without a transcript shows them, and hides them again`, async () => {
        await setFilter(page, 'all');
        assert(await page.locator(row('mtg-sprint')).count() === 0, 'a meeting waiting for Teams is out of All');
        const item = '[data-menu="meetings-filter"] [data-action="meeting-show-none"]';
        await page.click('[data-menu="meetings-filter"] > summary');
        assert(/Meetings without a transcript \(\d+\)/.test(await page.locator(item).innerText()), await page.locator(item).innerText());
        await page.click(item);
        await page.waitForSelector(row('mtg-sprint'));
        assert(await page.locator(`${item}[aria-checked="true"]`).count() === 1, 'the switch is on');
        await filterSwitch(page, 'meeting-show-none');
        await page.waitForSelector(row('mtg-sprint'), { state: 'detached' });
        assert(await page.locator(`${item}[aria-checked="false"]`).count() === 1, 'the switch is off');
        await filterSwitch(page, 'meeting-show-none');
        await page.waitForSelector(row('mtg-sprint'));
      });

      await check(`${tag}: waiting meeting → Make notes as soon as it arrives → Check now → saved and notes made`, async () => {
        await select(page, 'mtg-sprint');
        await page.waitForSelector('.ws-mtg-explain:has-text("still preparing the transcript")');
        await shot(page, `${tag}-meetings-waiting`);
        await page.click('.ws-mtg-explain .ws-switch');
        await page.waitForSelector(`${row('mtg-sprint')}:has-text("notes when it arrives")`);
        const set = await lastCall(page, 'meeting_set');
        assert(set.meetingId === 'mtg-sprint' && set.auto === true && !('template' in set), JSON.stringify(set));
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 350 }; });
        await page.click('.ws-mtg-explain [data-action="meeting-check"]');
        // Saved and notes made: the tabs appear; Notes shows them.
        await page.waitForSelector('.ws-mtg-tabs [data-action="meeting-tab"][data-tab="notes"]', { timeout: 12000 });
        await page.click('.ws-mtg-tabs [data-action="meeting-tab"][data-tab="notes"]');
        await page.waitForSelector('.ws-mtg-docpage .ws-md h3', { timeout: 12000 });
        assert(/automatically/.test(await page.locator('.ws-mtg-docfoot').innerText()), 'made by itself');
        assert(/Meeting notes/.test(await page.locator(row('mtg-sprint')).innerText()), 'notes ready, nothing else clicked');
        await noOverflow(page, 'notes made');
      });

      await check(`${tag}: failed save → Try again`, async () => {
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
        await page.waitForSelector('form[data-form="meeting-notes"][data-id="mtg-vendor"]');
      });

      await check(`${tag}: a failed Download again shows on the meeting, apart from the notes`, async () => {
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

      await check(`${tag}: the Notes tab’s Make notes form keeps a template and wishes through a refresh`, async () => {
        const make = 'form[data-form="meeting-notes"][data-id="mtg-vendor"]';
        await select(page, 'mtg-vendor', 'all');
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

      await check(`${tag}: Make notes for all goes on past a meeting whose folder is gone`, async () => {
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

      await check(`${tag}: Today card → meeting`, async () => {
        await page.click('.ws-nav button[data-route=today]');
        await page.waitForSelector('.ws-mtg-today');
        const first = await page.locator('.ws-mtg-today [data-action="meeting-open"]').first().getAttribute('data-id');
        assert(['mtg-critique', 'mtg-northwind'].includes(first), `needs you first: ${first}`);
        await noOverflow(page, 'Today');
        // The save the last check started may still re-render Today: act once it has settled.
        await settled(page).catch(() => {});
        await page.locator('.ws-mtg-today').scrollIntoViewIfNeeded();
        await page.evaluate(() => document.querySelectorAll('.ws-toast').forEach(t => t.remove()));
        await page.locator('.ws-mtg-today').screenshot({ path: `${OUT}/${tag}-today-meetings-card.png` });
        await shot(page, `${tag}-today-meetings`);
        await page.click('.ws-mtg-today [data-action="meeting-open"][data-id="mtg-critique"]');
        await page.waitForFunction(() => location.hash === '#/meetings/mtg-critique/notes');
        await page.waitForSelector('.ws-mtg-run-failed:has-text("The notes weren’t written")');
        assert(await page.locator(`${row('mtg-critique')}.ws-mtg-on`).count() === 1, 'selected in the list');
        await noOverflow(page, 'failed notes');
        await shot(page, `${tag}-meetings-failed`);
      });

      await check(`${tag}: task quote → transcript line highlighted`, async () => {
        await select(page, 'mtg-philips', 'all');
        await page.click('.ws-mtg-tabs [data-action="meeting-tab"][data-tab="tasks"]');
        await page.waitForSelector('.ws-mtg-trow');
        await noOverflow(page, 'tasks tab');
        await shot(page, `${tag}-meetings-tasks`);
        await page.click('.ws-mtg-trow:has-text("Prepare the pilot user list") .ws-mtg-quote');
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
        await page.click('.ws-mtg-tabs [data-action="meeting-tab"][data-tab="notes"]');
        await page.click('.ws-mtg-doc-picker > summary');
        await page.click('.ws-mtg-doc-picker [data-action="doc-view"][data-doc="meeting-notes"]');
        await page.waitForSelector('.ws-md [data-action="meeting-goto-line"][data-t="00:02"]');
        await page.click('.ws-md [data-action="meeting-goto-line"][data-t="00:02"]');
        await page.waitForSelector('#meeting-line-5.ws-mtg-focus');
      });

      await check(`${tag}: ↑/↓ move through the list`, async () => {
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

      await check(`${tag}: a day folds; ⌥-click keeps only that day open; Unfold all days`, async () => {
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

      await check(`${tag}: right-click → Hide from the list → Undo`, async () => {
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
      });

      await check(`${tag}: Hide every “<series>” → N hidden meetings · Show → Show again`, async () => {
        await page.evaluate(() => { window.__eventData('mtg-philips', { seriesId: 'series-sync' }); window.__eventData('mtg-planning', { seriesId: 'series-sync' }); });
        await settled(page);
        await setFilter(page, 'all');
        await page.click(row('mtg-philips'), { button: 'right' });
        await page.click('.ws-mtg-rowmenu [data-action="meeting-hide-series"]');
        await page.waitForSelector(row('mtg-philips'), { state: 'detached' });
        await page.waitForSelector('.ws-mtg-hid-foot:has-text("2 hidden meetings")');
        await page.click('.ws-mtg-hid-foot');
        await page.waitForSelector(`${row('mtg-philips')}.ws-mtg-hid`);
        await noOverflow(page, 'hidden meetings shown');
        await shot(page, `${tag}-meetings-hidden-shown`);
        await page.click(row('mtg-philips'));
        await page.waitForSelector('.ws-mtg-hid-note:has-text("Hidden from the list")');
        await page.click('.ws-mtg-hid-note [data-action="meeting-unhide"]');
        await page.waitForSelector(`${row('mtg-philips')}:not(.ws-mtg-hid)`);
        assert(await page.locator('.ws-mtg-hid-foot').count() === 0, 'nothing hidden any more');
        await filterSwitch(page, 'meeting-show-hidden');
      });

      await check(`${tag}: hiding survives a reload`, async () => {
        await setFilter(page, 'all');
        await page.click(row('mtg-northwind'), { button: 'right' });
        await page.click('.ws-mtg-rowmenu [data-action="meeting-hide"]');
        await page.waitForSelector(row('mtg-northwind'), { state: 'detached' });
        const pref = JSON.parse(await page.evaluate(() => localStorage.getItem('codemie.meetings.hidden')));
        assert(pref.ids.includes('mtg-northwind'), JSON.stringify(pref));
        await page.reload();
        await page.waitForSelector('.ws-mtg-layout .ws-mtg-row');
        assert(await page.locator(row('mtg-northwind')).count() === 0, 'still hidden after a reload');
        assert(await page.locator('.ws-mtg-hid-foot').count() === 1, 'and findable');
        assert(errors.length === 0, errors.join('\n'));
      });
      await context.close().catch(() => {});
    }
  }
}
