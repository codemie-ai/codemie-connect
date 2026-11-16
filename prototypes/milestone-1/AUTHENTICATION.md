# Microsoft authentication — implementation decision

The user requested Echo/CodeMie CLI behavior instead of macOS Keychain. This supersedes the planning proposal's Keychain requirement for macOS. No saved Keychain/Echo/CLI credentials are read, copied or deleted during this change.

## Verified reference behavior

- Echo `crates/echoctl/src/graph.rs`: system-browser authorization code + PKCE; CodeMie public client `3d7688c6-f449-4d04-8b0d-57d94818e922`; atomic JSON token cache in its config folder, file mode `0600`. Its source explicitly describes re-signed-build Keychain prompts.
- CodeMie CLI `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`: the same browser PKCE/public client; a JSON cache at `~/.ms_graph_token_cache.json`, created with mode `0600`. The source is authoritative; its README still describes an older device-code flow.

## Connect behavior

Connect keeps its native browser-PKCE implementation and the same public client. It requests only the capabilities selected in its own Settings. Pre-existing tenant grants can make the returned token broader; native enabled-capability checks still govern every source and outward action.

On macOS, the Connect-owned cache is:

`<Connect app data>/workspace/credentials/graph-<connection UUID>.json`

The folder is `0700`; the file is `0600`. The file contains the refresh token and registration settings; the access token stays in native memory. This is JSON protected by filesystem permissions, following Echo's approach, rather than Keychain encryption. Writes use a unique private temporary file, fsync and atomic rename. Reads reject links, insecure permissions, malformed or oversized data. Credentials never enter JavaScript, snapshots, SQLite, diagnostics or exports.

Windows keeps its existing DPAPI-protected session file and requires its own Windows qualification. No macOS Keychain or Windows Credential Manager prompt is part of Connect's Microsoft session storage.

An old connection without a new file asks for fresh browser sign-in. There is no silent Keychain migration, no use of Echo's `graph.json`, and no use of the CLI cache. Disconnect removes only Connect's own file and the selected cache scope. Old Keychain entries are left untouched.

The generic organization-consent help is separate from local storage. Tenant consent can still require an administrator for a requested Graph permission; a local cache error is never presented as administrator approval.

## Validation boundaries

File-cache tests use synthetic tokens in temporary directories only: first save/load, rotation, idempotent deletion, permissions, malformed/oversized content, symlink rejection and invalid identifiers. They never use a user's saved credentials. Live validation may use only the user's already-authorized read-only Microsoft sign-in; no consent/credential prompt is approved automatically and no sends or calendar writes are permitted.


## macOS read transport

Connect uses the system curl for native Graph GETs, following Echo. Authorization is passed in a stdin configuration, never process arguments or a shell command. User curlrc is disabled, only HTTPS is permitted, redirects are not followed, TLS verification remains enabled, responses/timeouts are bounded, and response headers stay in a bounded native pipe rather than temporary files. Owned child processes stop on cancellation or Quit. OAuth exchange/refresh and reviewed Graph writes retain the native HTTP client; outward write gates remain unexecuted under read-only QA authorization.
