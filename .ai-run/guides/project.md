# Project Context

## Project Identity

| Field | Value | Source |
|---|---|---|
| Project name | CodeMie Installer (macOS) | `README.md:1` |
| Repository/package | codemie-installer-macos-tauri | `package.json:2` |
| Project code/key | EPM-CDME | `git remote -v` — `epm-cdme/codemie-claude-installer-macos.git` |

## Work Item Tracker

| Field | Value |
|---|---|
| Provider | Jira |
| Key/prefix | EPM-CDME |

> Adapter configuration belongs exclusively in `## Ticket Adapter`. Do not duplicate adapter status or instructions in the Work Item Tracker table.

## Ticket Adapter

**Status**: configured
**Adapter**: Invoke the `codemie-jira-assistant` skill via the Skill tool.
**Lookup**: Invoke the `codemie-jira-assistant` skill with the ticket key and a request for summary, description, acceptance criteria, and links.
**Create**: Invoke the `codemie-jira-assistant` skill with the complete ticket payload or approved story file as the argument.
**Output**: Ticket key and URL returned by the skill.

## Source Control And Review

| Field | Value |
|---|---|
| Provider | GitLab |
| Repository remote | https://gitbud.epam.com/epm-cdme/codemie-claude-installer-macos.git |
| Default target branch | main |
| Review artifact type | MR |

## MR Adapter

**Status**: configured
**Adapter**: glab
**Instructions**: glab is installed at `%LOCALAPPDATA%\Programs\glab\glab.exe` (not on PATH). Invoke as `"$LOCALAPPDATA/Programs/glab/glab.exe"` from Bash or `"$env:LOCALAPPDATA\Programs\glab\glab.exe"` from PowerShell. Authenticated to `gitbud.epam.com` via keyring. Default target branch is `codemie-desktop`.

## Lifecycle Intent Handling

### record_complexity_score
Invoke the `codemie-jira-assistant` skill and ask it to update the ticket's complexity score (Total Score) with the value from `data.complexity_total`.
Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.

### artifact_published
Invoke the `codemie-jira-assistant` skill and attach the artifact file using the `--file` flag:

```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" \
  "Attach this file to Jira ticket EPMCDME-<ID> as the approved <kind> artifact." \
  --file "<path-to-artifact>"
```

Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.
`<path-to-artifact>`: use `data.artifact_path`, or the path to `spec.md` / `plan.md` in the run directory.
