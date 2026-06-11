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
**Adapter**: Invoke the `brianna` skill via the Skill tool.
**Lookup**: Invoke the `brianna` skill with the ticket key and a request for summary, description, acceptance criteria, and links.
**Create**: Invoke the `brianna` skill with the complete ticket payload or approved story file as the argument.
**Output**: Ticket key and URL returned by the skill.

## Source Control And Review

| Field | Value |
|---|---|
| Provider | GitLab |
| Repository remote | https://gitbud.epam.com/epm-cdme/codemie-claude-installer-macos.git |
| Default target branch | main |
| Review artifact type | MR |

## MR Adapter

**Status**: not configured
**Adapter**: not configured
**Instructions**: not configured
