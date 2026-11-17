// The `ctx` a plugin's host half (`main.js`) gets from `apply(ctx)` (DESIGN 7.2), written for
// Connect from the published plugin API. Evaluated once per plugin runtime, before main.js.
//
// The script's value is a function the host calls with its bridge:
//   host(name, json)      a host service, answered now: JSON text, or throws `<code>: <message>`
//   hostAsync(name, json) a host service answered later: a promise the host settles
//   every(seconds)        a host-owned timer's id; throws `limit` below the minimum
//   listen(event)         throws `permission` for an event the plugin wasn't granted
//   report(text)          an error from the plugin's own code, for the app log
//   id                    the plugin's id
// It returns `{ dispatch, load }`. Nothing is left on `globalThis`: plugin code reaches the
// host only through `ctx`, and the host names the plugin itself on every call.
;(bridge) => {
  'use strict'

  const commands = new Map()
  const providers = new Map()
  const listeners = new Map()
  const timers = new Map()

  const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })
  // A promise already marked as looked at: a plugin that never awaits it isn't reported.
  const refused = (error) => {
    const p = Promise.reject(error)
    p.catch(() => {})
    return p
  }
  const text = (value) => {
    if (typeof value === 'string') return value
    try {
      return String(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  const messageOf = (error) => (error && typeof error.message === 'string' ? error.message : text(error))
  const report = (where, error) => {
    try {
      bridge.report(`${where}: ${messageOf(error)}`)
    } catch {}
  }

  // Each service takes its arguments as one JSON array, in the order the plugin gave them.
  const call = (name) => (...args) => {
    const out = bridge.host(name, JSON.stringify(args))
    return out === undefined ? undefined : JSON.parse(out)
  }
  const later = (name) => (...args) => bridge.hostAsync(name, JSON.stringify(args))
  const fn = (what, f) => {
    if (typeof f !== 'function') throw new TypeError(`${what} needs a function`)
    return f
  }

  // Exists so plugins don't break on it, but isn't in Connect yet: every call rejects.
  const notYet = (name) => () => refused(fail('unsupported', `${name} is not available in CodeMie Connect yet`))
  const notYetNamespace = (ns) =>
    new Proxy(Object.create(null), {
      get: (_, key) => (typeof key === 'string' && key !== 'then' ? notYet(`${ns}.${key}`) : undefined),
      set: () => true,
    })

  const ctx = {
    id: bridge.id,
    log: (...parts) => call('log')(parts.map(text).join(' ')),

    command: (name, f) => {
      commands.set(String(name), fn('ctx.command', f))
    },
    every: (seconds, f) => {
      fn('ctx.every', f)
      timers.set(bridge.every(Number(seconds)), f)
    },
    on: (event, f) => {
      fn('ctx.on', f)
      const name = String(event)
      try {
        bridge.listen(name)
      } catch (e) {
        report(`ctx.on(${name})`, e)
        return refused(e)
      }
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(f)
      return Promise.resolve(true)
    },

    store: {
      read: call('store.read'),
      write: call('store.write'),
      list: call('store.list'),
      remove: call('store.remove'),
      path: call('store.path'),
    },
    settings: { get: call('settings.get'), set: call('settings.set') },
    package: { read: call('package.read'), list: call('package.list') },
    fs: {
      folders: call('fs.folders'),
      list: call('fs.list'),
      read: call('fs.read'),
      readMany: later('fs.readMany'),
      walk: later('fs.walk'),
      write: call('fs.write'),
      move: call('fs.move'),
      remove: call('fs.remove'),
      forget: call('fs.forget'),
    },
    system: { pickFolder: later('system.pickFolder'), which: call('system.which') },
    http: { fetch: later('http.fetch') },
    claude: {
      run: later('claude.run'),
      hasPlugin: notYet('claude.hasPlugin'),
      installPlugin: notYet('claude.installPlugin'),
    },
    profiles: call('profiles'),

    notify: call('notify'),
    markdown: call('markdown'),
    inbox: { set: call('inbox.set'), clear: call('inbox.clear') },
    widgets: {
      provide: (id, f) => {
        fn('ctx.widgets.provide', f)
        call('widgets.provide')(id)
        providers.set(`widget:${id}`, f)
      },
      set: call('widgets.set'),
      clear: call('widgets.clear'),
      changed: call('widgets.changed'),
    },
    work: {
      provide: (f) => {
        fn('ctx.work.provide', f)
        call('work.provide')()
        providers.set('work', f)
      },
      changed: call('work.changed'),
    },
    deliver: {
      send: later('deliver.send'),
      provide: (kind, way) => {
        const send = fn('ctx.deliver.provide', way && way.send)
        call('deliver.provide')(kind, { label: way.label })
        providers.set(`deliver:${kind}`, (message) => send.call(way, message))
      },
      ready: call('deliver.ready'),
      status: call('deliver.status'),
    },

    echo: { read: call('echo.read'), dictionary: { add: call('echo.dictionary.add') } },
    signin: {
      get: later('signin.get'),
      keep: call('signin.keep'),
      forget: call('signin.forget'),
      sources: call('signin.sources'),
    },

    sessions: notYetNamespace('sessions'),
    channel: notYetNamespace('channel'),
    agent: notYetNamespace('agent'),
    scripts: notYetNamespace('scripts'),
    // `slots`, `threads`, `view`, `terminal` and `knowledge` stay undefined: plugins
    // feature-detect them, and a missing `terminal` says this is a windowed host.
  }

  const answer = (value) => JSON.stringify(value === undefined ? null : value) ?? 'null'

  // The host's way in: a command or provider answers its caller (a promise of JSON text);
  // an event or a timer tick runs on its own, its failures reported.
  const dispatch = (kind, name, json) => {
    const args = json === undefined ? undefined : JSON.parse(json)
    if (kind === 'command' || kind === 'provider') {
      const target = (kind === 'command' ? commands : providers).get(name)
      if (!target) throw fail('not_found', `${kind === 'command' ? 'no command' : 'nothing provides'} “${name}”`)
      return Promise.resolve(target(args)).then(answer)
    }
    const run = (where, f) => {
      try {
        Promise.resolve(f(args)).catch((e) => report(where, e))
      } catch (e) {
        report(where, e)
      }
    }
    if (kind === 'event') for (const f of listeners.get(name) || []) run(name, f)
    else if (kind === 'timer' && timers.has(Number(name))) run('ctx.every', timers.get(Number(name)))
    return undefined
  }

  // Runs `apply(ctx)` from main.js's exports; the promise ends when it has (it may be async).
  const load = (exports) => {
    if (typeof exports.apply !== 'function') throw fail('plugin_error', 'the host half doesn’t export apply(ctx)')
    return Promise.resolve(exports.apply(ctx)).then(() => 'null')
  }

  return { dispatch, load }
}
