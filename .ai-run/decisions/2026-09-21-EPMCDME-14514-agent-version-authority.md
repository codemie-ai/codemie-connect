# Which command is authoritative for an agent's version

**Ticket**: EPMCDME-14514 (Agents screen)
**Date**: 2026-09-21
**Status**: Decided
**Evidence**: the shipped CLI in the bundle, `Contents/Resources/cli/node_modules/@codemieai/code/dist`

---

## The problem the ticket raised

`codemie list` prints `CodeMie Code (0.0.47)` while `codemie update --check` prints
`Current: 0.14.1` for the same display name. Joining the two by name would put two
different versions of one agent on screen. Claude Code and OpenCode agree across both
commands, so the disagreement looked specific rather than systematic, and the ticket asked
for a decision rather than a guess.

## What the CLI actually does

Both commands start from the same call: `agent.getVersion()`, which runs
`<cliCommand> --version` and returns its trimmed stdout (`agents/core/BaseAgentAdapter.js`).
`cli/commands/list.js` prints exactly that. `cli/commands/update.js` then departs from it in
two places:

- `agent.name === 'claude'` compares the installed version against **CodeMie's supported
  version**, not against npm's latest.
- `agent.metadata.isBuiltIn` — the CodeMie Code agent — replaces the version entirely with
  `getCurrentCliVersion()` and compares it against npm's latest `@codemieai/code`.

So for the built-in agent the two commands answer different questions on purpose:
`list` reports the agent binary's own version, `update --check` reports the CLI package's.
Neither is wrong, and this is deliberate CLI behaviour rather than a bug to report.

## Decision

- **The version shown in a row comes from `codemie list`.** It is the agent's own
  `--version` for every agent, with no special cases.
- **`codemie update --check` is read only for the update-available flag**, never for a
  version the screen displays. Its `Current:` value is not rendered anywhere.
- Consequently the screen can never show two contradictory versions for one agent, and the
  join between the two parsers carries a boolean, not a number.

`ui/agents-ui.js` draws the row subtitle as `description · version` from the list record
alone, covered by `ui/test/agents-ui.test.mjs`.

## Not raised with the CLI team

The ticket suggested raising the disagreement with them. There is nothing to raise: the
behaviour is intentional and documented in their own source comment ("uses CLI package
version"). Rendering it as an agent version would have been our bug, not theirs.
