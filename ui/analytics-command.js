// The command behind "CLI usage analytics". The CLI changed how it writes the
// HTML report: 0.15.2 takes --report and --report-output (its --export only
// does json or csv), 0.15.4 and later write html with --export [format] and -o,
// and from 0.15.5 still accept --report but warn it goes away (EPMCDME-15390).
// `codemie analytics --help` says which one is installed.
//
// The output path is set explicitly: a Finder-launched bundle's CWD is "/",
// which is not writable. $HOME is expanded by the pty's login shell.
const OUTPUT = '"$HOME/codemie-analytics.html"';

export function analyticsCommand(helpText) {
  const help = String(helpText || '');
  const exportsHtml = /--export \[format\]/.test(help);
  return /--report\b/.test(help) && !exportsHtml
    ? `codemie analytics --report --open --report-output ${OUTPUT}`
    : `codemie analytics --export html --open -o ${OUTPUT}`;
}
