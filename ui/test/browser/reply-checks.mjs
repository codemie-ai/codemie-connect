// Browser checks of the reply composer (spec docs/superpowers/specs/2026-11-22-reply-design.md):
// the three-control action line, the ✦ link and change line, Draft options, Teams sends on the
// click, Outlook's short confirm with Return never confirming, the ⌘↩ gate, autosave, Today,
// critical items and Default/Compact parity. Run alone with `WORKSPACE_E2E_ONLY=reply`. This is
// the single home for reply behaviour; related AI-drafting mechanics (options UI, provenance,
// context panel, Stop, failures, Today hover, thread summaries) stay in workspace-e2e.mjs.
// `open` is always called before `check` (never inside its callback): `check`'s own look for a
// stray open dialog reads the page `open` last set as current, which must already be this one.
import { CLIP_SELECTORS } from './compact-checks.mjs';

const MORE = '.ws-reply-bar details[data-menu="reply-more"]';
const text = (page, selector) => page.locator(selector).first().innerText();
const plan = (page, value) => page.evaluate(v => { window.__draftPlan = v; }, value);
const lastCall = async (page, name) => (await page.evaluate(() => window.__bridgeCalls)).filter(([op]) => op === name).at(-1)?.[1];
/** `sent(page) = calls(page, 'action_confirm').length` — how many sends actually went out. */
const sent = async (page, calls) => (await calls(page, 'action_confirm')).length;
const openOptions = async page => {
  await page.click(`${MORE} > summary`);
  await page.click(`${MORE} [data-action="ai-draft-options"]`);
  await page.waitForSelector('#draft-options');
  await page.waitForTimeout(150);
};
/** Each fixture id's lane, so `openRow` can switch the list to the lane that shows it. */
const LANE_OF = { 'c-reply-1': 'reply', 'c-reply-2': 'reply', 'm-reply-1': 'reply', 'm-reply-2': 'reply', 'm-critical': 'critical' };
/** Opens row `id` the way a click does, in either view; switches to its lane first (the default
 *  lane is "reply", which does not show a critical item), and waits for its reply bar. */
const openRow = async (page, settled, view, id) => {
  const lane = LANE_OF[id] || 'reply';
  if (!(await page.locator(`.ws-lane[data-lane="${lane}"][aria-selected="true"]`).count())) {
    await page.click(`.ws-lane[data-lane="${lane}"]`);
    await settled(page);
  }
  await page.click(`.ws-inbox-row[data-id="${id}"]`);
  await settled(page);
  await page.waitForSelector(view === 'compact' ? `.ws-crow-body[data-message-id="${id}"] .ws-reply-bar` : `.ws-read[data-message-id="${id}"] .ws-reply-bar`);
};
const barSelector = (view, id) => (view === 'compact' ? `.ws-crow-body[data-message-id="${id}"] .ws-reply-bar` : `.ws-read[data-message-id="${id}"] .ws-reply-bar`);
const rowContainer = (view, id) => (view === 'compact' ? `.ws-crow-body[data-message-id="${id}"]` : `.ws-read[data-message-id="${id}"]`);

/** No element the user would see at this width is clipped: CLIP_SELECTORS plus the hint and the
 *  change line (compact-checks.mjs's own algorithm, with those two added). */
const noClipPlus = page => page.evaluate(selectors => {
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
}, [...CLIP_SELECTORS, '.ws-reply-hint', '.ws-reply-change']);

const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.getElementById('workspace-main').scrollWidth - document.getElementById('workspace-main').clientWidth));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

/** The reply bar's direct controls the user can see: the primary, Acknowledge or Snooze ▾, and ⋯. */
const barControls = page => page.evaluate(() => [...document.querySelectorAll('.ws-reply-bar > button, .ws-reply-bar > details')].filter(el => el.checkVisibility({ checkOpacityCSS: true, checkVisibilityCSS: true })).length);

const IDS = ['c-reply-1', 'm-reply-1', 'm-critical'];

export async function replyChecks({ open, check, assert, shot, settled, calls, OUT }) {
  // R1: three controls, nothing clipped, both themes, both views, three widths, on all three kinds
  // of reply bar (a Teams one-to-one, an Outlook mail, and an unacknowledged critical item).
  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context } = await open({ theme, width, height: 900, hash: '#/inbox', enable: ['chat_send', 'mail_send'], settings: view === 'compact' ? { view: 'compact' } : null });
        await check(`reply R1: ${theme} ${view} ${width}: three controls, nothing clipped`, async () => {
          for (const id of IDS) {
            await openRow(page, settled, view, id);
            const count = await barControls(page);
            assert(count === 3, `${id}: the reply bar has ${count} visible direct controls`);
            await noOverflow(page, assert, `${id}`);
            const clipped = await noClipPlus(page);
            assert(clipped.length === 0, `${id}: clipped ${clipped.join(' | ')}`);
            await shot(page, `reply-${theme}-${view}-${width}-${id}`);
          }
        });
        await context.close().catch(() => {});
      }
    }
  }

  // R2: the ✦ link drafts with the remembered options and no instructions/revise; the change line
  // sends the words with the current text; the result shows "(changed: …)" and Restore my text.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R2 (${theme}): the ✦ link and the change line`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      const hint = (await text(page, '.ws-reply-hint')).replace(/\s+/g, ' ').trim();
      assert(hint === 'Write a reply, or ✦ draft with AI', `hint: ${hint}`);
      await plan(page, { outcome: 'hold' });
      await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
      await page.waitForSelector('.ws-draft-running', { timeout: 4000 });
      const first = await lastCall(page, 'ai_draft');
      assert(first.sourceId === 'c-reply-1' && first.intent === 'reply' && first.tone === 'neutral' && first.length === 'short' && first.includeFreeTimes === false, JSON.stringify(first));
      assert(!('instructions' in first) && !('revise' in first), `the quick draft carried instructions or revise: ${JSON.stringify(first)}`);
      await page.evaluate(() => window.__finishDraft({ outcome: 'ok' }));
      await page.waitForFunction(() => document.getElementById('reply-body')?.value.length > 0, null, { timeout: 4000 });
      assert(await page.locator('#reply-change').count() === 1, 'no change line once the box has text');
      const before = await page.inputValue('#reply-body');
      await plan(page, { outcome: 'ok', ms: 300 });
      await page.fill('#reply-change', 'say 15:00');
      await page.press('#reply-change', 'Enter');
      await page.waitForFunction(text => document.getElementById('reply-body')?.value === `${text} (changed: say 15:00)`, before, { timeout: 4000 });
      const change = await lastCall(page, 'ai_draft');
      assert(change.instructions === 'say 15:00' && change.revise === before, JSON.stringify(change));
      assert(await page.locator('[data-action="ai-draft-restore"]').count() === 1, 'no Restore my text after a change');
      await page.click('[data-action="ai-draft-restore"]');
      await page.waitForFunction(text => document.getElementById('reply-body')?.value === text, before, { timeout: 4000 });
      assert((await calls(page, 'action_prepare')).length === 0, 'the draft flow prepared a send');
    });
    await context.close().catch(() => {});
  }

  // R3: Draft options under ⋯ opens anchored to the ⋯ summary; a tone picked there is drafted.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R3 (${theme}): Draft options under ⋯`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      await openOptions(page);
      const geometry = await page.evaluate(() => {
        const pop = document.getElementById('draft-options').getBoundingClientRect();
        const trigger = document.querySelector('.ws-reply-bar details[data-menu="reply-more"] > summary').getBoundingClientRect();
        return { r: pop.right, triggerR: trigger.right };
      });
      assert(Math.abs(geometry.r - geometry.triggerR) < 2, `popover not anchored to the ⋯ summary: ${JSON.stringify(geometry)}`);
      await page.click('[data-draft-tone="formal"]');
      await plan(page, { outcome: 'ok', ms: 300 });
      await page.click('#draft-options [data-action="ai-draft"]');
      await page.waitForSelector('.ws-draft-provenance', { timeout: 4000 });
      const call = await lastCall(page, 'ai_draft');
      assert(call.tone === 'formal', JSON.stringify(call));
    });
    await context.close().catch(() => {});
  }

  // R4: a Teams reply sends on the click; a double click, or a background sync re-rendering the
  // row mid-send, still sends exactly once.
  for (const theme of ['dark', 'light']) {
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R4 (${theme}): a double click on Send to Jordan sends once`, async () => {
        await openRow(page, settled, 'default', 'c-reply-1');
        await page.fill('#reply-body', 'See you at 11.');
        assert(await text(page, '[data-action="reply-send"]') === 'Send to Jordan', await text(page, '[data-action="reply-send"]'));
        const before = { prepare: (await calls(page, 'action_prepare')).length, confirm: (await calls(page, 'action_confirm')).length };
        await page.dblclick('[data-action="reply-send"]');
        await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
        assert(await page.locator('.ws-modal[open]').count() === 0, 'a Teams send opened a dialog');
        assert((await calls(page, 'action_prepare')).length - before.prepare === 1, 'action_prepare fired more than once');
        assert((await calls(page, 'action_confirm')).length - before.confirm === 1, 'action_confirm fired more than once');
        assert(await page.locator('.ws-reply-status [data-action="source"]:has-text("Open in Teams ↗")').count() === 1, 'no Open in Teams ↗ after the send');
      });
      await context.close().catch(() => {});
    }
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R4 (${theme}): a re-render during a Teams send still sends once`, async () => {
        await openRow(page, settled, 'default', 'c-reply-2');
        await page.fill('#reply-body', 'Approved, go ahead.');
        assert(await text(page, '[data-action="reply-send"]') === 'Send to Release crew', await text(page, '[data-action="reply-send"]'));
        const before = { prepare: (await calls(page, 'action_prepare')).length, confirm: (await calls(page, 'action_confirm')).length };
        await page.evaluate(() => { window.__syncBump = true; });
        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-reply-status:has-text("Sent to Release crew.")', { timeout: 4000 });
        assert((await calls(page, 'action_prepare')).length - before.prepare === 1, 'a re-render caused action_prepare to fire more than once');
        assert((await calls(page, 'action_confirm')).length - before.confirm === 1, 'a re-render caused action_confirm to fire more than once');
      });
      await context.close().catch(() => {});
    }
  }

  // R13 (C1): Enter on any field inside the reply form (the box, the change line, the lane
  // select under ⋯, Draft options' "Suggest times from my calendar" and its instructions) never
  // sends: the form has no submit button, so implicit submission cannot click Send. A button
  // takes Enter as its own click, so the sweep covers fields only. A real click on Send, and an
  // armed ⌘↩, still send once each.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R13 (${theme}): Enter on a field in the reply form never sends`, async () => {
      const FIELDS = 'form[data-form="reply"] :is(input, select, textarea)';
      const nothingSent = async what => {
        await page.waitForTimeout(300);
        const prepared = (await calls(page, 'action_prepare')).length;
        const confirmed = await sent(page, calls);
        assert(prepared === 0 && confirmed === 0, `Enter on ${what} sent: action_prepare ${prepared}, action_confirm ${confirmed}`);
      };
      const sweep = async where => {
        const n = await page.locator(FIELDS).count();
        let pressed = 0;
        for (let i = 0; i < n; i++) {
          const el = page.locator(FIELDS).nth(i);
          if (!(await el.isVisible()) || await el.isDisabled()) continue;
          const name = await el.evaluate(x => x.id || x.getAttribute('aria-label') || x.name || x.tagName);
          await el.focus();
          await page.keyboard.press('Enter');
          await nothingSent(`${where} › ${name}`);
          pressed++;
        }
        return pressed;
      };
      await openRow(page, settled, 'default', 'c-reply-1');
      await page.fill('#reply-body', 'See you at 11.');

      await openOptions(page);
      await page.focus('#draft-free-times');
      await page.keyboard.press('Enter');
      await nothingSent('"Suggest times from my calendar"');
      assert(await sweep('Draft options') >= 3, 'the Draft options sweep pressed too few fields');
      await page.click('[data-action="ai-draft-cancel"]');
      await page.waitForSelector('#draft-options', { state: 'detached' });

      await page.click(`${MORE} > summary`);
      await page.waitForSelector(`${MORE}[open]`);
      await page.focus(`${MORE} select`);
      await page.keyboard.press('Enter');
      await nothingSent('the "Move to lane" select');
      await page.keyboard.press('Escape');
      await page.click(`${MORE} > summary`);
      await page.waitForSelector(`${MORE}[open]`);
      assert(await sweep('the ⋯ menu') >= 3, 'the ⋯ menu sweep pressed too few fields');
      await page.keyboard.press('Escape');
      if (await page.locator(`${MORE}[open]`).count()) await page.click(`${MORE} > summary`);
      await page.waitForSelector(`${MORE}[open]`, { state: 'detached' });
      assert(await sweep('the reply form') >= 2, 'the reply form sweep pressed too few fields');

      await page.click('[data-action="reply-send"]');
      await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
      assert(await sent(page, calls) === 1 && (await calls(page, 'action_prepare')).length === 1, `a click on Send recorded ${await sent(page, calls)} confirms`);
      // The sweep's Enter in the box added line breaks to the reply; the sent text still leaves the box.
      assert(await page.inputValue('#reply-body') === '', `the box kept the sent text: ${JSON.stringify(await page.inputValue('#reply-body'))}`);

      await page.click('#reply-body');
      await page.keyboard.type('One more thing.');
      await page.keyboard.press('Meta+Enter');
      await page.waitForFunction(() => window.__bridgeCalls.filter(([op]) => op === 'action_confirm').length === 2, null, { timeout: 4000 });
      await page.waitForTimeout(300);
      assert(await sent(page, calls) === 2 && (await calls(page, 'action_prepare')).length === 2, `an armed ⌘↩ recorded ${await sent(page, calls)} confirms in all`);
      assert((await lastCall(page, 'action_prepare'))?.body === 'One more thing.', JSON.stringify(await lastCall(page, 'action_prepare')));
      assert(await page.locator('form[data-form="reply"] :is(button:not([type]), button[type=submit], input[type=submit], input[type=image])').count() === 0, 'the reply form has a submit-capable button');
    });
    await context.close().catch(() => {});
  }

  // R14 (I1): text typed while a Teams send is in flight stays in the box and is saved; only the
  // text that was sent leaves.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R14 (${theme}): text typed during a Teams send survives it`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      await page.fill('#reply-body', 'See you at 11.');
      await page.evaluate(() => { window.__confirmHold = true; window.__finishConfirm = null; });
      await page.click('[data-action="reply-send"]');
      await page.waitForFunction(() => typeof window.__finishConfirm === 'function', null, { timeout: 4000 });
      await page.focus('#reply-body');
      await page.keyboard.press('End');
      await page.keyboard.type(' Also, bring the deck.');
      await page.evaluate(() => { window.__confirmHold = false; window.__finishConfirm(); });
      await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
      await settled(page);
      await page.waitForTimeout(300);
      const want = 'See you at 11. Also, bring the deck.';
      assert((await lastCall(page, 'action_prepare'))?.body === 'See you at 11.', JSON.stringify(await lastCall(page, 'action_prepare')));
      assert(await page.inputValue('#reply-body') === want, `the box lost the new text: "${await page.inputValue('#reply-body')}"`);
      const saves = await calls(page, 'draft_save');
      assert(saves.at(-1)?.text === want, `the new text was not saved: ${JSON.stringify(saves.map(d => d.text))}`);
      await openRow(page, settled, 'default', 'm-reply-1');
      await openRow(page, settled, 'default', 'c-reply-1');
      assert(await page.inputValue('#reply-body') === want, `the new text did not survive re-opening: "${await page.inputValue('#reply-body')}"`);
    });
    await context.close().catch(() => {});
  }

  // R5: without chat_send and mail_send the primary is Copy reply; ⋯ offers a read-only link.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox' });
    await check(`reply R5 (${theme}): sending not allowed shows Copy reply and a read-only link`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      assert(await page.locator('[data-action="reply-send"]').count() === 0, 'Send shows without permission');
      assert(await text(page, '[data-action="reply-copy"]') === 'Copy reply', await text(page, '[data-action="reply-copy"]'));
      await page.click(`${MORE} > summary`);
      assert(/Reply in Teams ↗/.test(await text(page, `${MORE} [data-action="source"]`)), await text(page, `${MORE} [data-action="source"]`));
      await page.keyboard.press('Escape');
      await page.evaluate(() => { navigator.clipboard.writeText = async t => { window.__copied = t; }; });
      await page.fill('#reply-body', 'See you at 11.');
      const before = (await calls(page, 'action_prepare')).length;
      await page.click('[data-action="reply-copy"]');
      await page.waitForFunction(() => window.__copied === 'See you at 11.', null, { timeout: 4000 });
      assert((await calls(page, 'action_prepare')).length === before, 'Copy reply prepared a native send');

      await openRow(page, settled, 'default', 'm-reply-1');
      await page.click(`${MORE} > summary`);
      assert(/Reply in Outlook ↗/.test(await text(page, `${MORE} [data-action="source"]`)), await text(page, `${MORE} [data-action="source"]`));
    });
    await context.close().catch(() => {});
  }

  // R6: the Outlook confirm's lines, Return never confirms it (focused on Cancel, or tabbed to
  // Send), a click sends, a redirected Reply-To is tagged "(new)", and a changed destination is
  // refused inline with the text kept.
  for (const theme of ['dark', 'light']) {
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R6 (${theme}): the mail confirm, and Return never confirms it`, async () => {
        await openRow(page, settled, 'default', 'm-reply-1');
        await page.fill('#reply-body', 'Looks good, thanks.');
        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        const body = await text(page, '.ws-modal[open] .ws-modal-body');
        assert(body.includes('To: priya.n@example.test') && body.includes('Subject: Review: Q4 workspace roadmap') && body.includes('Signature: none — Connect sends your text as written') && !body.includes('Cc:'), body);
        assert(await page.evaluate(() => document.activeElement?.textContent.trim() === 'Cancel'), 'Cancel is not focused');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
        assert(await sent(page, calls) === 0, 'Return on Cancel sent the reply');

        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.activeElement?.type === 'submit');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
        assert(await sent(page, calls) === 0, 'Return after Tab to Send sent the reply');

        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        await page.waitForTimeout(450); // the dialog's commit guard ignores a click right after it opens
        await page.click('.ws-modal[open] button[type=submit]');
        await page.waitForSelector('.ws-reply-status:has-text("Sent to Priya.")', { timeout: 4000 });
        assert(await sent(page, calls) === 1, `clicking Send sent ${await sent(page, calls)} times`);
      });
      await context.close().catch(() => {});
    }
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R6 (${theme}): a redirected Reply-To is tagged "(new)"`, async () => {
        await openRow(page, settled, 'default', 'm-reply-1');
        await page.evaluate(() => { window.__replyTo = 'assistant@other.test'; });
        await page.fill('#reply-body', 'Looks good, thanks.');
        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        assert((await text(page, '.ws-modal[open] .ws-modal-body')).includes('To: assistant@other.test (new)'), await text(page, '.ws-modal[open] .ws-modal-body'));
      });
      await context.close().catch(() => {});
    }
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R6 (${theme}): a changed destination is refused inline, with the text kept`, async () => {
        await openRow(page, settled, 'default', 'm-reply-1');
        await page.evaluate(() => { window.__replyToChanged = true; });
        await page.fill('#reply-body', 'Looks good, thanks.');
        await page.click('[data-action="reply-send"]');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        await page.waitForTimeout(450); // the dialog's commit guard ignores a click right after it opens
        await page.click('.ws-modal[open] button[type=submit]');
        await page.waitForSelector('.ws-modal[open] .ws-modal-error:has-text("The Outlook message or reply destination changed")');
        assert(await page.locator('.ws-modal[open]').count() === 1, 'the conflict closed the dialog');
        assert(await page.locator('.ws-reply-status:has-text("Sent to Priya.")').count() === 0, 'a refused confirm still shows as sent');
        await page.click('.ws-modal[open] button:has-text("Cancel")');
        await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
        assert(await page.locator('#reply-body').inputValue() === 'Looks good, thanks.', 'the box lost its text after a refused confirm');
      });
      await context.close().catch(() => {});
    }
  }

  // R7: ⌘↩ sends only once the user has clicked or typed in the box, never on a held key and
  // never with a popover, sheet or menu open; on a mail reply it opens the confirm, which eats its
  // own ⌘↩ without sending.
  for (const theme of ['dark', 'light']) {
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R7 (${theme}): ⌘↩ waits for a touch, ignores a repeat, and a menu blocks it`, async () => {
        await openRow(page, settled, 'default', 'c-reply-1');
        await plan(page, { outcome: 'hold' });
        await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
        await page.waitForSelector('.ws-draft-running', { timeout: 4000 });
        // No bracket choice left open, so Send (a click or ⌘↩) goes straight through.
        await page.evaluate(() => window.__finishDraft({ outcome: 'ok', text: 'Sure, the notes are attached.', questions: [] }));
        await page.waitForFunction(() => document.getElementById('reply-body')?.value.length > 0, null, { timeout: 4000 });
        let before = (await calls(page, 'action_prepare')).length;
        await page.focus('#reply-body');
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(350);
        assert((await calls(page, 'action_prepare')).length === before, 'an untouched draft was sent by ⌘↩');

        await page.click('#reply-body');
        await page.keyboard.press('Meta+Enter');
        await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
        assert(await sent(page, calls) === 1, `a touched box's ⌘↩ sent ${await sent(page, calls)} times`);

        await plan(page, { outcome: 'hold' });
        await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
        await page.waitForSelector('.ws-draft-running', { timeout: 4000 });
        await page.evaluate(() => window.__finishDraft({ outcome: 'ok', text: 'Glad to help.', questions: [] }));
        await page.waitForFunction(() => document.getElementById('reply-body')?.value.length > 0, null, { timeout: 4000 });
        await page.click('#reply-body');
        await page.keyboard.type(' ok');
        await page.click(`${MORE} > summary`);
        await page.waitForSelector(`${MORE}[open]`);
        before = (await calls(page, 'action_prepare')).length;
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(350);
        assert((await calls(page, 'action_prepare')).length === before, '⌘↩ sent while the ⋯ menu was open');
        await page.keyboard.press('Escape');
        await page.waitForSelector(`${MORE}[open]`, { state: 'detached' });

        await page.evaluate(() => document.getElementById('reply-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, repeat: true, bubbles: true, cancelable: true })));
        await page.waitForTimeout(350);
        assert((await calls(page, 'action_prepare')).length === before, 'a held ⌘↩ sent');

        await page.click('#reply-body');
        await page.keyboard.press('Meta+Enter');
        await page.waitForSelector('.ws-reply-status:has-text("Sent to Jordan.")', { timeout: 4000 });
        assert(await sent(page, calls) === 2, `the second send recorded ${await sent(page, calls)} confirms`);
        const afterSendPrepare = (await calls(page, 'action_prepare')).length;
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(350);
        assert((await calls(page, 'action_prepare')).length === afterSendPrepare, 'the emptied box after a send still sent on ⌘↩');
      });
      await context.close().catch(() => {});
    }
    {
      const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
      await check(`reply R7 (${theme}): ⌘↩ on a touched mail reply opens the confirm; Enter inside it sends nothing`, async () => {
        await openRow(page, settled, 'default', 'm-reply-1');
        await page.click('#reply-body');
        await page.keyboard.type('Looks good.');
        await page.keyboard.press('Meta+Enter');
        await page.waitForSelector('.ws-modal[open]:has-text("Send this reply?")');
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(350);
        assert(await sent(page, calls) === 0, 'Meta+Enter inside the confirm sent the reply');
      });
      await context.close().catch(() => {});
    }
  }

  // R8: drafts running and finishing, autosave, a view switch, a route change and bare re-renders
  // never call the native send path.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R8 (${theme}): nothing sends without a click`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      await page.fill('#reply-body', 'typing away');
      await page.waitForSelector('.ws-reply-status:has-text("Saved on this device")', { timeout: 4000 });
      await plan(page, { outcome: 'hold' });
      await page.fill('#reply-body', '');
      await page.click('.ws-reply-hint [data-action="ai-draft-quick"]');
      await page.waitForSelector('.ws-draft-running', { timeout: 4000 });
      await page.evaluate(() => window.__finishDraft({ outcome: 'ok' }));
      await page.waitForFunction(() => document.getElementById('reply-body')?.value.length > 0, null, { timeout: 4000 });
      await page.evaluate(() => window.__workspace.route('settings', 'appearance'));
      await settled(page);
      await page.click('[data-action="view-set"][data-view="compact"]');
      await settled(page);
      await page.click('[data-action="view-set"][data-view="default"]');
      await settled(page);
      await page.evaluate(() => window.__workspace.route('today'));
      await settled(page);
      await page.evaluate(() => window.__workspace.route('inbox'));
      await settled(page);
      for (let i = 0; i < 5; i++) await page.evaluate(() => window.__workspace.render());
      assert((await calls(page, 'action_prepare')).length === 0, 'something prepared a send with no click');
      assert((await calls(page, 'action_confirm')).length === 0, 'something confirmed a send with no click');
    });
    await context.close().catch(() => {});
  }

  // R9 (Review Focus 4): autosave is 1.5 s after typing stops, flushes at once before a selection
  // change, and the saved text is still there when the conversation re-opens.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R9 (${theme}): autosave, and a flush before a selection change`, async () => {
      await openRow(page, settled, 'default', 'c-reply-1');
      assert(await page.locator('[data-action="draft-save"]').count() === 0, 'a manual Save control exists');
      await page.fill('#reply-body', 'keep me');
      await page.waitForTimeout(1600);
      const saves = await calls(page, 'draft_save');
      assert(saves.some(d => d.text === 'keep me'), `no autosave of "keep me": ${JSON.stringify(saves.map(d => d.text))}`);
      assert(await text(page, '.ws-reply-status') === 'Saved on this device', await text(page, '.ws-reply-status'));

      await page.click('#reply-body');
      await page.keyboard.press('End');
      await page.keyboard.type(' and me');
      await openRow(page, settled, 'default', 'm-reply-1');
      const after = await calls(page, 'draft_save');
      assert(after.some(d => d.text === 'keep me and me'), `no flush of "keep me and me" before the row switched: ${JSON.stringify(after.map(d => d.text))}`);

      await openRow(page, settled, 'default', 'c-reply-1');
      assert(await page.inputValue('#reply-body') === 'keep me and me', `the box did not hold its text: ${await page.inputValue('#reply-body')}`);
    });
    await context.close().catch(() => {});
  }

  // R10: Today's "Needs your reply" › Draft reply opens the conversation with a draft running (the
  // row open in Compact); ⌘↩ right after prepares nothing (no touch yet).
  for (const view of ['default', 'compact']) {
    const { page, context } = await open({ theme: 'dark', hash: '#/today', enable: ['chat_send', 'mail_send'], settings: view === 'compact' ? { view: 'compact' } : null });
    await check(`reply R10 (${view}): Today Draft reply opens the conversation with a draft running`, async () => {
      await plan(page, { outcome: 'hold' });
      await page.waitForSelector('.ws-attention [data-action="draft-reply"][data-id="c-reply-2"]');
      const before = (await calls(page, 'action_prepare')).length;
      await page.click('.ws-attention [data-action="draft-reply"][data-id="c-reply-2"]');
      await page.waitForSelector(`${rowContainer(view, 'c-reply-2')} .ws-draft-running`);
      await page.waitForTimeout(300);
      await page.keyboard.press('Meta+Enter');
      await page.waitForTimeout(300);
      assert((await calls(page, 'action_prepare')).length === before, '⌘↩ right after Today Draft reply prepared a send');
      await shot(page, `reply-today-${view}`);
    });
    await context.close().catch(() => {});
  }

  // R11: an unacknowledged critical item's bar is Send, Acknowledge and ⋯; ⋯ holds Snooze and its
  // four choices; Acknowledge records the decision.
  for (const theme of ['dark', 'light']) {
    const { page, context } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    await check(`reply R11 (${theme}): a critical item's bar is Send, Acknowledge, ⋯`, async () => {
      await openRow(page, settled, 'default', 'm-critical');
      assert(await text(page, '[data-action="reply-send"]').then(t => t.startsWith('Send')), await text(page, '[data-action="reply-send"]'));
      assert(await page.locator('[data-action="message-ack"]').count() === 1, 'no Acknowledge control');
      assert(await barControls(page) === 3, 'not exactly three direct controls');
      await page.click(`${MORE} > summary`);
      const panel = await text(page, `${MORE} .ws-menu-panel`);
      // The "Snooze" label renders upper-case via CSS text-transform: compare case-folded.
      assert(panel.toLowerCase().includes('snooze'), panel);
      assert(await page.locator(`${MORE} [data-action="message-snooze"]`).count() === 4, 'not four snooze choices');
      await page.keyboard.press('Escape');
      await page.click('[data-action="message-ack"]');
      await page.waitForTimeout(300);
      const ack = await lastCall(page, 'inbox_decision');
      assert(ack.action === 'acknowledge', JSON.stringify(ack));
    });
    await context.close().catch(() => {});
  }

  // R12: Default and Compact draw c-reply-1's reply bar identically (any id or aria-controls
  // stripped first, in case either view ever grows one).
  for (const theme of ['dark', 'light']) {
    const { page: d, context: dc } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'] });
    const { page: c, context: cc } = await open({ theme, hash: '#/inbox', enable: ['chat_send', 'mail_send'], settings: { view: 'compact' } });
    await check(`reply R12 (${theme}): the reply bar is identical in Default and Compact`, async () => {
      const normalize = html => html.replace(/\s(id|aria-controls)="[^"]*"/g, '');
      await openRow(d, settled, 'default', 'c-reply-1');
      await openRow(c, settled, 'compact', 'c-reply-1');
      const defaultHtml = normalize(await d.locator(barSelector('default', 'c-reply-1')).evaluate(el => el.outerHTML));
      const compactHtml = normalize(await c.locator(barSelector('compact', 'c-reply-1')).evaluate(el => el.outerHTML));
      assert(defaultHtml === compactHtml, `Default and Compact reply bars differ:\nDefault: ${defaultHtml}\nCompact: ${compactHtml}`);
    });
    await dc.close().catch(() => {});
    await cc.close().catch(() => {});
  }
}
