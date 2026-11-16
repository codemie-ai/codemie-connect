# Deferred from code review — 2026-09-29-EPMCDME-15342-about (2026-09-29)

- **App and CLI updates can run concurrently** — `ui/renderer.js:963` — `runUpdateApp` and `runUpdateCli` each guard only their own running flag, so an app update (which exits into the installer) can start while a CLI self-update is still replacing the CLI, and the reverse. Pre-existing: both functions and their banner entry points already lacked a cross-guard before this change; About only adds another button that calls the same unchanged guards.
