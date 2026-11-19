// Browser checks of the Meetings page, the calendar's transcript badges and Today's "From your
// meetings" card (spec "Meetings page", Task 4), run by workspace-e2e.mjs with its MOCKED native
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
  const select = async (page, id, filter = 'all') => {
    await page.click(`[data-action="meeting-filter"][data-filter="${filter}"]`);
    await page.click(row(id));
    await page.waitForFunction(i => location.hash.startsWith(`#/meetings/${encodeURIComponent(i)}/`), id);
    await settled(page);
  };
  const toMeetings = async page => {
    await page.click('.ws-nav button[data-route=meetings]');
    await page.waitForSelector('.ws-dock[data-page="meetings"]');
  };

  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
      const tag = `${theme}-${width}`;
      const { page, context, errors } = await open({ theme, width, height, hash: '#/meetings', meetings: true });
      await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });

      await check(`${tag}: meetings list and the Philips sync: two documents, side by side, make main`, async () => {
        await page.waitForSelector('.ws-dock[data-page="meetings"]');
        assert(await page.locator('.ws-nav button[data-route=meetings][aria-current=page]').count() === 1, 'Meetings is current');
        assert((await page.locator('.ws-nav button[data-route=meetings] .ws-count').innerText()) === '5', 'five meetings wait in the sidebar');
        assert(/^#\/meetings\/[^/]+\/notes$/.test(await hash(page)), `the first meeting is selected: ${await hash(page)}`);
        // Rows: status words, no icons; the filters count To do and Needs you.
        assert(/To do\s*3/.test(await page.locator('[data-filter="process"]').innerText()), 'To do 3');
        assert(/Needs you\s*2/.test(await page.locator('[data-filter="attention"]').innerText()), 'Needs you 2');
        assert(await page.locator(`${row('mtg-critique')} .ws-tone-error`).innerText() === 'Notes failed', 'failed in red');
        assert(await page.locator(`${row('mtg-philips')} svg`).count() === 0, 'no status icons');
        await noOverflow(page, 'meetings list');
        await select(page, 'mtg-philips');
        await page.waitForSelector('.ws-mtg-doc .ws-md h3');
        assert(await page.locator('.ws-mtg-doctab').count() === 3, 'two documents and Another summary');
        assert(await page.locator('.ws-mtg-doctab[data-doc="meeting-notes"] .ws-mtg-main').count() === 1, 'Meeting notes is main');
        assert(await page.locator('.ws-mtg-pchip.ws-mtg-quiet').count() === 1, 'one person never spoke');
        assert(/Philips/i.test(await page.locator('.ws-mtg-pchip').first().innerText()), 'the guest’s company');
        assert(await page.evaluate(() => window.__xss) === undefined, 'notes are escaped');
        await noOverflow(page, 'meeting notes');
        await shot(page, `${tag}-meetings-notes`);
        // Side by side collapses the list's section; One brings it back.
        await page.click('[data-action="meeting-compare"][data-v="1"]');
        await page.waitForSelector('.ws-mtg-compare .ws-mtg-doc:nth-child(2) .ws-md');
        assert(await page.locator('[data-action="meeting-list-toggle"][aria-pressed="false"]').count() === 1, 'the list is collapsed');
        assert(!(await page.locator('.ws-mtg-list').isVisible()), 'the list is out of sight');
        await noOverflow(page, 'side by side');
        await shot(page, `${tag}-meetings-side-by-side`);
        await page.click('[data-action="meeting-compare"][data-v="0"]');
        await page.waitForSelector('.ws-mtg-list');
        // Short summary becomes the main notes.
        await page.click('[data-action="doc-view"][data-doc="short-summary"]');
        await page.click('.ws-mtg-doc-meta [data-action="doc-main"]');
        await page.waitForSelector('.ws-mtg-doctab[data-doc="short-summary"] .ws-mtg-main');
        const main = await lastCall(page, 'meeting_doc');
        assert(main.action === 'main' && main.docId === 'short-summary', JSON.stringify(main));
        // Edit it; meanwhile another window saves a change: the newer text shows, nothing is
        // overwritten, and the edit goes in once it starts from the newer text.
        await page.click('.ws-mtg-doc [data-action="doc-edit"]');
        await page.waitForSelector('#meeting-doc-editor');
        await page.fill('#meeting-doc-editor', '# Short summary\n\nMy own words.');
        await page.evaluate(() => window.__docChanged('mtg-philips', 'short-summary'));
        await page.click('.ws-mtg-doc [data-action="doc-edit-save"]');
        await page.waitForSelector('.ws-mtg-conflict');
        assert(await page.inputValue('#meeting-doc-editor') === '# Short summary\n\nMy own words.', 'the edit stays');
        await noOverflow(page, 'edit conflict');
        await shot(page, `${tag}-meetings-edit-conflict`);
        await page.click('.ws-mtg-conflict [data-action="doc-edit-rebase"]');
        assert(/Added in another window/.test(await page.inputValue('#meeting-doc-editor')), 'the newer text to edit');
        await page.fill('#meeting-doc-editor', `${await page.inputValue('#meeting-doc-editor')}\n\nMy own words.`);
        await page.click('.ws-mtg-doc [data-action="doc-edit-save"]');
        await page.waitForSelector('#meeting-doc-editor', { state: 'detached' });
        const edits = (await calls(page, 'meeting_doc')).filter(x => x.action === 'edit');
        assert(edits.length === 2 && edits[1].baseRev === edits[0].baseRev + 1 && edits[1].baseVersion === edits[0].baseVersion, JSON.stringify(edits.map(x => [x.baseVersion, x.baseRev])));
        await page.waitForSelector('.ws-mtg-doc .ws-md:has-text("My own words.")');
        await page.click('[data-action="dock-tab"][data-tab="mtg-files"]');
        await page.waitForSelector('.ws-mtg-file:has-text("notes.md") >> text=Short summary — the main notes');
        assert(/#\/meetings\/mtg-philips\/files$/.test(await hash(page)), 'the tab is in the hash');
        await noOverflow(page, 'files');
        await shot(page, `${tag}-meetings-files`);
        await page.click('.ws-mtg-file:has-text("segments.json") [data-action="meeting-file-preview"]');
        await page.waitForSelector(`${dialog} .ws-mtg-pre`);
        await noOverflow(page, 'file preview');
        await page.keyboard.press('Escape');
        await page.click('[data-action="meeting-tab"][data-tab="people"]');
        await page.waitForSelector('.ws-mtg-person');
        assert(await page.locator('.ws-mtg-person').count() === 6, 'six people');
        await noOverflow(page, 'people');
        await shot(page, `${tag}-meetings-people`);
      });

      await check(`${tag}: calendar badge → event card → Make notes → strip shows progress → Ready`, async () => {
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
        await page.waitForSelector('.ws-mtg-strip-run');
        assert(await hash(page) === '#/meetings/mtg-roadmap/notes', await hash(page));
        assert(/Making Meeting notes/.test(await page.locator('.ws-mtg-strip-run').innerText()), 'the run');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 1, 'a spinner on the row');
        await noOverflow(page, 'running');
        await shot(page, `${tag}-meetings-progress`);
        await page.waitForSelector(`${row('mtg-roadmap')} .ws-tone-success`, { timeout: 12000 });
        await page.waitForSelector('.ws-mtg-doc .ws-md h3');
        assert(await page.locator('.ws-mtg-strip-run').count() === 0, 'the run is over');
        assert(await page.locator(`${row('mtg-roadmap')} .ws-mtg-row-spin`).count() === 0, 'the spinner is gone');
      });

      await check(`${tag}: blocked meeting → import a .vtt → name the speaker`, async () => {
        await toMeetings(page);
        await select(page, 'mtg-northwind', 'attention');
        await page.click('[data-action="dock-tab"][data-tab="mtg-notes"]');
        await page.waitForSelector('.ws-mtg-explain:has-text("doesn’t share this transcript")');
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

      await check(`${tag}: the switch shows meetings without a transcript, and hides them again`, async () => {
        await page.click('[data-action="meeting-filter"][data-filter="all"]');
        await settled(page);
        assert(await page.locator(row('mtg-sprint')).count() === 0, 'a meeting waiting for Teams is out of All');
        const label = () => page.locator('.ws-mtg-list-foot .ws-switch-label').innerText();
        assert(/Show meetings without a transcript \(\d+\)/.test(await label()), await label());
        await page.click('.ws-mtg-list-foot .ws-switch');
        await page.waitForSelector(row('mtg-sprint'));
        assert(await page.locator('.ws-mtg-list-foot input[data-action="meeting-show-none"]').isChecked(), 'the switch is on');
        await page.click('.ws-mtg-list-foot .ws-switch');
        await page.waitForSelector(row('mtg-sprint'), { state: 'detached' });
        assert(!(await page.locator('.ws-mtg-list-foot input[data-action="meeting-show-none"]').isChecked()), 'the switch is off');
        await page.click('.ws-mtg-list-foot .ws-switch');
        await page.waitForSelector(row('mtg-sprint'));
      });

      await check(`${tag}: waiting meeting → Make notes as soon as it arrives → Check now → saved and notes made`, async () => {
        await select(page, 'mtg-sprint');
        await page.click('[data-action="dock-tab"][data-tab="mtg-notes"]');
        await page.waitForSelector('.ws-mtg-explain:has-text("still preparing the transcript")');
        await shot(page, `${tag}-meetings-waiting`);
        await page.click('.ws-mtg-explain .ws-switch');
        await page.waitForSelector(`${row('mtg-sprint')}:has-text("notes when it arrives")`);
        const set = await lastCall(page, 'meeting_set');
        assert(set.meetingId === 'mtg-sprint' && set.auto === true && !('template' in set), JSON.stringify(set));
        await page.evaluate(() => { window.__notesPlan = { outcome: 'ok', stepMs: 350 }; });
        await page.click('.ws-mtg-strip [data-action="meeting-check"]');
        await page.waitForSelector(`${row('mtg-sprint')} .ws-tone-success`, { timeout: 12000 });
        await page.click('[data-action="dock-tab"][data-tab="mtg-notes"]');
        await page.waitForSelector('.ws-mtg-doctab[data-doc="meeting-notes"] .ws-mtg-doctab-icon');
        assert(await page.locator(`${row('mtg-sprint')}:has-text("Notes ready")`).count() === 1, 'notes ready, nothing else clicked');
        await noOverflow(page, 'notes made');
      });

      await check(`${tag}: failed save → Try again`, async () => {
        await select(page, 'mtg-vendor', 'process');
        assert(/couldn’t get it from Teams/.test(await page.locator('.ws-mtg-strip').innerText()), 'the failed save');
        assert(await page.locator('text=/^Download$/').count() === 0, 'no Download button');
        await shot(page, `${tag}-meetings-save-failed`);
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'fail', ms: 300 }; });
        await page.click('.ws-mtg-strip [data-action="meeting-download"]');
        await page.waitForSelector('.ws-mtg-strip-run');
        await page.waitForSelector('.ws-mtg-strip:not(.ws-mtg-strip-run) [data-action="meeting-download"]', { timeout: 8000 });
        // Stopped while it saves: it says so and stays stopped; only Try again starts it again.
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'ok', ms: 5000 }; });
        await page.click('.ws-mtg-strip [data-action="meeting-download"]');
        await page.waitForSelector('.ws-mtg-strip-run [data-action="meeting-cancel"]');
        await page.click('.ws-mtg-strip-run [data-action="meeting-cancel"]');
        await page.waitForSelector('.ws-toast:has-text("Connect won’t try again by itself")');
        await page.waitForSelector('.ws-mtg-strip:not(.ws-mtg-strip-run):has-text("saving stopped") [data-action="meeting-download"]');
        await page.waitForSelector(`${row('mtg-vendor')} .ws-tone-muted:has-text("Saving stopped")`);
        await shot(page, `${tag}-meetings-save-stopped`);
        await page.evaluate(() => { window.__downloadPlan = null; });
        await page.click('.ws-mtg-strip [data-action="meeting-download"]');
        await page.waitForSelector(`${row('mtg-vendor')} .ws-tone-purple`, { timeout: 8000 });
        assert((await calls(page, 'meeting_download')).length === 3, 'three tries');
        await page.waitForSelector('.ws-mtg-strip [data-action="meeting-make-notes"]');
      });

      await check(`${tag}: a failed Download again shows on the meeting, apart from the notes`, async () => {
        await select(page, 'mtg-philips', 'all');
        await page.evaluate(() => { window.__downloadPlan = { outcome: 'fail', ms: 300 }; });
        await page.click('.ws-mtg-head .ws-menu > summary');
        await page.click('.ws-mtg-head .ws-menu [data-action="meeting-download"]');
        await page.waitForSelector('.ws-mtg-run-failed:has-text("Download again didn’t work")', { timeout: 8000 });
        assert(await page.locator('.ws-mtg-run-failed [data-action="meeting-retry"]').count() === 0, 'not offered as a notes failure');
        assert(/download again failed/.test(await page.locator('.ws-mtg-strip').innerText()), 'the strip says so');
        await noOverflow(page, 'a failed Download again');
        await shot(page, `${tag}-meetings-redownload-failed`);
        // Its Try again downloads it again: the banner goes, the notes stay.
        await page.click('.ws-mtg-run-failed [data-action="meeting-download"]');
        await page.waitForFunction(() => !document.querySelector('.ws-mtg-run-failed, .ws-mtg-strip-run'), null, { timeout: 8000 });
        assert(await page.locator('.ws-mtg-doctab[data-doc="meeting-notes"]').count() === 1, 'the notes stay');
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
        await page.waitForSelector(`${row('mtg-vendor')} .ws-tone-success`, { timeout: 8000 });
      });

      await check(`${tag}: Make notes for all goes on past a meeting whose folder is gone`, async () => {
        await page.click('[data-action="meeting-filter"][data-filter="process"]');
        await settled(page);
        const todo = await page.locator('.ws-mtg-row').evaluateAll(rows => rows.filter(r => !r.querySelector('.ws-mtg-row-spin')).map(r => ({ id: r.dataset.id, title: r.querySelector('strong').innerText.trim(), saved: /No notes yet/.test(r.innerText) })));
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
        await page.click('[data-action="meeting-tab"][data-tab="tasks"]');
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
        await page.click('[data-action="dock-tab"][data-tab="mtg-notes"]');
        await page.click('[data-action="doc-view"][data-doc="meeting-notes"]');
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
        await page.click('.ws-mtg-head .ws-menu > summary');
        await page.waitForSelector('.ws-mtg-head .ws-menu[open]');
        await page.keyboard.press('Escape');
        assert(await page.locator('.ws-menu[open]').count() === 0, 'menu closed');
        assert(errors.length === 0, errors.join('\n'));
      });
      await context.close().catch(() => {});
    }
  }

  // Page sections (spec "Page sections"), once, at 1000 px: the old hidden list, the hash's tab,
  // Notes beside Transcript, and a row of sections wider than the window keeping its scroll.
  const { page, context, errors } = await open({ theme: 'dark', width: 1000, height: 760, hash: '#/meetings/mtg-philips/transcript', meetings: true, localPrefs: { 'codemie.meetings.wide': 'true' } });
  await check('meetings sections: the old hidden list once, the hash’s tab, Notes beside Transcript, the row’s scroll', async () => {
    await page.waitForSelector('.ws-dock[data-page="meetings"]');
    // codemie.meetings.wide = "true" with nothing stored: the list's section is a rail.
    assert(await page.locator('.ws-mtg-list').count() === 0, 'the list is collapsed');
    assert(await page.locator('[data-action="meeting-list-toggle"][aria-pressed="false"]').count() === 1, 'the toggle says so');
    // The hash's tab is the one shown.
    await page.waitForSelector('.ws-dock-tab[data-tab="mtg-transcript"][aria-selected="true"]');
    await page.waitForSelector('.ws-mtg-detail[data-panel="transcript"] #meeting-line-3');
    // The toggle opens the list, and that is kept: the old preference doesn't come back.
    await page.click('[data-action="meeting-list-toggle"]');
    await page.waitForSelector('.ws-mtg-list');
    assert(await page.evaluate(() => localStorage.getItem('codemie.meetings.wide')) === 'true', 'the old key is no longer written');
    await page.reload();
    await page.waitForSelector('.ws-dock[data-page="meetings"] .ws-mtg-list');
    // The meeting's ⋯ menu opens over its section's tabs and tab, each item on top and inside the section.
    await page.click('.ws-mtg-head .ws-menu > summary');
    await page.waitForSelector('.ws-mtg-head .ws-menu[open] .ws-menu-panel');
    const headerMenu = await page.evaluate(() => {
      const panel = document.querySelector('.ws-mtg-head .ws-menu[open] .ws-menu-panel');
      const pane = panel.closest('.ws-pane');
      const box = pane.getBoundingClientRect();
      const hidden = [...panel.querySelectorAll('.ws-menu-item')].map(item => {
        const r = item.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { item: item.textContent.trim(), onTop: !!hit && item.contains(hit), inside: r.top >= box.top && r.bottom <= box.bottom };
      }).filter(x => !x.onTop || !x.inside);
      return { hidden, overTabs: panel.getBoundingClientRect().bottom > pane.querySelector(':scope > .ws-pane-strip').getBoundingClientRect().top };
    });
    assert(headerMenu.overTabs, 'the menu reaches over the section’s tabs');
    assert(headerMenu.hidden.length === 0, `menu items hidden: ${JSON.stringify(headerMenu.hidden)}`);
    await shot(page, 'dark-1000-meetings-header-menu');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-mtg-head .ws-menu[open]', { state: 'detached' });
    // A tab chosen in the sections is the one the hash names.
    await page.click('.ws-dock-tab[data-tab="mtg-notes"]');
    await page.waitForFunction(() => location.hash === '#/meetings/mtg-philips/notes');
    // Notes beside Transcript: both are read and drawn, under one header on the first of them.
    const menu = '.ws-pane:has(.ws-dock-tab[data-tab="mtg-notes"]) .ws-dock-menu';
    await page.click(`${menu} > summary`);
    await page.click(`${menu} [data-action="dock-beside"]`);
    await page.waitForSelector('.ws-mtg-detail[data-panel="notes"] .ws-md h3');
    await page.waitForSelector('.ws-mtg-detail[data-panel="transcript"] #meeting-line-3');
    assert(await page.locator('.ws-mtg-head').count() === 1, 'one header');
    assert(await page.locator('.ws-pane:has(.ws-dock-tab[data-tab="mtg-transcript"]) .ws-mtg-head').count() === 1, 'above the first section with a meeting tab');
    await shot(page, 'dark-1000-meetings-sections');
    // In that narrow section the people scroll within three rows and the tab keeps its room.
    const room = await page.evaluate(() => {
      const pane = document.querySelector('.ws-pane:has(.ws-mtg-head)');
      const people = pane.querySelector('.ws-mtg-people-line');
      return { people: people.clientHeight, scrolls: people.scrollHeight > people.clientHeight, body: pane.querySelector(':scope > .ws-pane-body').clientHeight };
    });
    assert(room.people <= 96 && room.scrolls, `the people line scrolls within three rows: ${JSON.stringify(room)}`);
    assert(room.body >= 200, `the tab below the header keeps its room: ${JSON.stringify(room)}`);
    // Three sections are wider than the window: the row scrolls sideways and an update (a minute
    // tick, a tab chosen) keeps its place.
    const left = await page.evaluate(() => { const row = document.querySelector('.ws-dock[data-page="meetings"]'); row.scrollLeft = row.scrollWidth; return row.scrollLeft; });
    assert(left > 0, `the row scrolls sideways: ${left}`);
    await page.evaluate(() => window.__workspace.render());
    assert(await page.evaluate(() => document.querySelector('.ws-dock[data-page="meetings"]').scrollLeft) === left, 'a render keeps the row’s scroll');
    await page.locator('.ws-dock-tab[data-tab="mtg-tasks"]').dispatchEvent('click');
    await page.waitForSelector('.ws-mtg-detail[data-panel="tasks"]');
    assert(await page.evaluate(() => document.querySelector('.ws-dock[data-page="meetings"]').scrollLeft) === left, 'a tab chosen keeps the row’s scroll');
    assert(errors.length === 0, errors.join('\n'));
  });
  await context.close().catch(() => {});
}
