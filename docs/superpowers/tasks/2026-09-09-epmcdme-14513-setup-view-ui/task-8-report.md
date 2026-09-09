status: DONE

## Summary

Task 8 completed successfully. Modified `ui/renderer.js` to wire the setup-view dev hook by adding the `createSetupView` import and extending the `window.__codemie` object with a new `startGuidedSetup` function.

## Changes

- **File modified:** `ui/renderer.js`
- **Commit SHA:** `025c0cf1c94a26083b4242261c42ce66cc2e2917` (short: `025c0cf`)
- **Changed files (from git show --stat HEAD):** `ui/renderer.js` (10 insertions, 1 deletion)

## What was changed

Inside the existing `if (flags.dev)` block (lines 488-491), added:
1. Import statement: `const { createSetupView } = await import('./setup-view.js');`
2. Extended `window.__codemie` object with new property:
   ```js
   startGuidedSetup: () => {
     showView('setup');
     return createSetupView(document.getElementById('setup-view')).start();
   }
   ```

The existing `showView` and `startSetup` entries were left completely untouched.

## Verification

- **Syntax check:** `node --check ui/renderer.js` — passed (no errors)
- **Test suite:** `node --test ui/test/*.test.mjs` — EXIT=0, 177 tests passed, 0 failures
- **Git status:** Only `ui/renderer.js` was modified, nothing else
- **Commit message:** Follows convention on this branch (`EPMCDME-14513: wire setup-view dev hook (task 8)`)

## No concerns

The modification is minimal, surgical, and integrates the already-tested `createSetupView` export from `ui/setup-view.js` into the dev-mode console hook exactly as specified.
