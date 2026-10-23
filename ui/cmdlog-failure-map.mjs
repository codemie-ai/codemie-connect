export default function mapFailure({ exit_code, raw_output }) {
  if (exit_code === null) return '';
  if (exit_code === 0) return '';
  if (raw_output.trim() === '')
    return `Command exited with code ${exit_code} and produced no output.`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network error/i.test(raw_output))
    return 'A network error occurred. Check your internet connection.';
  if (exit_code === 127 || /command not found|not found/i.test(raw_output))
    return 'Command not found. Check that the required tool is installed and on your PATH.';
  return raw_output;
}
