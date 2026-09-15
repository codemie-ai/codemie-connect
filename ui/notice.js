// Notice modal -- a plain DOM module with no window.__TAURI__ dependency, so
// it is importable and testable headlessly. ui/renderer.js is the only
// production caller; ui/setup-view.js reaches it via deps-injection
// (EPMCDME-14588) rather than a static import, per its own header rule.
const noticeOverlay = document.getElementById('notice-overlay');
const noticeTitle = document.getElementById('notice-title');
const noticeMessage = document.getElementById('notice-message');
const noticePrimary = document.getElementById('notice-primary');
const noticeSecondary = document.getElementById('notice-secondary');
const noticeClose = document.getElementById('notice-close');

// `message` may be a string (sets textContent, the pre-EPMCDME-14588
// behavior) or a DOM Node (appended as a child, e.g. EPMCDME-14588's
// summary + raw-output body). secondaryLabel/secondaryAction are optional --
// omitting them keeps every existing single-action caller working unchanged.
export function showNotice({ title, message, primaryLabel, primaryAction, secondaryLabel, secondaryAction }) {
  noticeTitle.textContent = title;
  noticeMessage.replaceChildren();
  if (typeof message === 'string') {
    noticeMessage.textContent = message;
  } else {
    noticeMessage.textContent = '';
    if (message) noticeMessage.appendChild(message);
    // A raw command screen is read from the bottom: the failure is its last
    // line, while the top is the CLI's welcome banner. Only possible once the
    // node is in the document, so it happens here rather than in the caller.
    const raw = noticeMessage.querySelector?.('.notice-raw');
    if (raw) raw.scrollTop = raw.scrollHeight;
  }
  if (primaryLabel) {
    noticePrimary.textContent = primaryLabel;
    noticePrimary.classList.remove('hidden');
    noticePrimary.onclick = () => { hideNotice(); if (primaryAction) primaryAction(); };
  } else {
    noticePrimary.classList.add('hidden');
  }
  if (secondaryLabel) {
    noticeSecondary.textContent = secondaryLabel;
    noticeSecondary.classList.remove('hidden');
    noticeSecondary.onclick = () => { hideNotice(); if (secondaryAction) secondaryAction(); };
  } else {
    noticeSecondary.classList.add('hidden');
  }
  noticeOverlay.classList.remove('hidden');
}

export function hideNotice() {
  noticeOverlay.classList.add('hidden');
}

noticeClose.addEventListener('click', hideNotice);
