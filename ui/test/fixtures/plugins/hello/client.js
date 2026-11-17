// The synthetic test plugin's client half: a page that calls its host half, a Settings section,
// its card in Settings → Plugins, a palette entry and a page widget. Every text goes through esc.
export function apply(ctx) {
  const { esc, setRow, setCard, sw } = ctx.ui;
  let greeting = '';
  let error = '';
  let loud = false;
  let clicks = 0;
  const greet = async () => {
    try {
      const r = await ctx.call('greet', { name: 'Taylor <b>' });
      greeting = r.text;
      error = '';
    } catch (e) {
      error = e.message;
    }
    ctx.render();
  };
  ctx.ui.style('.hello-page h1 { letter-spacing: .01em } .hello-out { margin-top: 12px }');
  ctx.activities.add({
    id: 'home',
    label: 'Hello',
    render() {
      const route = ctx.where().route;
      return `<div class="hello-page"><h1>Hello page</h1>
        <p class="set-sub">Route: <code>${esc(route || '(none)')}</code> · Host: ${esc(ctx.host.name)}</p>
        <p><button class="btn primary" data-hello-greet>Say hello</button> <button class="btn" data-hello-settings>Open its settings</button></p>
        <p class="set-sub"><a data-ext data-hello-link href="https://example.com/hello?from=connect&amp;x=1">Open example.com ↗</a> · <a data-hello-http href="http://example.com/insecure">An insecure link</a></p>
        <div class="hello-out" id="hello-out">${greeting ? `<p class="set-ok">${esc(greeting)}</p>` : ''}${error ? `<p class="error">${esc(error)}</p>` : ''}</div>
        <p class="set-sub">Clicks: <span id="hello-clicks">${clicks}</span></p></div>`;
    },
  });
  ctx.settings.section({
    id: 'main',
    label: 'Hello',
    badge: () => (loud ? '!' : ''),
    render() {
      return `<div class="sch"><h2>Hello settings</h2>
        ${setCard('Greeting', [
          setRow('Say it loudly', 'Adds a mark to the section in the sidebar.', sw('loud', loud, 'Say it loudly')),
          setRow('Greet from here', esc(greeting || 'Not greeted yet'), '<button class="btn" data-hello-greet>Say hello</button>'),
        ])}</div>`;
    },
  });
  ctx.settings.add({ render: () => setCard('', [setRow('Hello', 'Its page says hello through its host half.', '<button class="btn" data-hello-open>Open Hello</button>')]) });
  ctx.palette.add({ label: 'Hello: open', keywords: 'hello greet', run: () => ctx.go('hello:home') });
  ctx.widgets.draw('board', ({ data }) => `<p>${esc((data && data.text) || 'Nothing yet')}</p>`);
  ctx.listen('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    clicks += 1;
    if ('helloGreet' in el.dataset) greet();
    else if ('helloSettings' in el.dataset) ctx.go('settings/hello:main');
    else if ('helloOpen' in el.dataset) ctx.go('hello:home/from-card');
    else if (el.dataset.set === 'loud') { loud = el.dataset.val === 'true'; }
    ctx.render();
  });
  ctx.onUnload(() => { greeting = ''; });
}
