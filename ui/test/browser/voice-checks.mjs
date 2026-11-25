// Browser checks of reply in the user's voice (spec
// docs/superpowers/specs/2026-11-25-reply-voice-design.md §5, §6, §10, §11, § Copy), run by
// workspace-e2e.mjs with its MOCKED native bridge. Run alone with `WORKSPACE_E2E_ONLY=voice`.
// V1–V13 below: Settings › Your voice across both views/themes/three widths, each provider state's
// line, the style card and instruction edits (one write each, refusals beside the field), the
// provider radio and facts, Refresh now and Delete Connect's copy (Return cancels), a draft's
// " · in your voice" and Context lines, the role's sheet line, Default/Compact parity, nothing
// sent or kept by drawing, and the skill import's pick, preview, Shorten with AI, save and layout.
// `open({ voice: '<state>' })` takes a voice-states.json state, `draftVoice: true` gives drafts
// draft-ai-voice.json's `provenance.voice`, `replyPlugin: true` offers an invented reply-context
// plugin; `window.__voiceRefuse = {op, message, field?}` refuses that op once and
// `window.__skillsFolder` is what the skills folder pick answers (null cancels).
import { noClip, FIXED_NOW } from './compact-checks.mjs';

const HASH = '#/settings/voice';
const dialog = '.ws-modal[open]';
const submit = `${dialog} .ws-modal-footer button[type=submit]`;
const SKILLS = '/Users/qa/Skills/voice-skills';
const SHEET_LINE = 'Shape your replies: Connect asks it how you write, about the people you write to and for notes on the names and codes in a message, and adds what it answers to your AI drafts. It can read the text of messages you sent that Connect has synced.';
const PRIVACY = "Connect keeps a copy on this Mac and adds the parts that fit to each reply draft, including drafts automations make. Facts are looked up for each draft and never kept. It goes only to the AI profile that writes the draft: the one your Mail and Teams replies use (Settings › AI), or an automation's own.";
/** voice-states.json's six rules in matching order, as their rows name them. */
const SCOPES = ['To priya.n@example.test', 'In the chat “Platform review”', 'Anyone at bank.example.test · mail only', 'About “budget request”', 'Anyone without a profile · Teams only', 'Everyone'];
/** voice-states.json's copy time (1764000000) in Europe/Kyiv, on a day other than FIXED_NOW's. */
const COPY_AT = 'Nov 24, 06:00 PM';
/** voice-import-preview.json's skipped skills, as § 11 words their reasons. */
const SKIPPED = [
  ['broken', 'Its SKILL.md has no name in its frontmatter.'],
  ['deploy-helper', 'A procedure that runs tools. It waits for the skill runner, a later step.'],
  ['meeting-notes', 'Not about how you write messages.'],
];

const text = (page, selector) => page.locator(selector).first().innerText();
const squash = s => String(s).replace(/\s+/g, ' ').trim();
/** reply-checks.mjs's `noOverflow` pattern. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.getElementById('workspace-main').scrollWidth - document.getElementById('workspace-main').clientWidth));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};
/** Every `voice_*` op and `pick_folder` the mock recorded, oldest first: [op, data]. */
const voiceOps = page => page.evaluate(() => window.__bridgeCalls.filter(([op]) => /^voice_/.test(op) || op === 'pick_folder'));
const ready = async (page, settled) => {
  await page.waitForSelector('.ws-voice-card');
  await settled(page);
};
const refuseNext = (page, value) => page.evaluate(v => { window.__voiceRefuse = v; }, value);
const viewSettings = view => (view === 'compact' ? { view: 'compact' } : null);
/** Opens the import preview: the pick answers `folder`, then the scan. */
const openImport = async (page, settled, folder = SKILLS) => {
  await page.evaluate(f => { window.__skillsFolder = f; }, folder);
  await page.click('[data-action="voice-import"]');
  await page.waitForSelector('.ws-voice-import');
  await settled(page);
};
/** Scrolls `selector` to the top of the page's scroller, for a screenshot of what lies below. */
const scrollTo = (page, selector) => page.locator(selector).evaluate(el => el.scrollIntoView({ block: 'start' }));
/** A provider that can't look facts up keeps the saved choice, disabled, with `hint`; a click on
 *  it sends no voice_set (review fix: spec §6, drafts from the copy get no facts). */
const factsHeld = async (page, hint) => {
  const box = page.locator('[data-voice-facts]');
  if (!(await box.isChecked())) throw new Error('the facts checkbox lost its saved value');
  if (!(await box.isDisabled())) throw new Error('the facts checkbox is enabled although drafts get no facts');
  const got = squash(await text(page, '#ws-voice-facts-hint'));
  if (got !== hint) throw new Error(`facts hint: ${got}`);
  await box.click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
  const sets = await page.evaluate(() => window.__bridgeCalls.filter(([op]) => op === 'voice_set').length);
  if (sets !== 0) throw new Error(`a click on the held facts checkbox sent ${sets} voice_set`);
};
const toastText = page => page.locator('.ws-toast').allInnerTexts().then(list => list.map(squash));

export async function voiceChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- V1: the tab, both themes, both views, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context, errors } = await open({ theme, width, height: 900, hash: HASH, voice: 'ready', settings: viewSettings(view) });
        await check(`voice V1: ${theme} ${view} ${width}`, async () => {
          await ready(page, settled);
          assert(await page.locator('input[name="voice-provider"]').count() === 2, 'Off and Knowledge radios');
          assert(await page.locator('input[name="voice-provider"][value="plugin:knowledge"]').isChecked(), 'Knowledge is chosen');
          assert(squash(await text(page, '.ws-voice-legend')) === 'Where your voice comes from', 'radio title');
          const line = squash(await text(page, '#ws-voice-state-plugin_knowledge'));
          assert(line === 'Ready · 3 people · style card · 6 instructions', `state line: ${line}`);
          assert(await page.locator('[data-voice-facts]').isChecked() && !(await page.locator('[data-voice-facts]').isDisabled()), 'facts checkbox on');
          assert(squash(await text(page, '.ws-voice-facts')).startsWith('Add facts from Knowledge'), 'facts label');
          assert(squash(await text(page, '[data-voice-style]')).startsWith('Short and direct.'), 'style card text');
          const head = squash(await text(page, '[data-voice-style-head]'));
          assert(head === 'From your page people/me.md · edit it in Knowledge Prefers short replies and plain words.', `style head: ${head}`);
          const scopes = (await page.locator('.ws-voice-rules .ws-voice-rule .ws-voice-scope').allInnerTexts()).map(squash);
          assert(JSON.stringify(scopes) === JSON.stringify(SCOPES), `scope labels: ${JSON.stringify(scopes)}`);
          assert(squash(await text(page, '#ws-voice-people-title')) === 'People (3)', 'People (3)');
          assert(squash(await text(page, '[data-voice-person="marek-novak"]')).includes('Teams only'), 'Marek is Teams only');
          assert(squash(await text(page, '.ws-voice-privacy')) === PRIVACY, 'privacy line');
          const copy = squash(await text(page, '.ws-voice-copy'));
          assert(copy.startsWith("Connect's copy · refreshed ") && copy.includes('Refresh now') && copy.includes("Delete Connect's copy"), `copy row: ${copy}`);
          await noOverflow(page, assert, 'Your voice');
          const clipped = await noClip(page);
          assert(clipped.length === 0, `clipped: ${clipped.join(' | ')}`);
          await shot(page, `voice-${theme}-${view}-${width}`);
          await scrollTo(page, '#ws-voice-rules-title');
          await shot(page, `voice-${theme}-${view}-${width}-rules`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- V2: each state's line

  for (const theme of ['dark', 'light']) {
    const states = {
      off: async page => {
        assert(await page.locator('input[name="voice-provider"][value="off"]').isChecked(), 'Off chosen');
        assert(squash(await text(page, '#ws-voice-state-off')) === 'Drafts use only the conversation.', 'Off hint');
        assert(await page.locator('.ws-voice-copy').count() === 0, 'no copy row with Off and no copy');
        assert(squash(await text(page, '#ws-voice-import-off')) === 'Choose where your voice comes from first.', 'Off note');
      },
      offWithCopy: async page => {
        const copy = squash(await text(page, '.ws-voice-copy'));
        assert(copy.startsWith(`Off. Connect still keeps a copy from ${COPY_AT}.`), `copy row: ${copy}`);
        assert(await page.locator('[data-action="voice-refresh"]').count() === 0, 'no Refresh now with Off');
      },
      needsSetup: async page => {
        assert(squash(await text(page, '#ws-voice-state-plugin_knowledge')) === 'Choose its folder in Knowledge first.', 'needs_setup line');
        assert(squash(await text(page, '[data-action="voice-setup"]')) === 'Set up in Knowledge', 'Set up button');
      },
      unavailable: async page => {
        const line = squash(await text(page, '#ws-voice-state-plugin_knowledge'));
        assert(line === `Knowledge isn't answering. Drafts use Connect's copy from ${COPY_AT}.`, `unavailable line: ${line}`);
        await factsHeld(page, "Knowledge isn't available, so drafts get no facts.");
      },
      pluginOff: async page => {
        assert(squash(await text(page, '#ws-voice-state-plugin_knowledge')) === 'Turned off in Settings › Plugins', 'plugin off line');
        assert(squash(await text(page, '[data-action="voice-turn-on"]')) === 'Turn on', 'Turn on button');
        await factsHeld(page, 'Knowledge is turned off, so drafts get no facts.');
      },
      loading: async page => {
        assert(squash(await text(page, '#ws-voice-state-plugin_knowledge')) === 'Starting Knowledge…', 'loading line');
      },
      noFacts: async page => {
        assert(await page.locator('[data-voice-facts]').isDisabled(), 'facts checkbox is disabled');
        assert(squash(await text(page, '#ws-voice-facts-hint')) === "Knowledge doesn't look up facts.", 'not offered hint');
      },
    };
    for (const [state, expect] of Object.entries(states)) {
      const { page, context, errors } = await open({ theme, width: 1000, height: 900, hash: HASH, voice: state, now: FIXED_NOW });
      await check(`voice V2 (${theme}): ${state} shows its line`, async () => {
        await ready(page, settled);
        await expect(page);
        await shot(page, `voice-states-${theme}-${state}`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- V3: the style card and instruction edits

  {
    const readOnly = snapshot => { snapshot.replyVoice.rules.find(r => r.id === 'everyone').editable = false; };
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready', patch: readOnly });
    await check('voice V3: style and instruction edits send one write each, a refusal stays beside the field', async () => {
      await ready(page, settled);
      // The style card: the head is never in the textarea; Save is one voice_save.
      await page.click('[data-action="voice-edit-style"]');
      await page.waitForSelector('#ws-voice-style-text');
      const area = await page.inputValue('#ws-voice-style-text');
      assert(area.startsWith('Short and direct.') && !area.includes('Prefers short replies'), `the textarea holds the head: ${area}`);
      await page.fill('#ws-voice-style-text', 'Short and direct. VOICE_SENTINEL_9f3a');
      await page.click('[data-action="voice-save-style"]');
      await page.waitForSelector('#ws-voice-style-text', { state: 'detached' });
      const styles = await calls(page, 'voice_save');
      assert(styles.length === 1 && styles[0].kind === 'style' && styles[0].text === 'Short and direct. VOICE_SENTINEL_9f3a', JSON.stringify(styles));
      // A refused style save keeps the text and says why under the field.
      await page.click('[data-action="voice-edit-style"]');
      await page.fill('#ws-voice-style-text', 'Too long, as the provider says');
      await refuseNext(page, { op: 'voice_save', message: 'Keep the style card under 8,000 characters.', field: 'text' });
      await page.click('[data-action="voice-save-style"]');
      await page.waitForSelector('#ws-voice-style-error');
      assert(squash(await text(page, '#ws-voice-style-error')) === 'Keep the style card under 8,000 characters.', 'style refusal sentence');
      assert(await page.inputValue('#ws-voice-style-text') === 'Too long, as the provider says', 'the refused style text stays');
      await page.click('[data-action="voice-cancel"]');

      // The rule editor: six kinds and Only in; a chat rule saves {kind, value, channel}.
      const before = (await calls(page, 'voice_save')).length;
      await page.click('[data-action="voice-add-rule"]');
      await page.waitForSelector('#ws-voice-rule-kind');
      const kinds = await page.locator('#ws-voice-rule-kind option').allInnerTexts();
      assert(JSON.stringify(kinds) === JSON.stringify(["A person's address", 'A Teams chat', 'Anyone at a domain', 'A topic', 'Anyone without a profile', 'Everyone']), `kinds: ${kinds}`);
      const channels = await page.locator('#ws-voice-rule-channel option').allInnerTexts();
      assert(JSON.stringify(channels) === JSON.stringify(['Mail and Teams', 'Mail only', 'Teams only']), `Only in: ${channels}`);
      await page.selectOption('#ws-voice-rule-kind', 'chat');
      await page.waitForSelector('#ws-voice-rule-value');
      assert(squash(await text(page, 'label[for="ws-voice-rule-value"]')) === 'Chat title', 'the chat value label');
      await page.fill('#ws-voice-rule-value', 'Design sync');
      await page.selectOption('#ws-voice-rule-channel', 'teams');
      await page.fill('#ws-voice-rule-text', 'Short, no greeting.');
      await page.click('[data-action="voice-save-rule"]');
      await page.waitForSelector('#ws-voice-rule-kind', { state: 'detached' });
      const added = (await calls(page, 'voice_save')).slice(before);
      assert(added.length === 1, `Add sent ${added.length} voice_save`);
      assert(JSON.stringify(added[0].applies) === JSON.stringify({ kind: 'chat', value: 'Design sync', channel: 'teams' }) && added[0].text === 'Short, no greeting.' && added[0].id === null, JSON.stringify(added[0]));
      await page.waitForSelector('.ws-voice-rule .ws-voice-scope:text-is("In the chat “Design sync” · Teams only")');

      // Edit: one voice_save with the rule's id.
      await page.click('[data-voice-rule="topic-budget-request"] [data-action="voice-edit-rule"]');
      await page.waitForSelector('#ws-voice-rule-text');
      assert(await page.inputValue('#ws-voice-rule-text') === 'Ask for the project code.', 'Edit fills the text');
      await page.fill('#ws-voice-rule-text', 'Ask for the cost code.');
      await page.click('[data-action="voice-save-rule"]');
      await page.waitForSelector('#ws-voice-rule-text', { state: 'detached' });
      const edited = (await calls(page, 'voice_save')).slice(before + 1);
      assert(edited.length === 1 && edited[0].id === 'topic-budget-request' && edited[0].text === 'Ask for the cost code.', JSON.stringify(edited));

      // Delete: one voice_delete; Undo: one voice_save of the same rule.
      await page.click('[data-voice-rule="domain-bank-example-test"] [data-action="voice-delete-rule"]');
      await page.waitForSelector('.ws-toast:has-text("Instruction deleted.") .ws-toast-action');
      const deletes = await calls(page, 'voice_delete');
      assert(deletes.length === 1 && deletes[0].id === 'domain-bank-example-test', JSON.stringify(deletes));
      assert(await page.locator('[data-voice-rule="domain-bank-example-test"]').count() === 0, 'the deleted rule is gone');
      await page.click('.ws-toast:has-text("Instruction deleted.") .ws-toast-action');
      await page.waitForSelector('.ws-voice-rule .ws-voice-scope:text-is("Anyone at bank.example.test · mail only")');
      const undone = (await calls(page, 'voice_save')).slice(before + 2);
      assert(undone.length === 1 && undone[0].text === 'Formal, full sentences.' && JSON.stringify(undone[0].applies) === JSON.stringify({ kind: 'domain', value: 'bank.example.test', channel: 'mail' }), JSON.stringify(undone));

      // A refused rule save: the sentence beside the field, the typed text kept.
      await page.click('[data-action="voice-add-rule"]');
      await page.waitForSelector('#ws-voice-rule-text');
      await page.fill('#ws-voice-rule-text', 'Keep this text');
      await refuseNext(page, { op: 'voice_save', message: 'Write what to do, up to 2,000 characters.', field: 'text' });
      await page.click('[data-action="voice-save-rule"]');
      await page.waitForSelector('#ws-voice-rule-text-error');
      assert(squash(await text(page, '#ws-voice-rule-text-error')) === 'Write what to do, up to 2,000 characters.', 'rule refusal sentence');
      assert(await page.inputValue('#ws-voice-rule-text') === 'Keep this text', 'the refused rule text stays');
      assert(await page.locator('#ws-voice-rule-text').getAttribute('aria-describedby') === 'ws-voice-rule-text-error', 'the field names its error');
      await page.click('[data-action="voice-cancel"]');

      // A read-only rule names its source and has no Edit.
      const row = page.locator('[data-voice-rule="everyone"]');
      assert(await row.locator('[data-action="voice-edit-rule"]').count() === 0, 'a read-only rule has Edit');
      assert(squash(await row.innerText()).endsWith('From Voice/rules.md · edit it in Knowledge'), `read-only row: ${await row.innerText()}`);
      await shot(page, 'voice-edits-dark');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V4: the provider radio and facts

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready' });
    await check('voice V4: Knowledge, Off and facts send one voice_set each; a refusal puts the radio back', async () => {
      await ready(page, settled);
      await page.locator('[data-voice-facts]').click({ force: true });
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'voice_set').length === 1);
      await settled(page);
      let sets = await calls(page, 'voice_set');
      assert(sets.length === 1 && JSON.stringify(sets[0]) === JSON.stringify({ provider: 'plugin:knowledge', facts: false }), JSON.stringify(sets));
      assert(!(await page.locator('[data-voice-facts]').isChecked()), 'facts stays off after its save');

      // A refused Off: the radio goes back to Knowledge.
      await refuseNext(page, { op: 'voice_set', message: 'Turn Knowledge on in Settings › Plugins first.' });
      await page.locator('input[name="voice-provider"][value="off"]').click({ force: true });
      await page.waitForSelector('.ws-toast:has-text("Turn Knowledge on in Settings › Plugins first.")');
      await settled(page);
      assert(await page.locator('input[name="voice-provider"][value="plugin:knowledge"]').isChecked(), 'the refused radio did not go back');
      sets = await calls(page, 'voice_set');
      assert(sets.length === 2 && sets[1].provider === 'off', JSON.stringify(sets));

      await page.locator('input[name="voice-provider"][value="off"]').click({ force: true });
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'voice_set').length === 3);
      await settled(page);
      assert(await page.locator('input[name="voice-provider"][value="off"]').isChecked(), 'Off is chosen');
      await page.locator('input[name="voice-provider"][value="plugin:knowledge"]').click({ force: true });
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'voice_set').length === 4);
      await settled(page);
      sets = await calls(page, 'voice_set');
      assert(JSON.stringify(sets.slice(2)) === JSON.stringify([{ provider: 'off' }, { provider: 'plugin:knowledge' }]), JSON.stringify(sets));
      assert(await page.locator('input[name="voice-provider"][value="plugin:knowledge"]').isChecked(), 'Knowledge is chosen again');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V5: Refresh now and Delete Connect's copy

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready' });
    await check("voice V5: Refresh now sends voice_refresh; Delete asks first, Return cancels, Delete copy sends one voice_forget", async () => {
      await ready(page, settled);
      await page.click('[data-action="voice-refresh"]');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op]) => op === 'voice_refresh'));
      await settled(page);
      assert((await calls(page, 'voice_refresh')).length === 1, 'one voice_refresh');

      await page.click('[data-action="voice-forget"]');
      await page.waitForSelector(`${dialog} .ws-modal-header h2`);
      await page.waitForTimeout(200);
      assert(squash(await text(page, `${dialog} .ws-modal-header h2`)) === "Delete Connect's copy of your voice?", 'dialog title');
      assert(squash(await text(page, `${dialog} .ws-modal-text`)) === 'Connect stops adding your voice to drafts and turns it off. Your Knowledge folder is not touched; choose Knowledge again to make a new copy.', 'dialog body');
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
      assert(focused === 'Cancel', `focus is on ${focused}`);
      await shot(page, 'voice-delete-dark');
      await page.keyboard.press('Enter');
      await page.waitForSelector(dialog, { state: 'detached' });
      assert((await calls(page, 'voice_forget')).length === 0, 'Return deleted the copy');

      await page.click('[data-action="voice-forget"]');
      await page.waitForSelector(submit);
      assert(squash(await text(page, submit)) === 'Delete copy', 'the dialog button');
      // The dialog ignores a submit in its first moments (ui.js COMMIT_GUARD_MS), as a double click.
      await page.waitForTimeout(500);
      await page.click(submit);
      await page.waitForSelector(dialog, { state: 'detached' });
      await settled(page);
      assert((await calls(page, 'voice_forget')).length === 1, 'one voice_forget');
      assert(await page.locator('input[name="voice-provider"][value="off"]').isChecked() && await page.locator('.ws-voice-copy').count() === 0, 'Off and no copy after the delete');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V6: a draft's voice and facts

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/inbox', voice: 'ready', draftVoice: true, enable: ['mail_send'] });
    await check('voice V6: the Priya mail\'s draft says " · in your voice" and Context lists the voice, the facts and each fallback', async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await page.waitForSelector('.ws-read[data-message-id="m-reply-1"] .ws-reply-bar');
      await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
      await page.waitForSelector('.ws-draft-provenance', { timeout: 6000 });
      const label = squash(await text(page, '.ws-draft-source'));
      assert(/ · in your voice Context$/.test(label), `provenance: ${label}`);
      await page.click('[data-action="ai-draft-context"]');
      const lines = async () => (await page.locator('#draft-context .ws-draft-voice').allInnerTexts()).map(squash);
      let got = await lines();
      assert(JSON.stringify(got) === JSON.stringify(['Your voice (Knowledge): style card · 1 instruction · 2 earlier messages', 'Facts from Knowledge: Atlas rollout · EPM-1234']), `Context: ${JSON.stringify(got)}`);
      await shot(page, 'voice-draft-dark');
      // The copy, cut and facts-missed variants, each on a fresh draft of the same mail.
      const variants = [
        [{ from: 'copy', at: 1764000000 }, `Connect's copy from ${COPY_AT} — Knowledge didn't answer.`],
        [{ cut: true }, 'Shortened to fit.'],
        [{ facts: [], factsMissed: true }, 'Knowledge found no facts in time.'],
      ];
      for (const [patch, line] of variants) {
        await page.evaluate(p => { window.__draftVoice = { ...window.__draftVoice, cut: false, from: 'provider', factsMissed: false, ...p }; }, patch);
        await page.click('[data-action="ai-draft-regenerate"]');
        await page.waitForFunction(l => [...document.querySelectorAll('#draft-context .ws-draft-voice')].some(el => el.textContent.trim() === l), line, { timeout: 6000 });
        got = await lines();
        assert(got.includes(line), `${line} missing: ${JSON.stringify(got)}`);
        if (patch.factsMissed) assert(!got.some(l => l.startsWith('Facts from')), `facts listed although missed: ${JSON.stringify(got)}`);
      }
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V7: the role's sheet line

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/settings/plugins', replyPlugin: true });
    await check('voice V7: installing a reply-context plugin shows the role\'s sheet line verbatim', async () => {
      await page.waitForSelector('[data-action="market-add"]');
      await page.click('[data-action="market-add"]');
      await page.waitForSelector(`${dialog} #market-source`);
      await page.click(`${dialog} [data-action="market-pick"]`);
      await page.waitForFunction(() => document.querySelector('#market-source')?.value === '/Users/qa/Plugins/acme-market');
      await page.click(submit);
      await page.waitForSelector('.ws-offer[data-plugin-id="reply-notes"]');
      await page.click('.ws-offer[data-plugin-id="reply-notes"] .ws-offer-open');
      await page.waitForSelector('#plugin-sheet [data-key="provides_reply-context"]');
      const line = squash(await text(page, '#plugin-sheet [data-key="provides_reply-context"] .ws-sheet-copy'));
      assert(line === SHEET_LINE, `sheet line: ${line}`);
      await page.click('[data-action="plugin-install"]');
      await page.waitForSelector(`${dialog} #plugin-consent [data-key="provides_reply-context"]`);
      const consent = squash(await text(page, `${dialog} #plugin-consent [data-key="provides_reply-context"] .ws-sheet-copy`));
      assert(consent === SHEET_LINE, `consent line: ${consent}`);
      await page.waitForTimeout(350);
      await shot(page, 'voice-sheet-dark');
      await page.locator(`${dialog} [name=agree]`).first().check({ force: true });
      await page.waitForTimeout(450);
      await page.click(submit);
      await page.waitForSelector(dialog, { state: 'detached' });
      const installs = await calls(page, 'install');
      assert(installs.length === 1 && installs[0].id === 'reply-notes' && JSON.stringify(installs[0].agreed) === JSON.stringify(['provides_reply-context']), JSON.stringify(installs));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V8: Default/Compact parity

  {
    const normalize = html => html.replace(/\s(id|for|aria-controls|aria-describedby|aria-labelledby)="[^"]*"/g, '');
    const capture = async settings => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready', now: FIXED_NOW, settings });
      await ready(page, settled);
      const card = normalize(await page.locator('.ws-voice-card').evaluate(el => el.outerHTML));
      await openImport(page, settled);
      const preview = normalize(await page.locator('.ws-voice-import').evaluate(el => el.outerHTML));
      return { context, card, preview };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('voice V8: the card and the import preview draw the same markup in Default and Compact (ids stripped)', async () => {
      assert(def.card === compact.card, `card markup differs:\n${def.card}\n${compact.card}`);
      assert(def.preview === compact.preview, `preview markup differs:\n${def.preview}\n${compact.preview}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V9: nothing sent or kept by drawing

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: '#/inbox', voice: 'ready', draftVoice: true });
    await check('voice V9: the tab and the composer send no voice op but Profile\'s voice_read, and localStorage keeps no voice text', async () => {
      await page.click('.ws-inbox-row[data-id="m-reply-1"]');
      await page.waitForSelector('.ws-read[data-message-id="m-reply-1"] .ws-reply-bar');
      await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
      await page.waitForSelector('.ws-draft-provenance', { timeout: 6000 });
      await page.click('[data-action="ai-draft-context"]');
      await settled(page);
      await page.evaluate(() => window.__workspace.route('settings', 'voice'));
      await ready(page, settled);
      let ops = await voiceOps(page);
      assert(ops.length === 0, `drawing sent ${JSON.stringify(ops)}`);

      await page.click('[data-voice-person="priya-n"] [data-action="voice-person"]');
      await page.waitForSelector(`${dialog} .ws-voice-dialog-head`);
      const body = squash(await text(page, `${dialog} .ws-modal-body`));
      assert(body.includes('How to write to them') && body.includes('About them') && body.includes('From People/priya-n.md. Edit it in Knowledge.'), `profile: ${body}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector(dialog, { state: 'detached' });
      ops = await voiceOps(page);
      assert(ops.length === 1 && ops[0][0] === 'voice_read' && ops[0][1].id === 'priya-n', JSON.stringify(ops));

      // The import preview is drawn too, so skill text has had its chance to be kept.
      await openImport(page, settled);
      await page.click('[data-action="voice-import-cancel"]');
      const stored = await page.evaluate(() => Object.keys(localStorage).map(k => `${k}=${localStorage.getItem(k)}`).join('\n'));
      const voiceTexts = ['Short and direct.', 'Prefers short replies', 'Terse, lower case.', 'Formal, full sentences.', 'Never promise a date.', 'Ask for the project code.',
        'Short sentences; no small talk.', 'Product lead; prefers mornings.', 'Atlas rollout', 'EPM-1234', 'Ask for the cost code and the approver', 'Lead with the answer', 'One or two lines, no greeting.'];
      const leaked = voiceTexts.filter(t => stored.includes(t));
      assert(leaked.length === 0, `localStorage holds ${JSON.stringify(leaked)}`);
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V10: the import's pick and preview

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready' });
    await check('voice V10: Import from skills… picks the folder then scans it once; the preview lists the rows and what was not imported', async () => {
      await ready(page, settled);
      // A cancelled pick scans nothing.
      await page.evaluate(() => { window.__skillsFolder = null; });
      await page.click('[data-action="voice-import"]');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op]) => op === 'pick_folder'));
      await page.waitForTimeout(300);
      assert((await calls(page, 'voice_import_scan')).length === 0, 'a cancelled pick scanned');
      assert(await page.locator('.ws-voice-import').count() === 0, 'a cancelled pick opened the preview');

      await openImport(page, settled);
      const picks = await calls(page, 'pick_folder');
      assert(picks.length === 2 && picks.every(p => JSON.stringify(p) === JSON.stringify({ purpose: 'skills' })), JSON.stringify(picks));
      const scans = await calls(page, 'voice_import_scan');
      assert(scans.length === 1 && JSON.stringify(scans[0]) === JSON.stringify({ path: SKILLS }), JSON.stringify(scans));
      assert(squash(await text(page, '#ws-voice-import-title')) === 'Import from skills · voice-skills', 'preview title');
      assert(squash(await text(page, '.ws-voice-import > .ws-hint')) === 'Found 6 skills. 8 instructions to add.', 'preview summary');
      assert(await page.locator('.ws-voice-import-row').count() === 8, 'voice-import-preview.json has 8 rows');
      assert(squash(await text(page, '.ws-voice-subhead')) === 'Not imported (3)', 'Not imported (3)');
      for (const [skill, reason] of SKIPPED) {
        const row = squash(await text(page, `[data-voice-import-skipped="${skill}"] .ws-muted`));
        assert(row === reason, `${skill}: ${row}`);
      }
      assert(squash(await text(page, '[data-voice-import-item="long-standard#4"] .ws-voice-src')) === 'From long-standard · Kept 6 of 14 lines.', 'a cut skill says what it kept');
      assert(squash(await text(page, '[data-action="voice-import-save"]')) === 'Add 8 instructions', 'every row ticked');
      await page.click('[data-action="voice-import-cancel"]');
      await page.waitForSelector('.ws-voice-import', { state: 'detached' });
    });
    await context.close().catch(() => {});
  }
  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'off' });
    await check('voice V10: with Off, Import from skills… is disabled with its hint', async () => {
      await ready(page, settled);
      const button = page.locator('[data-action="voice-import"]');
      assert(await button.isDisabled(), 'Import from skills… is enabled with Off');
      assert(await button.getAttribute('aria-describedby') === 'ws-voice-import-off', 'the button names its hint');
      assert(squash(await text(page, '#ws-voice-import-off')) === 'Choose where your voice comes from first.', 'the Off hint');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V11: Shorten with AI

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready' });
    await check('voice V11: Shorten with AI sends one voice_import_distil and marks the rows; a refusal keeps the rows', async () => {
      await ready(page, settled);
      await openImport(page, settled);
      await page.click('[data-action="voice-import-distil"][data-skill="long-standard"]');
      await page.waitForSelector('[data-voice-import-item="long-standard#ai1"]');
      await settled(page);
      const distils = await calls(page, 'voice_import_distil');
      assert(distils.length === 1 && distils[0].path === SKILLS && distils[0].skill === 'long-standard', JSON.stringify(distils));
      const feet = (await page.locator('[data-voice-import-item^="long-standard#"] .ws-voice-src').allInnerTexts()).map(squash);
      assert(feet.length === 2 && feet.every(f => f === 'From long-standard · Shortened by AI'), `rows: ${JSON.stringify(feet)}`);
      assert(await page.locator('[data-action="voice-import-distil"][data-skill="long-standard"]').count() === 0, 'Shorten with AI is still offered for long-standard');

      const before = await page.locator('[data-voice-import-item^="reply-style#"]').allInnerTexts();
      await refuseNext(page, { op: 'voice_import_distil', message: "AI's answer didn't fit, so reply-style is unchanged." });
      await page.click('[data-action="voice-import-distil"][data-skill="reply-style"]');
      await page.waitForSelector('.ws-voice-import .ws-field-error');
      await settled(page);
      assert(squash(await text(page, '.ws-voice-import .ws-field-error')) === "AI's answer didn't fit, so reply-style is unchanged.", 'the refusal');
      const after = await page.locator('[data-voice-import-item^="reply-style#"]').allInnerTexts();
      assert(JSON.stringify(after) === JSON.stringify(before), 'the refused skill\'s rows changed');
      assert((await calls(page, 'voice_import_distil')).length === 2, 'one more distil');
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V12: the import's save and Cancel

  {
    const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, hash: HASH, voice: 'ready' });
    await check('voice V12: unticked rows stay out of the one voice_import; Cancel sends nothing', async () => {
      await ready(page, settled);
      await openImport(page, settled);
      await page.click('[data-action="voice-import-cancel"]');
      await page.waitForSelector('.ws-voice-import', { state: 'detached' });
      assert((await calls(page, 'voice_import')).length === 0, 'Cancel imported');

      await openImport(page, settled);
      const untick = async key => {
        await page.locator(`[data-voice-import-item="${key}"] input[type=checkbox]`).click({ force: true });
        await settled(page);
      };
      await untick('long-standard#1');
      assert(squash(await text(page, '[data-action="voice-import-save"]')) === 'Add 7 instructions', 'one row unticked');
      for (const key of ['long-standard#2', 'long-standard#3', 'long-standard#4', 'reply-style#3']) await untick(key);
      assert(squash(await text(page, '[data-action="voice-import-save"]')) === 'Add 3 instructions', 'three rows left');
      await page.click('[data-action="voice-import-save"]');
      await page.waitForSelector('.ws-toast:has-text("Added 3 instructions to Knowledge.")');
      const toasts = await toastText(page);
      assert(toasts.some(t => t.startsWith('Added 3 instructions to Knowledge.')), `toasts: ${toasts}`);
      const saves = await calls(page, 'voice_import');
      assert(saves.length === 1 && saves[0].items.length === 3, JSON.stringify(saves));
      assert(JSON.stringify(saves[0].items.map(i => i.from)) === JSON.stringify(['budget-answers', 'reply-style', 'reply-style']), JSON.stringify(saves[0].items));
      await page.waitForSelector('.ws-voice-import', { state: 'detached' });
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- V13: the import preview's layout

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1000, height: 900, hash: HASH, voice: 'ready', settings: viewSettings(view) });
      await check(`voice V13: ${theme} ${view} 1000: the import preview fits`, async () => {
        await ready(page, settled);
        await openImport(page, settled);
        await noOverflow(page, assert, 'the import preview');
        const clipped = await noClip(page);
        assert(clipped.length === 0, `clipped: ${clipped.join(' | ')}`);
        await scrollTo(page, '#ws-voice-import-title');
        await shot(page, `voice-import-${theme}-${view}`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }
}
