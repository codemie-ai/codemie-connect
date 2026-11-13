// Parses `codemie list` stdout into agent records. Pure: no DOM, no Tauri, so
// Home (EPMCDME-14589) and the Agents screen (EPMCDME-14514) import the same
// function and node:test loads it as is.
//
// The CLI prints three blocks (see ui/test/fixtures/agents/list.txt, a real
// capture): "📦 Available Agents:", "🛠️  Available Frameworks:", then a rule and
// "Next Steps:". Only the first block is read. An agent record is four lines:
//
//   Claude Code (2.1.269)                <- name, version only when installed
//     Command: claude
//     Status: ✓ installed                <- or "Status: not installed", no glyph
//     Claude Code - official Anthropic CLI tool
//
// Through a pipe chalk disables itself, so a capture has no escape codes.
const AGENTS_HEADING = /Available Agents:/;
const OTHER_HEADING = /Available Frameworks:|^\s*Next Steps:/;

// The name a user types in a terminal: the CLI installs its agents as
// codemie-<command>, except the built-in one that already carries the prefix.
function launcherOf(command) {
  return command.startsWith('codemie-') ? command : `codemie-${command}`;
}

export function parseAgentList(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const agents = [];
  let inAgents = false;
  let current = null;

  for (const line of lines) {
    if (!inAgents) {
      if (AGENTS_HEADING.test(line)) inAgents = true;
      continue;
    }
    if (OTHER_HEADING.test(line)) break;

    const field = line.match(/^\s{4}(\S.*)$/);
    const head = line.match(/^\s{2}(\S.*)$/);
    if (field && current) {
      const text = field[1].trim();
      if (text.startsWith('Command:')) current.command = text.slice('Command:'.length).trim();
      else if (text.startsWith('Status:')) current.installed = /installed/.test(text) && !/not installed/.test(text);
      else if (!current.description) current.description = text;
      continue;
    }
    if (head) {
      const m = head[1].match(/^(.*?)(?:\s+\(([^)]+)\))?\s*$/);
      current = { name: m[1], command: '', installed: false, version: m[2] || null, description: '' };
      agents.push(current);
      continue;
    }
    if (!line.trim()) current = null;
  }
  for (const a of agents) a.launcher = launcherOf(a.command);
  return agents;
}
