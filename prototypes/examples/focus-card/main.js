// Original example. Uses the public Echo package contract; no Echo source copied.
export function apply(ctx) {
  ctx.widgets.provide('focus', () => ({
    title: 'Make room to think',
    text: 'Choose one useful thing. Give it your attention.'
  }));
}
