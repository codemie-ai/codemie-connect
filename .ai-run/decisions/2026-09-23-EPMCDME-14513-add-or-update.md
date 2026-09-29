# Guided setup asks "add a new profile or update one", like the CLI

**Ticket**: EPMCDME-14513 (guided setup UI)
**Date**: 2026-09-23
**Status**: Decided by the story author (Mert Efe)
**Evidence**: the bundled CLI 0.15.2, `cli/commands/setup.js`, and real runs of the driver against it

---

## What changed

Guided setup ran `codemie setup --force`. `--force` skips the CLI's first question when
profiles exist, "What would you like to do?" (Add a new profile / Update an existing profile /
Cancel), so the app could only ever add a profile. 14513's definition of done said existing
profiles stay unmodified, and pointed the update branch at EPMCDME-14576, whose description
covers list, switch, rename and delete but not update. Nothing owned it.

A user who wanted to change the model of the profile they had was left adding another one each
time. The story author decided update belongs in guided setup now.

The app now runs `cd /; codemie setup` and hands the question to the user, without the CLI's
Cancel (the setup screen has its own way out). "Update an existing profile" leads to the CLI's
"Select profile to update:", shown as a step with every profile the CLI lists.

## Why from `/`

The PTY starts in the home directory. From there the CLI's `hasProjectConfig` finds
`~/.codemie/codemie-cli.config.json` a second time, as a repository-local config: it prints
"Local configuration detected", and an update would save the profile in the local format over
the global file. `/` has no `.codemie`. `;` rather than `&&` so the same line runs in Windows
PowerShell 5.1.

## What an update does, per the CLI

It asks no profile name, does not offer to switch the active profile and does not offer to
install Claude Code. So the app's end check for an update is that the configuration reads back
valid, not that the updated profile became the active one. CLI 0.15.2 keeps `codeMieUrl` and
`codeMieProject` in the shared `workspace` block, so they leave the profile itself on save; that
is the CLI's own layout, not something the app does.

## What it exposed

Walking the profile list the way the model list is walked showed that the walk ended after one
page: it read the first chunk after each arrow key, which can be the tail of the list's first
drawing. Every model list longer than fifteen came back as its first page (41 models read as 15
on a CodeMie account). A half-erased chunk could also add an earlier question's lines to the
list and shift every later pick by two. The walk now waits for the cursor marker to move and
reads only chunks that show the list's own question. Verified against the real CLI: 41 of 41
models, a late pick saved as the model chosen, and an add, an update and an empty-home run each
end to end.
