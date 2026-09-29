import { test, expect, Page } from '@playwright/test';

// Dynamic verification for EPMCDME-14506 (Health screen). The renderer talks
// to Tauri's `invoke`/`listen` at module scope; there is no dev server /
// browser story for this desktop app, so this test injects a minimal
// `window.__TAURI__` stub before the page scripts run and drives the real
// `ui/index.html` + `ui/renderer.js` (served over http by static-server.mjs —
// ES module imports are blocked under file://) against it.
//
// The stub's `run_stream` handler feeds a fixture-shaped `codemie doctor`
// text block through the SAME `engine:cmd-line` event path
// `runner-bridge.js`'s real `runStream()` listens on, so the full pipeline —
// stream -> filter-to-stdout -> join -> parseDoctorOutput -> groupDoctorResults
// -> renderHealth — runs for real, in a real DOM, not a JS-object stand-in.

const BASE_INVOKES: Record<string, unknown> = {
  smoke_mode: { probe: false, smoke: false },
  get_steps: [],
  get_logo_path: '',
  check_codemie_version: '1.0.0',
  fetch_codemie_latest: '1.0.0',
  check_profile_status: { authenticated: true, detail: '' },
  read_codemie_config: {
    state: 'valid', profile: 'default', model: 'Sonnet 5', project: 'EPM-CDME',
    account: 'n_levyankov@epam.com',
  },
  get_platform_info: { arch: 'aarch64', platform: 'macos' },
  temp_dir: '/tmp',
};

// ---- doctor text fixtures (same grammar as ui/test/fixtures/doctor/*.txt) ----

const ALL_PASSING = `Node Version:
  ✓ v20.11.0 detected

Npm:
  ✓ 10.2.4 detected

Python:
  ✓ 3.11.4 detected

Uv:
  ✓ 0.4.18 detected

AWS CLI:
  ✓ 2.15.0 detected

Active Profile:
  ✓ default active

JWT Auth:
  ✓ Authenticated

Agents:
  ✓ 3 agents installed
  ✓ All agents up to date

Workflows:
  ✓ 5 workflows available

Frameworks:
  ✓ 2 frameworks available

Provider:
  ✓ Anthropic reachable

✓ All checks passed!
`;

// Provider fails with a hint but Provider has no deep-link mapping -> the row
// must offer a plain "Check again" action instead.
const PROVIDER_FAILURE = ALL_PASSING.replace(
  '  ✓ Anthropic reachable',
  '  ✗ Anthropic unreachable\n      Check your network connection and try again',
);

// Agents fails with a hint -> the row must deep-link ("Go to Agents") per
// doctor-groups.js's DEEP_LINKS table.
const AGENTS_FAILURE = ALL_PASSING.replace(
  '  ✓ 3 agents installed\n  ✓ All agents up to date',
  '  ✗ No agents installed\n      Run: codemie install agent',
);

type Boot = { doctorText: string; openLogError?: string; streamDelayMs?: number };

async function boot(page: Page, opts: Boot) {
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  (page as any).__consoleErrors = consoleErrors;

  await page.addInitScript(({ base, doctorText, openLogError, streamDelayMs }) => {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    (window as any).__runStreamCalls = 0;
    (window as any).__openLogCalls = 0;

    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string, args: any) => {
          if (cmd === 'run_stream') {
            (window as any).__runStreamCalls += 1;
            const { streamId } = args || {};
            const emit = () => {
              for (const line of doctorText.split('\n')) {
                (listeners['engine:cmd-line'] || []).forEach((cb) =>
                  cb({ payload: { id: streamId, text: line, tag: 'stdout' } }));
              }
            };
            if (streamDelayMs) {
              await new Promise((r) => setTimeout(r, streamDelayMs));
            }
            emit();
            return 0;
          }
          if (cmd === 'open_log') {
            (window as any).__openLogCalls += 1;
            if (openLogError) throw new Error(openLogError);
            return null;
          }
          return cmd in base ? (base as any)[cmd] : null;
        },
      },
      event: {
        listen: async (event: string, cb: (e: any) => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
          return () => {
            listeners[event] = (listeners[event] || []).filter((c) => c !== cb);
          };
        },
      },
    };
  }, { base: BASE_INVOKES, doctorText: opts.doctorText, openLogError: opts.openLogError, streamDelayMs: opts.streamDelayMs });

  await page.goto('/index.html');
  await page.waitForFunction(() => document.getElementById('sidebar-home') !== null);
  await page.waitForTimeout(200);
}

function consoleErrorsOf(page: Page): string[] {
  return (page as any).__consoleErrors || [];
}

test.use({ viewport: { width: 1280, height: 800 } });

// ------------------------------------------------- 1. AUTO-RUN + SUMMARY + GROUPING
test('Health screen auto-runs the full check set on first navigation, shows a loading state, then the passing/total summary with runtime checks collapsed into one CodeMie row', async ({ page }) => {
  await boot(page, { doctorText: ALL_PASSING, streamDelayMs: 150 });

  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view')).not.toHaveClass(/hidden/);

  // Loading state is visible immediately (before the delayed stream resolves).
  await expect(page.locator('#health-view')).toContainText('Checking');

  // After the doctor run resolves: summary line computed from what ran.
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });

  // Exactly one auto-run happened for this first navigation.
  expect(await page.evaluate(() => (window as any).__runStreamCalls)).toBe(1);

  // Node/Npm/Python/Uv collapse into ONE row under CodeMie itself, not four.
  const rowLabels = await page.$$eval('#health-view .health-row', (els) => els.map((e) => e.textContent));
  expect(rowLabels.filter((t) => /Everything CodeMie needs to run is included/.test(t || ''))).toHaveLength(1);
  for (const name of ['Node Version', 'Npm', 'Python', 'Uv']) {
    expect(rowLabels.some((t) => t === name)).toBe(false);
  }

  // Group headings present only where rows exist; "Your account", "Your tools",
  // "CodeMie itself" are all populated by the all-passing fixture.
  await expect(page.locator('#health-view .health-group-heading')).toHaveText([
    'Your account', 'Your tools', 'CodeMie itself',
  ]);

  await page.screenshot({ path: 'health-all-passing.png' });
  expect(consoleErrorsOf(page)).toEqual([]);
});

// ------------------------------------------------------- 2. NAVIGATING AWAY AND BACK DOES NOT RE-RUN
test('navigating away from Health and back does not re-trigger the doctor run (one-shot auto-run)', async ({ page }) => {
  await boot(page, { doctorText: ALL_PASSING });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });
  expect(await page.evaluate(() => (window as any).__runStreamCalls)).toBe(1);

  await page.locator('#sidebar-home').click();
  await expect(page.locator('#home-view')).not.toHaveClass(/hidden/);
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view')).not.toHaveClass(/hidden/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__runStreamCalls)).toBe(1);
  await page.screenshot({ path: 'health-no-rerun-on-renav.png' });
  expect(consoleErrorsOf(page)).toEqual([]);
});

// --------------------------------------------------------- 3. DEEP-LINK REMEDY
test('a failing check with a doctor hint that names an existing screen (Agents) gets a deep-link remedy button that navigates there', async ({ page }) => {
  await boot(page, { doctorText: AGENTS_FAILURE });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('7 of 8 fine', { timeout: 5000 });

  const agentsRow = page.locator('#health-view .health-row', { hasText: 'Agents' });
  await expect(agentsRow).toHaveClass(/health-fail/);
  await expect(agentsRow.locator('.health-remedy')).toHaveText('Run: codemie install agent');
  const deepLinkBtn = agentsRow.locator('button', { hasText: 'Go to Agents' });
  await expect(deepLinkBtn).toBeVisible();

  await page.screenshot({ path: 'health-agents-deep-link.png' });
  await deepLinkBtn.click();
  await expect(page.locator('#agents-view')).not.toHaveClass(/hidden/);
  await expect(page.locator('#health-view')).toHaveClass(/hidden/);
  expect(consoleErrorsOf(page)).toEqual([]);
});

// ------------------------------------------------------- 4. CHECK-AGAIN REMEDY
test('a failing check with a doctor hint but no deep-link (Provider) gets a Check again remedy button that re-runs the full check set', async ({ page }) => {
  await boot(page, { doctorText: PROVIDER_FAILURE });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('7 of 8 fine', { timeout: 5000 });

  const providerRow = page.locator('#health-view .health-row', { hasText: 'Provider' });
  await expect(providerRow).toHaveClass(/health-fail/);
  await expect(providerRow.locator('.health-remedy')).toHaveText('Check your network connection and try again');
  const recheckBtn = providerRow.locator('button', { hasText: 'Check again' });
  await expect(recheckBtn).toBeVisible();
  // Not a deep-link: no "Go to ..." button on this row.
  await expect(providerRow.locator('button', { hasText: 'Go to' })).toHaveCount(0);

  expect(await page.evaluate(() => (window as any).__runStreamCalls)).toBe(1);
  await page.screenshot({ path: 'health-provider-check-again.png' });
  await recheckBtn.click();
  await page.waitForFunction(() => (window as any).__runStreamCalls === 2);
  // Per-row "Check again" is the same full re-run: summary re-renders for all rows.
  await expect(page.locator('#health-view .health-summary')).toHaveText('7 of 8 fine', { timeout: 5000 });
  expect(consoleErrorsOf(page)).toEqual([]);
});

// -------------------------------------------------- 5. FULL "CHECK EVERYTHING AGAIN"
test('"Check everything again" re-runs the full doctor check set and refreshes the summary', async ({ page }) => {
  await boot(page, { doctorText: ALL_PASSING });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });
  expect(await page.evaluate(() => (window as any).__runStreamCalls)).toBe(1);

  await page.locator('#health-view button', { hasText: 'Check everything again' }).click();
  await page.waitForFunction(() => (window as any).__runStreamCalls === 2);
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });
  await page.screenshot({ path: 'health-check-everything-again.png' });
  expect(consoleErrorsOf(page)).toEqual([]);
});

// ------------------------------------------------------- 6. OPEN TODAY'S LOG (SUCCESS)
test('"Open today\'s log" invokes the same open_log capability and shows no error when it succeeds', async ({ page }) => {
  await boot(page, { doctorText: ALL_PASSING });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });

  await page.locator('#health-view button', { hasText: "Open today's log" }).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__openLogCalls)).toBe(1);
  await expect(page.locator('#health-view .health-log-error')).toBeHidden();
  await page.screenshot({ path: 'health-open-log-success.png' });
  expect(consoleErrorsOf(page)).toEqual([]);
});

// -------------------------------------------------- 7. OPEN TODAY'S LOG (FAILURE)
test('"Open today\'s log" surfaces a visible "can\'t read your log" error when the log cannot be opened', async ({ page }) => {
  await boot(page, { doctorText: ALL_PASSING, openLogError: 'log file missing' });
  await page.locator('#sidebar-health').click();
  await expect(page.locator('#health-view .health-summary')).toHaveText('8 of 8 fine', { timeout: 5000 });

  const errorBanner = page.locator('#health-view .health-log-error');
  await expect(errorBanner).toBeHidden();
  await page.locator('#health-view button', { hasText: "Open today's log" }).click();
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toHaveText("Can't read your log: log file missing");

  await page.screenshot({ path: 'health-open-log-error.png' });
  // The failure must not have thrown to the console — it is caught and rendered.
  expect(consoleErrorsOf(page)).toEqual([]);
});
