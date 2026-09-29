# Which agent Home recommends, and why it is not our choice

**Ticket**: EPMCDME-15189 (onboarding polish)
**Date**: 2026-09-22
**Status**: Decided
**Evidence**: the shipped CLI's own setup command,
`Contents/Resources/cli/node_modules/@codemieai/code/dist/cli/commands/setup.js`

---

## The question

Item 3 now offers the agents in place, as option cards, the way guided setup offers models.
That control badges one card "Recommended". The CLI manages eleven agents and treats them
alike — `codemie list` marks none of them — so something has to decide which one carries the
badge, and a badge is a recommendation the user will act on.

## What the CLI itself says

`codemie setup` ends, after the profile name, by asking:

```
message: 'Would you like to install Claude Code now?'
```

That is the CLI's own suggestion to a user who has just set up a profile, in the CLI's own
words, on the same path this screen replaces. EPMCDME-14513 renders that question as guided
setup's seventh step for exactly this reason.

## Decision

**Claude Code carries the badge, because the CLI proposes it.** The picker sorts it first so
the selection the control opens on is the one the CLI would have offered, and a user who
wants another agent picks another card — nothing is hidden and nothing is preselected on our
own authority.

If the CLI ever marks a recommended agent in `codemie list`, that marking replaces this:
the rule is to follow the CLI, not to hold an opinion of our own about agents. The parent
story is explicit that the application is "a face on that contract rather than a second
installation route".
