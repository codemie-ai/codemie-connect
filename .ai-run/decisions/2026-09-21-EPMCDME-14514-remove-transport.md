# Remove runs through runStream, not a PTY

**Ticket**: EPMCDME-14514 (Agents screen)
**Date**: 2026-09-21
**Status**: Decided
**Evidence**: `cli/commands/uninstall.js` in the shipped CLI, read from the bundle at
`Contents/Resources/cli/node_modules/@codemieai/code/dist`

---

## The question

The ticket left Remove's transport open: `codemie uninstall`'s help lists no `--yes`, so if
it asks for confirmation before removing, the action has to go through `pty.spawnPty`
instead of `runner.runStream`, which cannot answer a prompt.

## What the command does

With a name, `uninstall.js` resolves the agent, returns early with a message when it is not
installed, and otherwise goes straight to `agent.uninstall()` behind an `ora` spinner. There
is no `inquirer`, no `readline`, no confirmation of any kind in the file — the only
interactive-looking branch is the bare invocation, which just lists what is installed.

## Decision

- **Remove uses `runner.runStream('codemie uninstall <agent>')`.** No PTY.
- The agent name is always passed, so the listing branch is unreachable, as the ticket's
  "always pass the agent name" rule requires.
- The spinner writes to stderr, like `codemie doctor`'s, so a caller that only keeps stdout
  will see an empty stream on success. Read both tags when rendering the output inline.
- Removing an agent that is already gone exits 0 with a plain message, so that case needs no
  special handling beyond re-reading `codemie list`.

This was settled by reading the shipped command rather than by uninstalling a real agent, so
no agent on this machine was touched.
