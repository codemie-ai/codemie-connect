# Echo plugins: findings and reuse proposal

Inspected 16 November 2026: this Connect checkout, `../echo`, `../echo-plugins`, Echo’s `future/` designs and the live CodeMie preview through Chrome. The production native versions in Connect’s Cargo/Tauri metadata are 2.1.1 (the npm package still says 2.1.0). Echo’s workspace metadata is 0.9.9. This is source inspection plus one starter package check, not cross-host runtime validation.

## Answer

**Unchanged Echo packages are a feasible compatibility target. They do not run in current Connect.** Both applications use Rust and a system webview, but an Echo plugin is JavaScript running against Echo’s application API, not a Rust dynamic library or a Tauri plugin.

A package contains `echo-plugin.json`, a host entry `main.js` exporting `apply(ctx)`, usually `client.js` exporting `apply(ctx)`, optional widgets, settings, package skills, scripts and `agent/` guidance. A marketplace is a repository with `echo-marketplace.json`. The four inspected marketplace packages all require Echo ≥0.9.9.

**Recommendation:** retain Tauri as Connect’s shell; implement an Echo-compatible host service layer in Rust and a compatible client extension layer in the webview. Keep package bytes unchanged. Map application services behind the contract to Connect-owned data and AI profiles. A shared runtime crate is preferable if the owners agree on its licensing and maintenance; otherwise implement the contract independently and run the same conformance fixtures in both hosts.

Do not require the separately installed Echo desktop app or share its live state directory. A sidecar prototype could help validate the contract, but invoking `echoctl plugin call` alone does not provide window extensions, long-lived timers, event delivery or the full app host. Process separation alone does not settle distribution obligations.

## Evidence in the inspected repositories

| Evidence | What it establishes |
|---|---|
| `echo/crates/echoctl/src/plugins.rs` (`Manifest`, `read_manifest`, `needs_echo`, tree checks) | Format/version validation, package acquisition, limits, hashes and installation registry. This is app code, not an independently published runtime crate. |
| `echo/crates/echoctl/src/jshost.rs` (`PRELUDE`, host thread and service dispatch) | Embedded rquickjs, context per plugin, message-driven commands/timers/events and async worker services. |
| `echo/crates/echoctl/src/jshost/service_async.rs` | Dependencies on AI command construction, folder grants, delivery and the running Echo application. It cannot simply be copied as an isolated module. |
| `echo/crates/echoctl/src/plugins/capabilities.rs` | Host-owned permission descriptions. `brain_source` and `export` exist but are not ready; they must not be silently granted. |
| `echo/crates/echoctl/ui/app/33-plugins-client.js` (`pluginCtx`, `SLOTS`, unload ownership) | Panels, activities, settings, command palette, UI helpers, widgets, slot registry and lifecycle cleanup. |
| `echo-plugins/plugins/*/echo-plugin.json` | Real package requirements and installed versions listed below. |
| `echo-plugins/plugins/obsidian/client.js` | UI depends on Echo CSS variables and structural classes such as `.br-pane`, beyond a generic panel API. A visual/helper adapter needs auditing. |
| `echo/crates/echoctl/src/knowledge/chat/skills.rs`, `guard.rs` | Profile-scoped personal skill discovery and guarded access. Preserve exact catalog names; do not copy personal skills into vaults just to discover them. |
| `echo/.ai-run/reference/plugins/plugin-api.md`, `echo-host.md` | API reference and data/session/script behavior cross-checked against the implementation. |

## What each real package needs

| Package | Version | Required host behavior | Required UI/application integration |
|---|---:|---|---|
| GitHub | 0.3.0 | Sign-in via host (`gh`/git or plugin-owned sign-in), allowlisted GitHub HTTP, stores, work providers, thread values, agent/session hints | 3 widgets (`list`, `status`, `stats`), settings, thread profile sources, work actions and palette integration |
| Obsidian | 0.8.0 | User-picked folders, scoped bulk file reads, Claude profile runs, Echo-shaped clients/threads/dictionary/sources, dictionary writes, events, session skills/read/hints/commands | Knowledge tabs/settings, vault browser and graph helpers, Echo UI tokens and classes, safe Markdown and page rendering |
| Scheduler | 0.4.0 | Long-lived timers, store and package reads, profiles, guarded Claude runs, inbox, notifications and Teams/mail/Telegram/Today delivery | Automations panel, settings, palette, result/history UI; background operation while the native host runs |
| Telegram | 0.4.0 | HTTPS to `api.telegram.org`, secret settings, delivery provider, Claude channel plugin install/check, session channel registration, host tool discovery | Bot settings and channel navigation; dependency on `telegram@claude-plugins-official` in the selected profile |

These are **dependencies found in source**, not green compatibility certifications. Obsidian’s data integration is a larger task than rendering its client panel. Scheduler needs delivery services even when its definition is local. Telegram is not just a webhook UI.

## Host contract to implement

1. **Packages and catalog:** unchanged manifest fields and IDs; exact supported Echo contract baseline distinct from Connect’s own app version; semver requirement checks; path/tree restrictions; resolved source commit and content hashes. Unknown capabilities produce a visible incompatibility, never a grant.
2. **Runtime:** QuickJS host thread, async completion messages and per-plugin context; 64 MB runtime shared by host halves, 5-second uninterrupted-JS slice, 30-second window command timeout, minimum 10-second timers as in the inspected host. Stop plugin work on unload and keep the shell responsive.
3. **Services:** command/timer/event registration; store/cache/settings/secrets; package reads; HTTP allowlists; folder grants and file APIs; notifications/inbox; thread/shared values; widget/work providers; sign-in; profiles and Claude jobs; sessions/agent layout; delivery and declared scripts. Every service checks the installed manifest.
4. **Client contract:** `ctx.call`, `listen`, `slots`, `panels`, `activities`, `settings`, `palette`, `widgets.draw`, routing/rendering and `ctx.ui` helpers. Retain all six slots: `call.menu`, `calendar.event`, `task.actions`, `thread.profile`, `knowledge.tab`, `knowledge.settings`. Clean up listeners, styles and registrations when unloading.
5. **UI compatibility:** alias Echo’s CSS tokens, provide helper markup and graph facilities, translate `ctx.go` hash routes and `ctx.openEchoPanel`, handle `echo://` links in Connect, and audit package structural CSS assumptions. A differently styled shell must still preserve required plugin markup behavior.
6. **Application adapters:** map Echo thread IDs to stable Connect space IDs while preserving merge/delete semantics; supply Echo-shaped clients, people, source and dictionary records; implement source/event revisions and per-dashboard widget parameters. Keep each host’s stores and credentials separate.
7. **AI/session adapter:** route `ctx.claude.run` through a ready direct-Claude or CodeMie-Claude profile; pin the profile per session/routine; preserve leases, guards, tool limits, package and runtime skills, `agent/` layout and command allowlists. Preserve the CLI/launcher contract used by plugin skills, including guarded `plugin call` and script entry points. Do not rewrite packages to point at arbitrary executables.
8. **Updates and trust:** stage/validate first, compare capability/agent/script digests, request review for added access, stop old work, activate the new package, retain a recovery path and keep data migrations explicit. Distinguish disabled, incompatible, failed and running states.

Full reuse means the **whole observable contract**, not a `ctx` object with no-op methods. Never return success for a missing data or delivery service. New third-party packages may use contract corners the four current packages do not; keep a versioned conformance suite and expose unsupported versions.

## “Any desktop capability”

Echo has declared package scripts, launched through the host with bounded time/output, isolated process groups and sanitized environment. They still run with the user’s rights. Client halves are trusted code in the host webview. Neither mechanism is an OS sandbox.

Use the existing script contract for trusted automation a package already declares. Add structured desktop services only as new versioned capabilities with OS-specific Rust adapters, explicit permissions and tests. Compiled native/Tauri extensions are a separate trusted extension type. Do not claim they are interchangeable with Echo packages. For an extension to run unchanged in both apps, both hosts need that capability.

## Licensing and distribution gate

Echo’s root workspace declares **AGPL-3.0-only**; Connect declares **Apache-2.0**. No repository-level LICENSE file was found in the inspected `echo-plugins` checkout. Confirm package redistribution rights and the runtime’s approved licensing path with the owners before embedding or distributing source. This observation does not establish a legal conclusion about a proposed distribution.

The prototype includes no Echo runtime or package source. Its original `focus-card` example uses the public package structure and passed the existing local Echo binary’s read-only `plugin check ... --json` with no problems. That proves package acceptance by that binary, not execution or full interoperability.

## Process after design approval

1. Agree the runtime licensing/ownership route and publish the shared contract baseline.
2. Build a narrow host adapter; run the original Focus card package in both hosts. Prove render, unload, timeout and restart behavior.
3. Run unchanged GitHub next: fake sign-in and fake HTTP, then settings, widgets and thread lifecycle. Add only services with real semantics.
4. Add Scheduler (background + profiles + delivery), Obsidian (data and Knowledge/session parity), then Telegram (channel and credential lifecycle). Keep per-package statuses visible.
5. Exercise install/disable/remove, crash/recovery, failed updates, changed permissions, data migration and macOS/Windows differences. Only then mark a package/contract version **Verified**.
6. Publish one original package to a test `echo-marketplace.json`; install its identical files in both apps; make the same fixture suite part of both hosts’ release checks.

## Microsoft 365 is a host service, not an Echo marketplace package

Echo has native `graph.rs` and `m365.rs`: browser OAuth + PKCE, calendar, mail, chats, people, files and outward actions. The current base scope string is `openid profile offline_access User.Read Calendars.Read Chat.Read People.Read`; broader M365 commands rely on the actual consented token permissions. Do not infer Mail.Read, Files.Read or send rights from calendar connection success.

Proposed Connect uses per-feature delegated access, cached/read-only recovery states and an organization-owned registration option. Request `Calendars.Read`, `Mail.Read`, `Chat.Read`, `People.Read` and `Files.Read` as needed; request `Mail.Send`, `ChatMessage.Send` and `Calendars.ReadWrite` separately for their actions. Channel posts, directory hierarchy and broader file scopes require additional endpoint-specific review. App-only tenant-wide access is outside this personal prototype.

Microsoft’s [authorization-code flow documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) supports PKCE for desktop apps. Its [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference) defines the separate read, write and send permissions. Tenant policy can prevent user consent even for a delegated flow. Native account/token handling must remain in the backend; no token belongs in prototype storage or plugin-visible general settings.

## CodeMie visual integration · proposal v2

The shell now uses the measured CodeMie design system. Plugin compatibility must not force the entire application back to Echo styling. Provide Echo helper markup, CSS aliases and data/route adapters inside a controlled plugin boundary. Test packages that reference structural classes or global selectors. Keep the package bytes unchanged; expose a compatibility limitation when the host cannot preserve expected behavior.

Today has one persistent layout model for core and plugin cards: visibility, order and width. Disabling a package removes its live contribution while retaining layout preferences for re-enabling. The browser prototype demonstrates this with GitHub, Scheduler and the Focus card starter. It does not execute their source.
