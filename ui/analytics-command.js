// The command behind "CLI usage analytics". The CLI changed how it writes the
// HTML report: the one bundled with the app (0.15.2) takes --report and
// --report-output, later ones only --export and -o, and reject --report
// (EPMCDME-15390). `codemie analytics --help` says which one is installed.
//
// The output path is set explicitly: a Finder-launched bundle's CWD is "/",
// which is not writable. $HOME is expanded by the pty's login shell.
const OUTPUT = '"$HOME/codemie-analytics.html"';

export function analyticsCommand(helpText) {
  return /--report\b/.test(String(helpText || ''))
    ? `codemie analytics --report --open --report-output ${OUTPUT}`
    : `codemie analytics --export html --open -o ${OUTPUT}`;
}
