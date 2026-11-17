// The synthetic test plugin's host half: one command for its page and a widget for Today.
export function apply(ctx) {
  ctx.command('greet', (args) => ({ text: `Hello, ${(args && args.name) || 'you'}`, from: ctx.host.name }));
  ctx.widgets.provide('greeting', () => ({ title: 'Hello', text: 'A card from the host half' }));
}
