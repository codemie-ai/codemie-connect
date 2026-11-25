// The real-app tour's offline stand-in for the Todoist plugin: the same manifest shape (tasks
// role, token, Project and App label settings), so Settings › Plugins and Settings › Tasks draw
// the real Todoist card, and the boot sees Todoist installed. It registers nothing: the tour's
// task provider is the test double the quiet Core sets first, and nothing here reaches the network.
export function apply() {}
