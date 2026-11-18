// Browser checks of Settings › Meetings (Task 5), run by workspace-e2e.mjs with its MOCKED native
// bridge: the fixture's meetings, templates and rules (withMeetings), and the library operations
// answered as library_ops.rs and MeetingSettings::apply do (refusals carry `field`). Transcripts &
// folders (Read Teams transcripts refused then allowed, the folder pattern, Change…, Show in
// Finder), Note templates (edit Meeting notes and save, Reset with Undo, add a skill, Edit the
// template from a document), Automatic rules (add, reorder, test a title, delete with Undo),
// Glossary & tags (typed and parsed without a re-render, then linked files) and Tasks. Both
// themes; 1440, 1000 and 1680 px; no horizontal overflow on any screen.
const dialog = '.ws-modal[open]';
const submit = `${dialog} .ws-modal-footer button[type=submit]`;
const toggleOf = action => `label.ws-switch:has([data-action="${action}"])`;

export async function meetingSettingsChecks({ open, check, assert, shot, quiet }) {
  const calls = async (page, op) => (await page.evaluate(() => window.__bridgeCalls)).filter(([o]) => o === op).map(([, d]) => d);
  const lastCall = async (page, op) => (await calls(page, op)).at(-1);
  const waitCall = (page, op, test = '() => true') => page.waitForFunction(([o, t]) => window.__bridgeCalls.some(([x, d]) => x === o && new Function('d', `return (${t})(d)`)(d)), [op, test]);
  const noOverflow = async (page, what) => {
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('.ws-main, .ws-settings-panels, .ws-settings-content, .ws-ms-editor, .ws-ms-tpl-card, .ws-ms-rule, .ws-ms-md-card, .ws-ms-file-row, .ws-ms-pattern-preview, .ws-ms-location, .ws-modal[open] .ws-modal-body')].filter(el => el.clientWidth > 0).map(el => el.scrollWidth - el.clientWidth)));
    assert(overflow <= 0, `${what} overflows by ${overflow}px`);
  };
  /** Waits until the page stops re-rendering (no DOM change for 200 ms). */
  const settled = (page, limit = 4000) => page.evaluate(limit => new Promise((resolve, reject) => {
    let timer;
    const finish = fn => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); fn(); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => finish(resolve), 200); });
    const cap = setTimeout(() => finish(() => reject(new Error(`still re-rendering after ${limit} ms`))), limit);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(() => finish(resolve), 200);
  }), limit);
  const tab = async (page, id) => {
    await page.click(`.ws-settings-nav button[data-tab="${id}"]`);
    await page.waitForSelector(`.ws-settings-nav button[data-tab="${id}"][aria-current="page"]`);
    await quiet(page);
  };
  const dialogShot = async (page, name) => {
    await page.waitForTimeout(300);
    await shot(page, name);
  };
  const active = page => page.evaluate(() => {
    const el = document.activeElement;
    return { action: el?.dataset?.action || el?.dataset?.commit || el?.dataset?.msInput || '', id: el?.dataset?.id || '', tag: el?.tagName };
  });

  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
      const tag = `${theme}-${width}`;
      const { page, context, errors } = await open({ theme, width, height, hash: '#/settings/meetings-transcripts', meetings: true, transcriptsOff: true });
      await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });

      await check(`${tag}: settings meetings transcripts and folders`, async () => {
        await page.waitForSelector('.ws-ms-location');
        assert(await page.locator('.ws-settings-nav .ws-nav-label', { hasText: 'Meetings' }).count() === 1, 'the Meetings group');
        const order = await page.locator('.ws-settings-nav button[data-tab^="meetings-"]').evaluateAll(els => els.map(b => b.dataset.tab));
        assert(order.join() === 'meetings-transcripts,meetings-templates,meetings-rules,meetings-glossary,meetings-tasks', order.join());
        const toggle = '[data-action="meetings-settings-transcripts"]';
        assert(!await page.locator(toggle).isChecked(), 'off to begin with');
        // Declined in Microsoft: stays off and says why.
        await page.evaluate(() => { window.__consentDeclined = true; });
        await page.click(toggleOf('meetings-settings-transcripts'));
        await page.waitForSelector(`${dialog}:has-text("Read Teams transcripts?")`);
        await page.click(submit);
        await page.waitForSelector('.ws-ms-pending');
        await page.waitForSelector('.ws-ms-reason:has-text("permission request was declined")');
        assert(!await page.locator(toggle).isChecked(), 'still off after a refusal');
        let connect = await lastCall(page, 'graph_connect');
        assert(['meetings', 'transcripts'].every(c => connect.capabilities.includes(c)), JSON.stringify(connect));
        await noOverflow(page, 'transcripts refused');
        await shot(page, `${tag}-settings-meetings-transcripts-refused`);
        // Allowed: on, with the account it reads as.
        await page.evaluate(() => { window.__consentDeclined = false; });
        await page.click(toggleOf('meetings-settings-transcripts'));
        await page.click(submit);
        await page.waitForFunction(sel => document.querySelector(sel)?.checked, toggle, { timeout: 6000 });
        assert(await page.locator('.ws-ms-reason').count() === 0, 'no reason once allowed');
        assert(/Connected as taylor\.morgan@example\.test/.test(await page.locator('.ws-setting-row:has([data-action="meetings-settings-transcripts"])').innerText()), 'the account');
        connect = await lastCall(page, 'graph_connect');
        assert(['calendar', 'mail', 'chats', 'meetings', 'transcripts'].every(c => connect.capabilities.includes(c)), 'keeps every other capability');
        // The folder name pattern: the preview follows it.
        await page.click('label.ws-ms-radio-card:has(input[value="date-title"])');
        await waitCall(page, 'settings_update', 'd => d.meetings?.folderPattern === "date-title"');
        await page.waitForSelector('input[name="folderPattern"][value="date-title"]:checked');
        const names = await page.locator('.ws-ms-pattern-preview code').allInnerTexts();
        assert(names.length === 3 && names.every(n => /^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}-]+\/$/u.test(n)), names.join(' | '));
        // Change…: a folder that isn't there is refused next to the location; one that is is used.
        await page.evaluate(() => { window.__meetingsPick = '/Volumes/Gone/Meetings'; });
        await page.click('[data-action="meetings-settings-root-pick"]');
        await page.waitForSelector('[data-error-for="meetings.root"]:has-text("That folder doesn’t exist")');
        await page.evaluate(() => { window.__dirs = ['/Volumes/Work/Meetings']; window.__meetingsPick = '/Volumes/Work/Meetings'; });
        await page.click('[data-action="meetings-settings-root-pick"]');
        await page.waitForSelector('.ws-ms-path:has-text("/Volumes/Work/Meetings")');
        assert(await page.locator('[data-error-for="meetings.root"]').count() === 0, 'the refusal is gone');
        assert(await page.locator('.ws-ms-location .ws-badge').count() === 0, 'no Default badge');
        assert(await page.locator('[data-action="meetings-settings-root-default"]').count() === 1, 'Use the default');
        // Undo goes back to the default folder; choosing it again keeps it, and Use the default works too.
        await page.click('.ws-toast:has-text("Meetings saved before keep their folders") .ws-toast-action');
        await page.waitForSelector('.ws-ms-location .ws-badge');
        await page.click('[data-action="meetings-settings-root-pick"]');
        await page.waitForSelector('.ws-ms-path:has-text("/Volumes/Work/Meetings")');
        await noOverflow(page, 'a custom folder');
        await shot(page, `${tag}-settings-meetings-transcripts`);
        await page.click('[data-action="meetings-settings-root-default"]');
        await page.waitForSelector('.ws-ms-location .ws-badge');
        assert(await page.locator('[data-action="meetings-settings-root-default"]').count() === 0, 'back to the default');
        await page.click('[data-action="meetings-settings-root-reveal"]');
        await waitCall(page, 'meetings_reveal');
        // Keep original .vtt is a switch on its row.
        await page.click(toggleOf('meetings-settings-set') + ':has([data-key="keepVtt"])');
        await waitCall(page, 'settings_update', 'd => d.meetings?.keepVtt === false');
      });

      await check(`${tag}: note templates: edit Meeting notes and save, reset with Undo, add a skill`, async () => {
        await tab(page, 'meetings-templates');
        await page.waitForSelector('.ws-ms-tpl-card[data-template="meeting-notes"]');
        assert(await page.locator('.ws-ms-tpl-card').count() === 2, 'the two built-ins');
        assert(/default/i.test(await page.locator('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-ms-tpl-badges').innerText()), 'Meeting notes is the default');
        await noOverflow(page, 'templates');
        await shot(page, `${tag}-settings-meetings-templates`);
        await page.click('.ws-ms-tpl-open[data-id="meeting-notes"]');
        await page.waitForSelector('.ws-ms-editor .ws-ms-editor-bar:has-text("Saved")');
        assert(await page.locator('.ws-settings-header h2').innerText() === 'Meeting notes', 'the editor names the template');
        assert(await page.locator('[data-action="meetings-settings-tpl-reset"]').count() === 0, 'no Reset before an edit');
        // The latest notes made with it: the Philips sync's document.
        await page.waitForSelector('.ws-ms-latest .ws-md h3');
        assert(/Philips CodeMie conversations syncup/.test(await page.locator('.ws-ms-latest .ws-mtg-card-head p').innerText()), 'which meeting');
        // Type at the end: only the bar changes, the textarea and its caret stay.
        const prompt = '[data-ms-input="tpl-prompt"]';
        await page.click(prompt);
        await page.$eval(prompt, el => { window.__prompt = el; el.setSelectionRange(el.value.length, el.value.length); });
        await page.keyboard.type('\nFocus on decisions. ');
        await page.waitForSelector('.ws-ms-editor-bar.ws-ms-dirty:has-text("Unsaved changes")');
        assert(await page.$eval(prompt, el => el === window.__prompt && document.activeElement === el && el.selectionStart === el.value.length), 'same textarea, caret at the end');
        await page.click('[data-action="meetings-settings-tpl-var"][data-v="{{wishes}}"]');
        assert(await page.$eval(prompt, el => el === window.__prompt && el.value.endsWith('Focus on decisions. {{wishes}}')), 'the variable goes in at the caret');
        await page.click('label.ws-check:has([data-action="meetings-settings-tpl-section"][data-s="risks"])');
        assert(await page.$eval(prompt, el => el === window.__prompt), 'a section never re-renders the editor');
        assert(await page.locator('[data-action="meetings-settings-tpl-section"][data-s="risks"]').isChecked(), 'Risks is ticked');
        await page.waitForTimeout(200);
        await noOverflow(page, 'the editor');
        await shot(page, `${tag}-settings-meetings-template-editor`);
        await page.click('[data-action="meetings-settings-tpl-save"]');
        await page.waitForSelector('.ws-ms-editor-bar:not(.ws-ms-dirty):has-text("Saved")');
        const saved = await lastCall(page, 'template_save');
        assert(saved.id === 'meeting-notes' && saved.prompt.endsWith('Focus on decisions. {{wishes}}') && saved.sections.at(-1) === 'risks', JSON.stringify(saved).slice(0, 200));
        await page.waitForSelector('.ws-toast:has-text("Saved “Meeting notes”")');
        await page.waitForSelector('[data-action="meetings-settings-tpl-reset"][data-id="meeting-notes"]');
        // Back to the list: Edited, and Reset to built-in in its menu, with Undo.
        await page.click('[data-action="meetings-settings-tpl-close"]');
        await page.waitForSelector('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-badge-warning:has-text("Edited")');
        assert((await active(page)).id === 'meeting-notes', 'focus back on its card');
        await page.click('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-menu > summary');
        await page.click('.ws-ms-tpl-card[data-template="meeting-notes"] [data-action="meetings-settings-tpl-reset"]');
        await page.waitForFunction(() => !document.querySelector('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-badge-warning'));
        await page.waitForFunction(() => document.activeElement?.matches('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-menu > summary'));
        await page.click('.ws-toast:has-text("back to the built-in version") .ws-toast-action');
        await page.waitForSelector('.ws-ms-tpl-card[data-template="meeting-notes"] .ws-badge-warning:has-text("Edited")');
        // Add a skill found on this Mac.
        await page.evaluate(() => { window.__skills = [{ name: 'interview-review', path: '/Users/qa/.claude/skills/interview-review/SKILL.md', description: 'Assessment of an interview you ran, judged against a role profile.' }]; });
        await page.click('[data-action="meetings-settings-skill-add"]');
        await page.waitForSelector(`${dialog}:has-text("Use a skill as a note template")`);
        assert(await page.locator(`${dialog} input[name="skill"]:checked`).count() === 1, 'the skill is picked');
        await noOverflow(page, 'the skill dialog');
        await dialogShot(page, `${tag}-settings-meetings-add-skill`);
        await page.click(submit);
        await page.waitForSelector('.ws-ms-tpl-card:has-text("Interview review") .ws-badge-purple');
        const skill = await lastCall(page, 'template_save');
        assert(skill.kind === 'skill' && skill.skillPath === '/Users/qa/.claude/skills/interview-review/SKILL.md', JSON.stringify(skill));
        // A path that isn't a skill is refused next to the field and the dialog stays.
        await page.click('[data-action="meetings-settings-skill-add"]');
        await page.waitForSelector(`${dialog} input[name="path"]`);
        await page.fill(`${dialog} input[name="path"]`, 'skills/x.md');
        await page.click(submit);
        await page.waitForSelector(`${dialog} [data-error-for="skillPath"]:has-text("full path")`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.ws-modal[open]'));
        await noOverflow(page, 'templates with a skill');
        // One of your own: New template, Save, then Delete (it asks first).
        await page.click('[data-action="meetings-settings-tpl-new"]');
        await page.waitForSelector('.ws-ms-editor-bar:has-text("Not saved yet")');
        assert((await active(page)).action === 'tpl-name', 'focus on its name');
        await page.fill('[data-ms-input="tpl-name"]', 'Client recap');
        await page.waitForSelector('.ws-settings-header h2:has-text("Client recap")');
        await page.click('[data-action="meetings-settings-tpl-save"]');
        await page.waitForSelector('.ws-ms-editor-bar:not(.ws-ms-dirty):has-text("Saved")');
        await page.click('[data-action="meetings-settings-tpl-close"]');
        await page.waitForSelector('.ws-ms-tpl-card:has-text("Client recap") .ws-badge-info');
        await noOverflow(page, 'templates of every kind');
        await shot(page, `${tag}-settings-meetings-templates-all`);
        const mine = await page.locator('.ws-ms-tpl-card:has-text("Client recap")').getAttribute('data-template');
        await page.click(`.ws-ms-tpl-card[data-template="${mine}"] .ws-menu > summary`);
        await page.click(`.ws-ms-tpl-card[data-template="${mine}"] [data-action="meetings-settings-tpl-delete"]`);
        await page.waitForSelector(`${dialog}:has-text("Delete “Client recap”?")`);
        await page.waitForTimeout(450);
        await page.click(submit);
        await page.waitForFunction(id => !document.querySelector(`.ws-ms-tpl-card[data-template="${id}"]`), mine);
        await page.waitForFunction(() => !document.querySelector('.ws-modal[open]') && document.activeElement?.dataset.action === 'meetings-settings-tpl-new');
      });

      if (width === 1440) {
        await check(`${tag}: Edit the template from a document opens that template`, async () => {
          await page.click('.ws-nav button[data-route=meetings]');
          await page.click('[data-action="meeting-filter"][data-filter="all"]');
          await page.click('.ws-mtg-row[data-id="mtg-philips"]');
          await page.waitForSelector('.ws-mtg-doc[data-doc="meeting-notes"] .ws-menu > summary');
          await settled(page);
          await page.click('.ws-mtg-doc[data-doc="meeting-notes"] .ws-menu > summary');
          await page.click('.ws-mtg-doc[data-doc="meeting-notes"] [data-action="settings-tab"][data-template="meeting-notes"]');
          await page.waitForSelector('.ws-ms-editor [data-ms-input="tpl-name"]');
          assert(await page.$eval('[data-ms-input="tpl-name"]', el => el.value) === 'Meeting notes', 'that template');
          assert(await page.evaluate(() => location.hash) === '#/settings/meetings-templates', 'the hash');
          await page.click('[data-action="meetings-settings-tpl-close"]');
          await page.waitForSelector('.ws-ms-tpl-grid');
        });
      }

      await check(`${tag}: automatic rules: add, reorder, test a title, delete with Undo`, async () => {
        await tab(page, 'meetings-rules');
        await page.waitForSelector('.ws-ms-rule[data-rule="r-standup"]');
        assert(await page.locator('.ws-ms-rules .ws-ms-rule').count() === 2, 'two rules');
        await page.click('[data-action="meetings-settings-rule-add"]');
        await page.waitForFunction(() => document.querySelectorAll('.ws-ms-rules .ws-ms-rule').length === 3 && document.activeElement?.dataset.commit === 'meetings-settings-rule-value');
        const id = (await active(page)).id;
        await page.keyboard.type('Philips');
        await page.keyboard.press('Enter');
        await waitCall(page, 'meeting_rule_save', `d => d.id === ${JSON.stringify(id)} && d.value === 'Philips'`);
        await page.selectOption(`.ws-ms-rule[data-rule="${id}"] select[data-k="template"]`, 'short-summary');
        await waitCall(page, 'meeting_rule_save', `d => d.id === ${JSON.stringify(id)} && d.template === 'short-summary'`);
        // Move it above the Philips company rule; focus stays on it.
        await settled(page);
        await page.click(`[data-action="meetings-settings-rule-move"][data-id="${id}"][data-d="-1"]`);
        await waitCall(page, 'meeting_rule_order');
        await page.waitForFunction(i => document.querySelectorAll('.ws-ms-rules .ws-ms-rule')[1]?.dataset.rule === i, id);
        await page.waitForFunction(i => document.activeElement?.dataset.id === i, id);
        // The tester follows the order as it is typed.
        await page.fill('[data-ms-input="test-title"]', 'Philips weekly sync');
        await page.fill('[data-ms-input="test-people"]', '4');
        await page.waitForSelector('.ws-ms-test-result:has-text("Short summary"):has-text("Rule 2: title contains “Philips”")');
        assert((await active(page)).action === 'test-people', 'the tester keeps focus');
        await noOverflow(page, 'rules');
        await shot(page, `${tag}-settings-meetings-rules`);
        // Delete it: focus moves to the next rule; Undo puts it back where it was.
        await page.click(`[data-action="meetings-settings-rule-delete"][data-id="${id}"]`);
        await page.waitForFunction(() => document.querySelectorAll('.ws-ms-rules .ws-ms-rule').length === 2);
        await page.waitForFunction(() => document.activeElement?.dataset.action === 'meetings-settings-rule-delete' && document.activeElement?.dataset.id === 'r-philips');
        await page.click('.ws-toast:has-text("Rule deleted") .ws-toast-action');
        await page.waitForFunction(i => document.querySelectorAll('.ws-ms-rules .ws-ms-rule')[1]?.dataset.rule === i, id);
        await page.waitForFunction(i => document.activeElement?.dataset.id === i, id);
        await page.waitForSelector('.ws-ms-test-result:has-text("Rule 2")');
      });

      await check(`${tag}: glossary typed and parsed without a re-render, then linked files`, async () => {
        await tab(page, 'meetings-glossary');
        const area = '[data-ms-input="md"][data-k="glossary"]';
        await page.waitForSelector(area);
        await page.click(area);
        await page.$eval(area, el => { window.__md = el; el.setSelectionRange(el.value.length, el.value.length); });
        await page.keyboard.type('- **Jeroen** — heard as “Yeroen”');
        await page.waitForSelector('[data-md-summary="glossary"] .ws-ms-md-pairs li:has-text("Yeroen"):has-text("Jeroen")');
        assert(await page.$eval(area, el => el === window.__md && document.activeElement === el && el.selectionStart === el.value.length), 'same textarea, caret at the end');
        await page.waitForSelector('[data-md-status="glossary"]:has-text("Saved")');
        const saved = await lastCall(page, 'meeting_text_save');
        assert(saved.name === 'glossary' && saved.text.endsWith('- **Jeroen** — heard as “Yeroen”'), JSON.stringify(saved));
        assert(await page.$eval(area, el => el === window.__md), 'saving never re-renders the editor');
        await noOverflow(page, 'the glossary');
        await shot(page, `${tag}-settings-meetings-glossary`);
        // Preview, then Write again with the text kept.
        await page.click('[data-action="meetings-settings-md-tab"][data-k="glossary"][data-v="preview"]');
        await page.waitForSelector('[data-md-card="glossary"] .ws-ms-md-preview strong:has-text("Jeroen")');
        await page.click('[data-action="meetings-settings-md-tab"][data-k="glossary"][data-v="write"]');
        assert((await page.$eval(area, el => el.value)).includes('Yeroen'), 'the text is kept');
        // Restore the example (tags), with Undo.
        await page.click('[data-action="meetings-settings-md-reset"][data-k="tags"]');
        await page.waitForSelector('[data-md-summary="tags"]:has-text("10 tags")');
        await page.click('.ws-toast:has-text("back to the example") .ws-toast-action');
        await page.waitForSelector('[data-md-summary="tags"]:has-text("0 tags")');
        // Files I already keep: two paths, read-only, nothing to restore.
        await page.evaluate(() => {
          window.__files = { '/Users/qa/knowledge/TERMS_TAXONOMY.md': '## Me\n**Taylor Morgan** — also “Taylor”\n\n## Terms\n- **LiteLLM** — heard as “light LLM”\n', '/Users/qa/knowledge/TAG_TAXONOMY.md': '- `meeting`\n- `pilot`\n' };
        });
        await page.click('label.ws-ms-radio-card:has(input[value="file"])');
        await page.waitForSelector('[data-commit="meetings-settings-field"][data-key="glossaryFile"]');
        await page.fill('[data-key="glossaryFile"]', 'knowledge/TERMS_TAXONOMY.md');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-error-for="meetings.glossaryFile"]:has-text("full path")');
        await page.fill('[data-key="glossaryFile"]', '/Users/qa/knowledge/TERMS_TAXONOMY.md');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('[data-error-for="meetings.glossaryFile"]'));
        await page.fill('[data-key="tagsFile"]', '/Users/qa/knowledge/TAG_TAXONOMY.md');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-md-card="tags"] .ws-ms-md-linked:has-text("/Users/qa/knowledge/TAG_TAXONOMY.md")');
        await page.waitForSelector('[data-md-card="glossary"] .ws-ms-md-linked:has-text("Read from")');
        await page.waitForSelector('[data-md-summary="glossary"] .ws-ms-md-pairs li:has-text("LiteLLM")');
        assert(await page.locator('[data-ms-input="md"]').count() === 0, 'no editor for a linked file');
        assert(await page.locator('[data-action="meetings-settings-md-reset"]').count() === 0, 'nothing to restore');
        assert(await page.locator('[data-action="meetings-settings-md-tab"]').count() === 0, 'no Write/Preview');
        await noOverflow(page, 'linked files');
        await shot(page, `${tag}-settings-meetings-glossary-linked`);
        // Back here in Connect: the typed glossary is still there.
        await page.click('label.ws-ms-radio-card:has(input[value="connect"])');
        await page.waitForSelector(`${area}`);
        await page.waitForFunction(sel => document.querySelector(sel)?.value.includes('Yeroen'), area);
      });

      await check(`${tag}: tasks settings and no page errors`, async () => {
        await tab(page, 'meetings-tasks');
        await page.waitForSelector('[data-key="columns.todo"]');
        await page.click(toggleOf('meetings-settings-set') + ':has([data-key="review"])');
        await waitCall(page, 'settings_update', 'd => d.meetings?.review === false');
        await page.waitForFunction(() => document.querySelector('[data-key="review"]') && !document.querySelector('[data-key="review"]').checked);
        await page.fill('[data-key="columns.todo"]', 'Next up');
        await page.keyboard.press('Enter');
        await waitCall(page, 'settings_update', 'd => d.meetings?.columns?.todo === "Next up"');
        await page.waitForSelector('.ws-setting-row:has([data-key="review"]):has-text("“Next up”")');
        // Its usual name again: the custom one is removed.
        await page.fill('[data-key="columns.todo"]', '');
        await page.keyboard.press('Enter');
        await waitCall(page, 'settings_update', 'd => d.meetings?.columns && d.meetings.columns.todo === null');
        await page.selectOption('select[data-key="doneDays"]', '30');
        await waitCall(page, 'settings_update', 'd => d.meetings?.doneDays === 30');
        await noOverflow(page, 'tasks');
        await shot(page, `${tag}-settings-meetings-tasks`);
        assert(errors.length === 0, errors.join('\n'));
      });
      await context.close().catch(() => {});
    }
  }
}
