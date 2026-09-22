# The built-in agent does not tick "Install an agent"

**Ticket**: EPMCDME-15189 (onboarding polish)
**Date**: 2026-09-22
**Status**: Decided
**Evidence**: measured against the shipped CLI on a clean profile

---

## What was measured

On a machine with an empty HOME and a PATH holding nothing but the bundled shim:

```
$ which codemie-code
(nothing)

$ codemie list
  CodeMie Code (0.0.47)
    Command: codemie-code
    Status: ✓ installed
```

The CLI reports its own built-in agent as installed because it ships inside the CLI package.
Nothing was installed by the user, and nothing can be: it has no install to run.

## Why it matters

Home's checklist ticked "Install an agent" the moment the list was read, on every machine,
before the user had done anything. The step was decorative: the first-run path the parent
story describes — "walks me through signing in, setting up and installing the agent I need" —
had one step that was always already done, and the control this ticket adds would never have
been reachable.

## Decision

**The step counts the agents a user installs, not the one that ships.** `agentItem` in
`ui/home-state.js` ignores the built-in command when deciding whether the step is complete,
and the list Home opens shows the built-in among the installed agents rather than offering it.

The built-in agent is identified by its command, `codemie-code`, exported as
`BUILTIN_AGENT_COMMAND`. If the CLI ever marks it in `codemie list` output, read the mark
instead of the name.
