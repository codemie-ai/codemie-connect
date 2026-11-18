# Project Context

## Project Identity

| Field | Value | Source |
|---|---|---|
| Project name | CodeMie Connect | src-tauri/tauri.conf.json::productName |
| Repository/package | codemie-connect | README.md::codemie-connect |
| Project code/key | EPMCDME | src-tauri/src/lib.rs::EPMCDME |

## Work Item Tracker

| Field | Value |
|---|---|
| Provider | Jira |
| Key/prefix | EPMCDME |

> Adapter configuration belongs exclusively in `## Ticket Adapter`. Do not duplicate adapter status or instructions in the Work Item Tracker table.

## Ticket Adapter

**Status**: configured
**Adapter**: Invoke the `codemie-jira-assistant` skill via the Skill tool.
**Lookup**: Invoke the `codemie-jira-assistant` skill with the ticket key and a request for summary, description, acceptance criteria, and links.
**Create**: Invoke the `codemie-jira-assistant` skill with the complete ticket payload or approved story file as the argument.
**Output**: Ticket key (`EPMCDME-<number>`) and URL returned by the skill.
**Comment**: Invoke the `codemie-jira-assistant` skill with a request to add a comment to the ticket, passing the comment body as the argument.
**Attach**: Invoke the `codemie-jira-assistant` skill with a request to attach the file at {{FILE_PATH}} to ticket {{ID}} under the name `sdlc-<kind>-<filename>`.

## Source Control And Review

| Field | Value |
|---|---|
| Provider | GitHub |
| Repository remote | https://github.com/codemie-ai/codemie-connect |
| Default target branch | main |
| Review artifact type | PR |

## MR Adapter

**Status**: configured
**Adapter**: gh
**Instructions**: Use the GitHub CLI: `gh pr create --repo codemie-ai/codemie-connect --base main`. A branch for the workspace milestone targets `workspace-app` instead of `main`.

## Complexity Scoring

**Status**: configured
**Field**: Total Score
**Format**: numeric

## Lifecycle Intent Handling

### record_complexity_score
Invoke the `codemie-jira-assistant` skill and ask it to update the ticket's complexity score (Total Score) with the value from `data.complexity_total`.
Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.

### artifact_published
Invoke the `codemie-jira-assistant` skill with a request to attach the artifact file at `<path-to-artifact>` to ticket `EPMCDME-<ID>` as the approved `<kind>` artifact.

Ticket ID: extract from the current branch name (pattern `EPMCDME-\d+`) or from the run work item.
`<path-to-artifact>`: use `data.artifact_path`, or the path to `spec.md` / `plan.md` in the run directory.
