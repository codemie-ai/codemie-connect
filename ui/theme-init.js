// CodeMie theme bootstrap.
// Loaded as a CLASSIC, render-blocking <script src> in <head> (NOT type=module, NOT defer)
// so the <html> theme class is set before first paint — no flash of the wrong theme.
// CSP note: must be an external 'self' script; inline scripts are blocked by `script-src 'self'`.
(function () {
  var KEY = 'cm-theme';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply(theme) {
    var preference = ['light','dark','system'].includes(theme) ? theme : 'system';
    var t = preference === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
    document.documentElement.classList.remove('light','dark');
    document.documentElement.classList.add(t);
    try {
      localStorage.setItem(KEY, preference);
    } catch (e) {
      /* storage unavailable — theme still applies for this session */
    }
    return preference;
  }

  // Pre-paint: set the class immediately from storage (documentElement exists in <head>).
  apply(read());
  window.__cmTheme = { get: read, set: apply };

  // Wire the toggle once the DOM is ready. Convention: checked = dark.
  function wire() {
    var input = document.getElementById('theme-toggle-input');
    if (!input) return;
    input.checked = document.documentElement.classList.contains('dark');
    input.addEventListener('change', function () {
      var preference=apply(input.checked ? 'dark' : 'light');
      window.dispatchEvent(new CustomEvent('cm-theme-change',{detail:preference}));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
