# Implementation sequence · proposal v2

This is an isolated HTML proposal. Production source remains unchanged. Approve functionality and visual direction before implementing native changes one slice at a time.

1. **CodeMie shell + setup relocation.** Introduce the measured CodeMie design tokens and navigation; move current installation, tool inventory, Desktop proxy, health, logs and updates into Settings → Setup & tools. Preserve every current IPC/installer behavior. Add a non-blocking first-run banner and direct-Claude setup path.
2. **Workspace state and profiles.** Local workspace folder, identity independent of platform sign-in, profile-scoped sessions and skills, pinned conversation/routine profile, permissions and activity log. CodeMie connection remains optional.
3. **Today + calendar context.** Inline sourced brief, agenda, decisions, commitments, Knowledge and usage cards. Persist card size/order/visibility. Add Microsoft Graph capability-by-capability consent, cached states, expiry/admin recovery and separate write permissions.
4. **Capture and recipes.** OS capability probe, explicit source/scope, participant notice, local tracks and transcription. Delay/manual minutes, recipes and reviewed actions/Knowledge output. Validate each supported OS and source separately.
5. **Knowledge.** Existing vault in place, reader/editor/history, graph and exact profile skill catalog. Read-only Ask first; source ingestion and per-file review next; 12 health checks grouped by deterministic, AI and human decisions. Enforce read-only at the native boundary.
6. **Echo compatibility host.** Resolve licensing approach; freeze an exact Echo contract baseline. Implement package lifecycle, Rust services, AI/session/data adapters and scoped client UI compatibility. Run each unchanged package in both hosts with the same fixtures. Expose missing capabilities instead of no-op success.
7. **Routines, Inbox and extension ecosystem.** Deterministic-first triage with evidence, reviewed delivery, catch-up scheduling, actual run history, marketplace trust/update policy and package developer conformance tooling.

## Review gates

- Visual: CodeMie shell and all screens in light/dark; desktop and compact desktop; usable narrow layout.
- Browser: persistent forms, drafts, card layout, scopes, consent, review and individual approval states; no console errors, missing local links or accidental overflow.
- Production migration: existing installer/CLI/proxy behavior receives its existing required Rust/JS/build gates after implementation. HTML checks do not qualify native behavior.
- Plugin release: unchanged package bytes; capability, data, UI, lifecycle and session conformance; OS-specific script behavior; license/distribution decision.

Current screen coverage: SCREEN-MAP.md. Echo page-by-page evidence: ECHO-REVIEW.md. Native/plugin limits: PLUGIN-REUSE.md. Current browser results: ../validation/v2/REPORT.md.
