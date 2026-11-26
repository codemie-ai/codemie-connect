// Browser checks of Settings › AI's rows, fallbacks and statuses (spec
// docs/superpowers/specs/2026-11-24-profiles-models-design.md §2–§5; the Ask row and its own
// group per docs/superpowers/specs/2026-11-26-ask-capture-design.md § 6, ruling 1), run by
// workspace-e2e.mjs with its MOCKED native bridge. R1–R8 below: the profile cards and "What each
// job uses" table across both views/themes/three widths (the Ask row shown, in its own group
// between Summaries and notes and Automations, no per-row Test button), the
// working/fallback/broken/unset statuses (a missing profile shown as "not ready"), exactly one
// `ai_settings_save` per fallback or plugin-row change with the row's chip tracking the answer's
// `chosen`, a kept model on an unrelated row while Ollama is down, the first-use chooser's Ollama
// line, the automation editor's row-aware label and a fallback run's "Ran on …" line in the Run
// log, Default/Compact parity, and no `ai_test` from drawing the page or Check again.
// `open({ ai: 'ollama-running' | 'ollama-down' | 'ollama-no-model', aiSettings, aiProfilePatch,
// aiPlugin })` (workspace-e2e.mjs) builds these scenarios on the real `ai-status.json` /
// `ai-route-cases.json` contract fixtures, the same ones `ai-settings.test.mjs` pins to Rust's
// `choose`.
import { noClip, FIXED_NOW } from './compact-checks.mjs';

/** reply-checks.mjs's `noOverflow` pattern. */
const noOverflow = async (page, assert, what) => {
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.getElementById('workspace-main').scrollWidth - document.getElementById('workspace-main').clientWidth));
  assert(overflow <= 0, `${what} overflows by ${overflow}px`);
};

const text = (page, selector) => page.locator(selector).first().innerText();
const editorOpen = async page => {
  await page.waitForSelector('.ws-modal[open] #automation-editor');
  await page.waitForTimeout(250);
};
const closeEditor = async page => {
  await page.click('.ws-modal[open] .ws-modal-footer [data-modal-close]');
  await page.waitForSelector('.ws-modal[open]', { state: 'detached' });
};
const saveCalls = async (page, calls) => (await calls(page, 'ai_settings_save')).length;

/**
 * R2's single scenario (one `settings.ai`, kept deliberately away from `ai-status.json`'s own
 * shape so every status in spec §4's table is reachable from one open): no default anywhere
 * (Mail replies: `unset`), Automations pinned to Claude Code (which `aiProfilePatch` below makes
 * `needs_login`) so Inbox triage's own fallback to CodeMie · prod (`ready`) shows `fallback`, the
 * Knowledge plugin row on the Ollama profile (`ollama-down`) with no fallback anywhere shows
 * `broken`, and Summaries pointing at a profile that no longer exists shows the "(not ready)"
 * option text (carried review: "a missing profile shows as not ready").
 */
const STATES_SETTINGS = {
  defaultProfile: null, defaultModel: null, defaultFallback: null,
  routes: { automation: { profile: 'claude' }, triage: { fallback: 'codemie:prod' }, summary: { profile: 'codemie:removed' } },
  plugins: { knowledge: { profile: 'codemie:local-ollama', model: 'qwen3:8b' } },
};
const CLAUDE_NEEDS_LOGIN = { claude: { state: 'needs_login', message: 'Claude Code is not signed in.' } };

/** The Inbox triage automation (habitRecords, `ai.chosen.triage.profile` on `ai: 'all'` is the
 *  ready native Claude Code) made from its gallery template, and a second run of it that fell
 *  back from CodeMie · prod to Claude Code (carried review: a fixture with a fallback run). */
const withFallbackRun = (snapshot, _now) => {
  const auto = snapshot.records.find(r => r.kind === 'automation' && r.id === 'auto-triage');
  if (auto) auto.data.template = 'inbox-triage';
  const base = snapshot.records.find(r => r.kind === 'automation_run' && r.id === 'run-triage');
  if (base) {
    snapshot.records.push({
      ...base, id: 'run-triage-fallback', revision: 'r-run-triage-fallback', updatedAt: base.updatedAt + 1,
      data: { ...base.data, startedAt: base.data.startedAt + 1, profile: 'claude', model: null, fallbackFrom: 'codemie:prod', fallbackReason: 'needs_login' },
    });
  }
};

export async function aiRoutesChecks({ open, check, assert, shot, settled, calls, OUT: _OUT }) {
  // ---------------------------------------------------------------- R1: the page, both views, both themes, three widths

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      for (const width of [1000, 1440, 1680]) {
        const { page, context, errors } = await open({ theme, width, height: 900, ai: 'ollama-running', aiPlugin: true, hash: '#/settings/ai', settings: view === 'compact' ? { view: 'compact' } : null });
        await check(`ai-routes R1: ${theme} ${view} ${width}`, async () => {
          await page.waitForSelector('[data-ai-profile="claude"]');
          await settled(page);
          assert(await page.locator('[data-ai-profile]').count() === 4, 'Claude Code, two CodeMie and one Ollama profile card');
          const ollama = await text(page, '[data-ai-profile="codemie:local-ollama"]');
          assert(/Engine/i.test(ollama) && /Ollama/.test(ollama), `Ollama card facts: ${ollama}`);
          assert((await text(page, '.ws-ai-routes .ws-card-title')) === 'What each job uses', 'card title');
          for (const g of ['Replies', 'Summaries and notes', 'Ask', 'Automations', 'Plugins']) assert(await page.locator(`th[scope=rowgroup]:text-is("${g}")`).count() === 1, `group ${g}`);
          assert(await page.locator('th[scope=col]:text-is("Status")').count() === 1, 'Status column');
          assert(await page.locator('[data-ai-route-row="plugin:knowledge"]').count() === 1, 'the Knowledge plugin row');
          // ask-capture § 6, ruling 1: Ask's row is shown in its own group, between Summaries and
          // notes and Automations; still no per-row Test button (the paid Test button stays on
          // the profile cards; ruling 17).
          assert(await page.locator('[data-ai-route-row="ask"]').isVisible(), 'Ask row shown');
          assert(/Questions you type in ⌘K\./.test(await text(page, '[data-ai-route-row="ask"]')), 'Ask row hint');
          const groups = await page.locator('th[scope=rowgroup]').allInnerTexts();
          assert(groups.indexOf('Summaries and notes') < groups.indexOf('Ask') && groups.indexOf('Ask') < groups.indexOf('Automations'), `group order: ${groups}`);
          assert(await page.locator('[data-ai-route-row] [data-action="ai-test"]').count() === 0, 'a route row has its own Test button');
          await noOverflow(page, assert, `${theme} ${view} ${width}`);
          const clipped = await noClip(page);
          assert(clipped.length === 0, clipped.join(' | '));
          await page.evaluate(() => document.querySelector('.ws-ai-routes').scrollIntoView({ block: 'start' }));
          await shot(page, `ai-routes-${theme}-${view}-${width}`);
          assert(errors.length === 0, errors.join(' | '));
        });
        await context.close().catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- R2: statuses (working/fallback/broken/unset), both themes, both views

  for (const theme of ['dark', 'light']) {
    for (const view of ['default', 'compact']) {
      const { page, context, errors } = await open({ theme, width: 1440, height: 900, ai: 'ollama-down', aiPlugin: true, aiSettings: STATES_SETTINGS, aiProfilePatch: CLAUDE_NEEDS_LOGIN, hash: '#/settings/ai', settings: view === 'compact' ? { view: 'compact' } : null });
      await check(`ai-routes R2: ${theme} ${view}`, async () => {
        await page.waitForSelector('[data-ai-profile="claude"]');
        await settled(page);
        const knowledge = await text(page, '[data-ai-route-row="plugin:knowledge"]');
        assert(await page.locator('[data-ai-route-row="plugin:knowledge"] [data-ai-route-state="broken"]').count() === 1, `Knowledge row not broken: ${knowledge}`);
        assert(/Not working/i.test(knowledge) && /Ollama isn.t running\. Open Ollama, then check again\./.test(knowledge), knowledge);
        const triage = await text(page, '[data-ai-route-row="triage"]');
        assert(await page.locator('[data-ai-route-row="triage"] [data-ai-route-state="fallback"]').count() === 1, `Inbox triage row not on fallback: ${triage}`);
        assert(/Using fallback/i.test(triage) && /Using CodeMie . prod: Claude Code is not signed in\./.test(triage), triage);
        const mail = await text(page, '[data-ai-route-row="mail_draft"]');
        assert(await page.locator('[data-ai-route-row="mail_draft"] [data-ai-route-state="unset"]').count() === 1, `Mail replies row not unset: ${mail}`);
        assert(/Choose a profile/i.test(mail) && /Nothing runs until you choose one\./.test(mail), mail);
        // Carried review: a missing profile shows as "not ready" in its own Profile select.
        const summaryOption = await page.evaluate(() => document.querySelector('[data-ai-route-row="summary"] select[data-field="profile"] option[value="codemie:removed"]')?.textContent);
        assert(summaryOption === 'codemie:removed (not ready)', summaryOption);
        assert(await page.locator('[data-ai-route-row="summary"] [data-ai-route-state="broken"]').count() === 1, 'Summaries row not broken');
        await page.evaluate(() => document.querySelector('[data-ai-route-row="triage"]').scrollIntoView({ block: 'center' }));
        await shot(page, `ai-routes-states-${theme}-${view}`);
        assert(errors.length === 0, errors.join(' | '));
      });
      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- R3: saving a fallback and a plugin row's profile

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, ai: 'all', aiPlugin: true, hash: '#/settings/ai' });
    await check('ai-routes R3: a fallback save and a plugin-row profile save, one call each, the chip tracking the answer', async () => {
      await page.waitForSelector('[data-ai-profile="claude"]');
      await settled(page);
      const beforeFallback = await saveCalls(page, calls);
      await page.locator('select[data-route="triage"][data-field="fallback"]').selectOption('codemie:prod');
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'ai_settings_save').length > n, beforeFallback);
      assert(await saveCalls(page, calls) === beforeFallback + 1, 'more than one save for the fallback change');
      const fallbackSave = (await calls(page, 'ai_settings_save')).at(-1);
      assert(fallbackSave.routes.triage?.fallback === 'codemie:prod', JSON.stringify(fallbackSave));

      const before = await text(page, '[data-ai-route-row="plugin:knowledge"] .ws-ai-status-text');
      const beforeProfile = await saveCalls(page, calls);
      await page.locator('select[data-route="plugin:knowledge"][data-field="profile"]').selectOption('claude');
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'ai_settings_save').length > n, beforeProfile);
      assert(await saveCalls(page, calls) === beforeProfile + 1, 'more than one save for the plugin-row profile change');
      const profileSave = (await calls(page, 'ai_settings_save')).at(-1);
      assert(profileSave.plugins.knowledge?.profile === 'claude', JSON.stringify(profileSave));
      // The row's chip redraws from the save's own answer (`{settings, chosen}`), not the stale
      // status: Claude Code offers no "qwen3:8b" (the kept model, ruling 13); the row's fallback
      // (inherited from `defaultFallback`, CodeMie · prod, still ready) now covers it, so the row
      // goes from Working (CodeMie · local-ollama, ready) to Using fallback.
      await page.waitForFunction(() => document.querySelector('[data-ai-route-row="plugin:knowledge"] [data-ai-route-state]')?.dataset.aiRouteState === 'fallback');
      const after = await text(page, '[data-ai-route-row="plugin:knowledge"] .ws-ai-status-text');
      assert(after !== before, `status text did not change: ${after}`);
      assert(after === "Using CodeMie · prod: Claude Code doesn't offer qwen3:8b.", after);
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- R4: a kept model while Ollama is down

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, ai: 'ollama-down', aiPlugin: true, hash: '#/settings/ai' });
    await check('ai-routes R4: changing Summaries’ profile still sends the plugin row’s saved model', async () => {
      await page.waitForSelector('[data-ai-profile="claude"]');
      await settled(page);
      const before = await saveCalls(page, calls);
      await page.locator('select[data-route="summary"][data-field="profile"]').selectOption('claude');
      await page.waitForFunction(n => window.__bridgeCalls.filter(([op]) => op === 'ai_settings_save').length > n, before);
      const saved = (await calls(page, 'ai_settings_save')).at(-1);
      assert(saved.routes.summary?.profile === 'claude', JSON.stringify(saved));
      assert(saved.plugins.knowledge?.profile === 'codemie:local-ollama' && saved.plugins.knowledge?.model === 'qwen3:8b', JSON.stringify(saved));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- R5: the first-use chooser names Ollama

  for (const theme of ['dark', 'light']) {
    const { page, context, errors } = await open({ theme, ai: 'all', aiDefault: null });
    await check(`ai-routes R5 (${theme}): the chooser's title and its Ollama line`, async () => {
      await page.evaluate(() => { window.__workspace.ensureClaudeChoice().then(v => { window.__chosen = v; }); });
      await page.waitForSelector('.ws-modal[open] [data-action="ai-choose"]');
      assert((await text(page, '.ws-modal[open] .ws-modal-header h2')) === 'Choose which AI writes for you', 'chooser title');
      const ollamaLine = await text(page, '.ws-modal[open] [data-profile="codemie:local-ollama"]');
      assert(/Ollama . qwen3:8b/.test(ollamaLine), ollamaLine);
      await shot(page, `ai-routes-chooser-${theme}`);
      await page.keyboard.press('Escape');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- R6: the automation editor's row label and a fallback run's "Ran on …"

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, now: FIXED_NOW, automations: 'habits', ai: 'all', hash: '#/automations', patch: withFallbackRun });
    await check('ai-routes R6: the Inbox triage editor names its row, and a fallback run says so in the Run log', async () => {
      await page.waitForSelector('[data-action="automation-edit"][data-id="auto-triage"]');
      await page.click('[data-action="automation-edit"][data-id="auto-triage"]');
      await editorOpen(page);
      const firstOption = await page.evaluate(() => document.getElementById('auto-profile').options[0].textContent);
      assert(firstOption === 'Default · Inbox triage (Claude Code)', firstOption);
      assert(await page.locator('#auto-profile').inputValue() === '', 'Profile is not on Default');
      await closeEditor(page);

      await page.click('[data-action="dock-tab"][data-tab="auto-runs"]');
      await page.waitForSelector('.ws-run-log .ws-run');
      await settled(page);
      await page.click('[data-action="run-toggle"][data-id="run-triage-fallback"]');
      await page.waitForSelector('#run-run-triage-fallback');
      const detail = await text(page, '#run-run-triage-fallback');
      assert(detail.includes('Ran on Claude Code because CodeMie · prod wasn’t signed in.'), detail);
      await shot(page, 'ai-routes-automation-fallback-dark');
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- R7: Default/Compact parity

  {
    const normalize = html => html.replace(/\s(id|aria-controls|aria-describedby)="[^"]*"/g, '');
    const capture = async settings => {
      const { page, context } = await open({ theme: 'dark', width: 1440, height: 900, ai: 'ollama-running', aiPlugin: true, hash: '#/settings/ai', settings });
      await page.waitForSelector('.ws-ai-routes');
      const html = await page.locator('.ws-ai-routes').evaluate(el => el.outerHTML);
      return { context, html: normalize(html) };
    };
    const def = await capture(null);
    await def.context.close().catch(() => {});
    const compact = await capture({ view: 'compact' });
    await check('ai-routes R7: "What each job uses" draws the same markup in Default and Compact (ids stripped)', async () => {
      assert(def.html === compact.html, `markup differs:\n${def.html}\n${compact.html}`);
    });
    await compact.context.close().catch(() => {});
  }

  // ---------------------------------------------------------------- R8: no paid call from drawing, Check again or changing rows

  {
    const { page, context, errors } = await open({ theme: 'dark', width: 1440, height: 900, ai: 'all', aiPlugin: true, hash: '#/settings/ai' });
    await check('ai-routes R8: opening the page, Check again and changing rows send no ai_test', async () => {
      await page.waitForSelector('[data-ai-profile="claude"]');
      await settled(page);
      await page.click('[data-ai-profile="codemie:staging"] [data-action="ai-refresh"]');
      await page.waitForTimeout(150);
      await page.locator('select[data-route="automation"][data-field="profile"]').selectOption('codemie:prod');
      await page.waitForFunction(() => window.__bridgeCalls.some(([op, d]) => op === 'ai_settings_save' && d.routes.automation?.profile === 'codemie:prod'));
      await page.locator('select[data-route="triage"][data-field="model"]').selectOption('claude-sonnet-4-5').catch(() => {});
      assert((await calls(page, 'ai_test')).length === 0, JSON.stringify(await calls(page, 'ai_test')));
      assert(errors.length === 0, errors.join(' | '));
    });
    await context.close().catch(() => {});
  }
}
