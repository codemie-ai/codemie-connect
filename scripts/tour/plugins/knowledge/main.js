// The real-app tour's offline stand-in for the Knowledge plugin: the same role, requires and
// `uses` as the real manifest (no settings), so Settings › Plugins lists Knowledge and the boot
// sees a reply-context provider installed. It registers nothing: the tour's voice provider is the
// test double the quiet Core sets first, and nothing here reads a folder or runs Claude.
export function apply() {}
