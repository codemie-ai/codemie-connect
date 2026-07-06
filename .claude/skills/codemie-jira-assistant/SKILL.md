---
name: codemie-jira-assistant
description: Business Analyst Assistant - expert to work with Jira. Used for creating/getting/managing Jira tickets in EPM-CDME project (Epics, Stories, Tasks, and Bugs). Main role is to analyze requirements from the request, clarify additional questions if necessary, generate requirements with the description structure defined in the prompt and additional details from the request, and create tickets in EPM-CDME project Jira. The Assistant uses Generic Jira tool for Jira tickets creation.
---

# CodeMie JIRA Assistant

Business Analyst Assistant - expert to work with Jira. Used for creating/getting/managing Jira tickets in EPM-CDME project (Epics, Stories, Tasks, and Bugs). Main role is to analyze requirements from the request, clarify additional questions if necessary, generate requirements with the description structure defined in the prompt and additional details from the request, and create tickets in EPM-CDME project Jira. The Assistant uses Generic Jira tool for Jira tickets creation.

## Instructions

1. **Mint a workflow id once at the start of every task that calls this assistant.** Reuse it for every invocation in that task. Suggested patterns:
   - From a shell: `workflow_id="codemie-jira-assistant-$(date +%Y%m%d-%H%M%S)-$$"`
   - From an LLM caller: include the related ticket key (e.g. `codemie-jira-assistant-EPMCDME-12345`) or a fresh UUID.
2. **Pass it as `--conversation-id` on every call** so the assistant has a clean, per-task server-side context. Do not rely on the implicit `CODEMIE_SESSION_ID` env-var fallback — that id is shared across every assistant invocation in your Claude session and causes cross-topic context bleed.
3. **For state-changing operations (create / update / delete) put the full final payload in one message.** Do not split the work into a "draft" turn followed by a "confirm and apply" turn — if server-side context is lost between turns, the confirmation message itself can be persisted as the resource content.
4. **After any write, re-fetch the resource and verify the written content matches what you sent.** If it does not match, the call was lost — resend in single-shot form with the full payload.

**File attachments are automatically detected** - any images or documents uploaded in recent messages are automatically included with the request.

**ARGUMENTS**: "message"

**Command format:**
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" --conversation-id "<workflow-id>" "message"
```

## Examples

**Simple message:**
```bash
workflow_id="codemie-jira-assistant-$(date +%Y%m%d-%H%M%S)-$$"
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" --conversation-id "$workflow_id" "help me with this"
```

**With file attachment** (reuse the same workflow id):
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" --conversation-id "$workflow_id" "analyze this code" --file "script.py"
```

**With multiple files** (reuse the same workflow id):
```bash
codemie assistants chat "289d2751-afd9-4c77-a272-90df7cd71702" --conversation-id "$workflow_id" "review these files" --file "file1.png" --file "file2.py"
```