# Installing agents needs npm, and what that actually costs

**Ticket**: EPMCDME-14514 (Agents screen)
**Date**: 2026-09-21
**Status**: Open question, evidence settled — the shape is verified, where it lands is not
**Evidence**: the shipped CLI in the bundle,
`Contents/Resources/cli/node_modules/@codemieai/code/dist`, plus the clean-VM measurements
already recorded on the ticket

---

## What was already known

Measured on a clean macOS VM with no system Node: `codemie install` and `codemie uninstall`
shell out to a bare `npm` resolved from PATH, and the bundle ships only the `node` binary.
Eight of the ten agents install through npm, and *every* uninstall does, so on a clean
machine this screen could install two agents and remove none. Adding npm naively does not
fix it either: npm derives its global prefix from where node lives, which inside the app is
a read-only, signed directory.

## What this ticket added, by reading the CLI rather than guessing

- **Our environment does reach npm.** `utils/processes.js` builds its exec options as
  `{ cwd: options.cwd, env: options.env, ... }`, and `agents/core/BaseAgentAdapter.js` calls
  `npm.installGlobal(pkg)` and `npm.uninstallGlobal(pkg)` with no options at all. `env` is
  therefore `undefined`, and a child spawned that way inherits the parent's environment. An
  `npm_config_prefix` we set when spawning the CLI is inherited all the way down to npm.
  This was the ticket's main open question and the answer is yes.
- **PATH decides what counts as installed.** `isInstalled()` is `commandExists(cliCommand)`,
  a plain `which`. An agent installed into a prefix that is not on PATH is invisible to
  `codemie list`, so the screen would show it as still not installed. The prefix's `bin`
  has to be on PATH in two places: the environment the app spawns the CLI in, and the
  user's own shell, because running an agent is a terminal job by design.

## The shape that follows

1. Stage npm from the Node tarball already pinned in `runtime.json` (22.23.2), alongside the
   `node` binary the staging scripts place today, on macOS and Windows both.
2. Spawn the CLI with `npm_config_prefix` pointing at a writable directory, `~/.codemie/agents`,
   and that directory's `bin` prepended to PATH.
3. Add the same `bin` to the PATH line the installer already writes to the user's shell
   profile, so an installed agent is runnable where the user runs it.

`bin/npm` in the tarball is a relative symlink into `lib/node_modules/npm/bin/npm-cli.js`,
and whether Tauri's bundler preserves it is still unverified — writing our own two-line shim
that execs the bundled node against `npm-cli.js` avoids the question entirely.

## Why this is not folded into this MR

It is roughly 10 MB and 2466 files added to a signed bundle, a change to the runtime staging
scripts on both platforms, and a change to the PATH line the installer writes. That reaches
into three other tickets' territory: EPMCDME-14571 owns runtime staging, EPMCDME-14505 sets
the "never prompt for an admin credential" rule the writable prefix exists to respect, and
EPMCDME-14508 and EPMCDME-14899 have to sign whatever the bundle gains. Carrying it inside
the Agents screen's MR would make that MR unreviewable.

The Agents screen's actions work today on any machine that has npm, which is every
development machine. The clean-machine case is what this piece buys, and it should land
before the group branch reaches `main`.

**Open for Mert**: whether this becomes its own ticket or is folded into EPMCDME-14571,
which already owns the runtime staging scripts.
