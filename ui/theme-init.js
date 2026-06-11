// CodeMie theme bootstrap.
// Loaded as a CLASSIC, render-blocking <script src> in <head> (NOT type=module, NOT defer)
// so the <html> theme class is set before first paint — no flash of the wrong theme.
// CSP note: must be an external 'self' script; inline scripts are blocked by `script-src 'self'`.
(function () {
  var KEY = 'cm-theme';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function apply(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.className = t;
    try {
      localStorage.setItem(KEY, t);
    } catch (e) {
      /* storage unavailable — theme still applies for this session */
    }
    return t;
  }

  // Pre-paint: set the class immediately from storage (documentElement exists in <head>).
  apply(read());
  window.__cmTheme = { get: read, set: apply };

  // Wire the toggle once the DOM is ready. Convention: checked = dark.
  function wire() {
    var input = document.getElementById('theme-toggle-input');
    if (!input) return;
    input.checked = read() === 'dark';
    input.addEventListener('change', function () {
      apply(input.checked ? 'dark' : 'light');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
