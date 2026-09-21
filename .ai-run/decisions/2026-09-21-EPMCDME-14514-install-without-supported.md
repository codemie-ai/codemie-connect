# Install runs without --supported

**Ticket**: EPMCDME-14514 (Agents screen)
**Date**: 2026-09-21
**Status**: Decided — the ticket's instruction is wrong and this records why
**Evidence**: the failure reproduced from the screen, then from a shell, then read
in `cli/commands/install.js` in the shipped CLI

---

## What the ticket says

"Install is `codemie install [agent] --supported` … Do not pass an explicit version to
`codemie install`. Only `--supported`."

## What happens

Installing Claude Code ACP from the screen failed. The same command in a shell:

```
$ codemie install claude-acp --supported
- Installing Claude Code ACP v2.1.269 (supported version)...
✖ Failed to install Claude Code ACP
✗ Failed to install agent claude-acp: No installer URLs configured for native installation
```

Without the flag it succeeds:

```
$ codemie install claude-acp
✓ @zed-industries/claude-code-acp installed successfully
```

`install.js` explains it. With `--supported` the CLI sets the version to `supported` and
resolves it through `checkVersionCompatibility()`, which is the native-installer path. Only
the agents that carry installer URLs can take it; the eight that install through npm cannot,
and they fail exactly as above. Note the resolved version in the failure, `v2.1.269`: that is
Claude Code's number, reached for a different agent.

Without the flag the CLI applies its own default, and its comment states the order:
`--supported flag > version argument > 'supported' (default for Claude) > undefined`. The
third branch fires for `claude` and `codex`, "agents whose backend compatibility is
version-sensitive", which is precisely where the supported version matters.

## Decision

**Install runs `codemie install <agent>`, with no flag and no version.**

- It reaches the supported version for the agents the CLI treats as version-sensitive,
  which is what the ticket's instruction was trying to guarantee.
- It passes no explicit version, which is the constraint the ticket actually imposes and
  the parent story's Out of Scope requires.
- It is the only form that works for the npm-installed agents, which are eight of the
  eleven the screen lists.

Keeping the flag would have left the Install button broken for most of the list, which no
test would have caught: the failure is in the CLI's behaviour, not in ours.
