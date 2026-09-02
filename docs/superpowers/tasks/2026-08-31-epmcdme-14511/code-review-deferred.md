# Deferred from code review — 2026-08-31-epmcdme-14511 (2026-08-31)

- **Sidebar navigation during active install has no confirmation** — `ui/renderer.js:434` — clicking a sidebar item while an `engine.run()`/pty session is active silently navigates away with no warning, losing visibility into the in-progress install. Pre-existing: `wizardBack`/`closeBtn` already call `showView('home')` with no confirmation guard before this change; the sidebar only adds more entry points to a gap that predates this ticket, and no confirmation flow exists anywhere in the app today to reuse.
