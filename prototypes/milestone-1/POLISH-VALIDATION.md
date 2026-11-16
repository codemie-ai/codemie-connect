# Milestone 1 — product polish and validation (2026-11-16)

Owner feedback on the first implementation: Microsoft required picking calendars, Outlook and Teams chats per workspace; Calendar was not synced and had no time grid; Today was primitive; the sign-in return page was bare; no profile or photo; controls did not match the CodeMie platform. This pass fixes each of these. It supersedes the visual parts of [DESIGN-CORRECTION.md](DESIGN-CORRECTION.md); the gates in [IMPLEMENTATION-VALIDATION.md](IMPLEMENTATION-VALIDATION.md) that were open stay open unless listed below.

## What changed

| Area | Before | Now |
|---|---|---|
| Microsoft sources | Explicit per-workspace selection of calendars, Outlook and individual Teams chats; manual "bind workspace" | One sign-in. Every workspace on the account uses `sources = {"all": true}`: all calendars, Outlook Inbox + Sent, recently active Teams chats. Old selections are upgraded on open. No source picker remains |
| Sync cost | Every selected chat fully re-read every minute; calendars every minute | One chat discovery request per round; a chat is read only when its last-message id changes; newest 25 messages kept per chat; calendar full refresh at most every 5 min unless you press Sync |
| Profile | Name and e-mail only | Given name, job title, department, office and 120×120 photo at sign-in and daily; shown in the sidebar, Today greeting, Settings and conversation threads |
| Sign-in return page | Plain text | Branded, self-contained page (inline CodeMie mark, light/dark, success and error states) under a nonce-only CSP |
| Today | Counters and a deterministic brief | Greeting with photo; Up next / Happening now with countdown, progress, attendees and one-click Join; Day at a glance (meetings left, time in meetings, free time, replies, focus timer); timed schedule with now-line and free slots; Needs your reply (Outlook + Teams, critical first); inline commitments and autosaved notes |
| Calendar | Day cells listing titles | Day/Week time grid (hour gutter, now-line, overlap columns, all-day row, tentative/free styling), Month grid with "+N more", Agenda; mini-month, per-calendar colours and visibility, keyboard shortcuts (T, ←/→, D/W/M/A); event dialog with Teams join, attendees and responses |
| Inbox | Stacked modals | List + reading pane with lanes, Outlook/Teams filter, search, conversation thread, snooze presets, lane move, done, commitments, local drafts; Teams chats shown as one row per chat |
| Components | Partly matched | Values from [CODEMIE-DESIGN-SPEC.md](CODEMIE-DESIGN-SPEC.md) and the live platform: 28 px buttons (gradient-outline primary in dark, blue tint in light), 32×16 switches, 16 px checkboxes, 8 px dialogs over a 50% scrim, GeistMono UI |
| Frontend code | Minified one-line modules | Readable ES modules: controller, store, pure calendar geometry, formatting, selectors, components and one renderer per route |

## Verification

| Check | Result |
|---|---|
| `npm test` | 552 tests, 549 pass, 3 Windows-only skips, 0 failures (27 workspace tests: calendar geometry incl. time zones, DST, overnight, zero-length, all-day and overlaps; formatting; selectors incl. critical-first chats; view rendering and HTML escaping) |
| `cargo fmt --check`, `cargo clippy -- -D warnings` | Clean |
| `cargo test` | 184 unit + 2 integration pass (loopback/PTY/hdiutil tests run outside the sandbox) |
| Browser E2E `ui/test/browser/workspace-e2e.mjs` | 34/34: both themes, sign-in onboarding, Today, Join, commitments, notes autosave, focus, Customize, Calendar (4 modes, navigation, calendar visibility), event dialog, Inbox (lanes, snooze, done, Teams filter, hostile HTML escaped), Settings (profile, automatic sources, sync), Workspaces, sign-out, no overflow at 1000/1440/1680 px, no page errors. Mocked native bridge — not native evidence |
| `./build-installer.sh --skip-stage` | All bundle assertions pass; app + DMG produced |
| Native release app on the owner's existing connected profile (read-only) | See below |

### Native, live Microsoft 365 (read-only)

The database was backed up first (`workspace.sqlite.before-m1-polish-20261116` in the workspace folder). Only aggregate counts were inspected; no message, event or token contents were read or retained.

| | Before upgrade | After first sync of the new build |
|---|---|---|
| Personal workspace sources | 1 calendar, Outlook, 0 chats (explicit) | `{"all": true}` (migrated at open) |
| Profile | No photo, no title | Photo 5.7 KB data URL, job title, given name |
| Calendars synced | 1 of 3 | 3 of 3; 475 events, all with attendee data |
| Teams | 0 messages | 50 chats discovered with members; 39 active chats synced |
| Mail | 200 messages | 203, all with read/importance/attachment flags |
| First sync | — | Succeeded in about 95 s; no sync error |

The first live run kept 4,242 Teams messages (every message in 14 days) and a 1.48 MB chat catalog (Graph's full member objects). That led to three changes, verified on the second launch:

- 25 newest messages per chat (pruned at open and after each chat read; anything with a decision, draft, commitment or action is kept): 4,242 → 920 messages, at most 25 per chat, 49 chats.
- Cached chats keep only `{userId, displayName}` for up to 25 members plus the true member count; events keep up to 50 attendees plus `attendeeCount`. Replies still re-read members from Graph before review.
- Final build on the same profile: chat catalog 1.48 MB → 51 KB, provider data 4.0 MB → 2.4 MB, 920 Teams messages (max 25 per chat), sync succeeded in 21 s with no error, zero outbound actions. Unchanged chats are skipped, so a launch sync takes 21 s instead of the first 95 s.
- The window reloads the snapshot at most about once a second during a sync, and the backend's idle nudge dropped from every 10 s to every 60 s.

No sends, replies, Teams posts or calendar writes were made. The account already had write capabilities enabled from earlier testing; they were not exercised.

## Independent review

A separate reviewer read the full change. Its 13 findings were fixed and covered by tests:

- Done, Snooze, Move and Acknowledge apply to every message of a Teams chat row.
- The selection and drafts follow the conversation, so a new message does not drop an unsaved reply.
- Opening a notification resets filters and selects the right chat.
- A chat's critical message is never hidden behind a newer reply.
- "Review & send" cannot prepare two sends from one double click.
- One unreadable or extra calendar no longer blocks Calendar coverage or marks every sync partial.
- Date keys use Gregorian, Latin-digit formatting in every locale.
- Tomorrow and yesterday step by calendar day across DST.
- A zero-length event at midnight stays a point.
- The re-sign-in wording no longer promises cached data that is not shown.
- Keyboard focus stays on the reorder buttons in Customize Today.
- The orphaned "daily brief" schedule option was removed.
- The new "Teams chat" placeholder title falls back to the chat topic and members.

It found no XSS path: every provider string is escaped, colours are validated hex, and photos must be JPEG/PNG data URLs. It also found no token or Graph-host leak.

## Still open

Unchanged from the earlier report: live outbound actions, a second account/tenant, the OS notification matrix, real AI-provider drafting, destructive installer/upgrade/rollback matrix, Windows, Intel/display scaling, performance distributions, the eight-hour soak and signing/notarization.
