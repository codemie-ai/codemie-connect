// Parses `codemie update --check` stdout into per-agent update-availability
// records. Pure: no DOM, no Tauri, mirrors ui/agents-parse.js's heading/stop-
// heading shape so it loads the same way in tests and in the controller.
//
// The CLI prints (see ui/test/fixtures/agents/update-check.txt, a real
// capture; the update-available case is synthetic per
// ui/test/fixtures/agents/update-check-available.txt's own header):
//
//   📦 Agent Update Status:
//
//     CodeMie Code
//       Current: 0.15.2
//       Latest:  0.15.2 (up to date)
//
//   ✓ All agents are up to date!         <- or "N update(s) available" + a tip
//
// Only the block between the heading and the trailing summary line is read.
const HEADING = /Agent Update Status:/;
const SUMMARY = /update\(s\) available|All agents are up to date/;

export function parseUpdateStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let current = null;

  for (const line of lines) {
    if (!inBlock) {
      if (HEADING.test(line)) inBlock = true;
      continue;
    }
    if (SUMMARY.test(line)) break;

    const name = line.match(/^\s{2}(\S.*)$/);
    const latest = line.match(/^\s{4}Latest:\s+.*\(update available\)/);
    if (name) {
      current = { displayName: name[1].trim(), updateAvailable: false };
      out.push(current);
      continue;
    }
    if (latest && current) current.updateAvailable = true;
  }
  return out;
}
