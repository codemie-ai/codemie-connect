# Home Grid Actions — Final Disposition of the Five Original Actions

**Ticket**: EPMCDME-14589 (`EPMCDME-14589-home-checklist`)
**Date**: 2026-09-21
**Status**: Decided — closes the last open item from EPMCDME-14511's grid-retention decision
**Spec**: `docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md` (the origin of the "five
actions" framing; no dedicated `.ai-run/decisions/` file exists for EPMCDME-14511, so this doc
cites the spec directly)

---

## Decision

The Home launcher grid itself is removed as part of EPMCDME-14589 (Home's content moved to
`ui/home-view.js`). EPMCDME-14511's spec required that none of the grid's five actions —
`install-only`, `full`, `connect-desktop`, `update-cli`, `analytics` — be orphaned by any future
rework of Home. With the analytics sidebar entry unhidden in this ticket, all five now have a
final, settled entry point. None are pending; none require further follow-up.

| Action | Fate | Owning entry point | Evidence |
|---|---|---|---|
| `install-only` | Retired | — (removed before this ticket) | `ui/test/home-copy.test.mjs:17-19`, `:33-37` — regression tests asserting the wording and dead code (`INSTALL_ONLY_IDS`, `'install-only'`, "full installation") stay gone. Retired by EPMCDME-14979 (commits `45c415d`, `8eb4eef`), merged before this ticket started. |
| `full` | Survives | Notice modal raised by `ensureAuthenticated()` | `ui/renderer.js:469-487` — on a blocked profile state, shows a notice with `primaryAction: () => enterWizard()`, replacing the grid tile's direct entry into Setup. |
| `connect-desktop` | Survives | Connections sidebar entry | `ui/index.html:58` (`#sidebar-connections`, `data-view="connect"`); `ui/renderer.js:826-830` (`connectBtn` click handler, gated by `ensureAuthenticated()`, runs `codemie proxy connect desktop`). |
| `update-cli` | Survives | Update CLI button on the update banner | `ui/index.html:37` (`#update-banner-run`); `ui/renderer.js:679-682` (`runUpdateCli()`), invoked from the banner wiring around `ui/renderer.js:552-605`. |
| `analytics` | Survives | `#sidebar-analytics` sidebar entry (this ticket) | `ui/index.html:70` — `hidden` class removed by this ticket. `ui/renderer.js:819-822` — click handler (`runAnalytics()`) was already live and unconditional; only the markup gate needed removing, per EPMCDME-14511 spec.md:19 ("one class restores each"). Pinned by `ui/test/home-copy.test.mjs`'s `shell: the analytics sidebar entry is unhidden and wired` test. |

## Rationale

EPMCDME-14511's spec (`docs/superpowers/tasks/2026-08-31-epmcdme-14511/spec.md:33-34`) required
that the grid's removal not orphan any of its five actions, and shipped `analytics` and `about`
sidebar entries deliberately hidden pending ownership. `about` remains out of scope (no sub-task of
EPMCDME-14350 owns its content) and stays hidden. `analytics` is EPMCDME-14589's to resolve, and
its handler required no change — only the markup gate — because the wiring was built and left live
in anticipation of this moment.

---

## Follow-ups (out of scope here)

- `#sidebar-about` remains hidden pending an owning ticket; not part of this decision.
