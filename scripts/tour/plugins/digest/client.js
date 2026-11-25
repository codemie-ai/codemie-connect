// A real-app tour fixture's client half: minutes for the meeting the Meetings page shows (Echo's
// `call.minutes` slot), so a pinned plugin tab has text to show. Invented text only.
export function apply(ctx) {
  ctx.slots.add('call.minutes', {
    render: call => `<h2>Digest</h2><p>${ctx.ui.esc(call?.name || 'This meeting')}: three decisions and two follow-ups.</p>`,
  });
}
