// The `ctx` a plugin's host half (`main.js`) gets from `apply(ctx)` (PLUGIN-ENGINE.md §4), written
// for Connect from the published plugin API. Evaluated once per plugin runtime, before main.js.
//
// The script's value is a function the host calls with its bridge. Each bridge function answers
// in "wire" text and never throws: JSON text, or `!<code> <message>` when the host refused.
//   host(name, json)        a host service, answered now
//   hostAsync(name, json)   a host service answered later: a promise of wire text
//   every(seconds)          a host-owned timer's id
//   listen(event)           `true`, or a refusal for an event the plugin wasn't granted
//   answer(call, wire)      how a command, provider or apply(ctx) answers the host
//   report(text)            an error from the plugin's own code, for the app log
//   id                      the plugin's id
//   about                   Connect's `{name, version, engine}` (`ctx.host`), as JSON text
// It returns `{ dispatch, load, failure }`. Nothing is left on `globalThis`: plugin code reaches
// the host only through `ctx`, and the host names the plugin itself on every call.
;(bridge) => {
  'use strict'

  // Taken before main.js runs: the plugin may replace any global or prototype method later.
  const ErrorType = Error
  const TypeErrorType = TypeError
  const Str = String
  const Num = Number
  const P = Promise
  const WeakMapType = WeakMap
  const ProxyType = Proxy
  const TypeErrorProto = TypeError.prototype
  const { apply, get: reflectGet } = Reflect
  const { defineProperty, getPrototypeOf } = Object
  const hasOwn = (o, key) => apply(Object.prototype.hasOwnProperty, o, [key])
  const { parse, stringify } = JSON
  const unbind = (f) => (self, ...args) => apply(f, self, args)
  const then = unbind(P.prototype.then)
  const slice = unbind(Str.prototype.slice)
  const indexOf = unbind(Str.prototype.indexOf)
  const madeGet = unbind(WeakMapType.prototype.get)
  const madeSet = unbind(WeakMapType.prototype.set)

  // V8's stack hooks hand `prepareStackTrace` the functions on the stack, the bridge's among
  // them. Without the engine's accessor, assigning the property no longer installs a hook.
  delete ErrorType.prepareStackTrace
  delete ErrorType.captureStackTrace

  // Errors the host made, with their code and message: only these keep a code on the way out.
  const made = new WeakMapType()
  const hostError = (code, message) => {
    const e = new ErrorType(`${code}: ${message}`)
    defineProperty(e, 'code', { value: code, writable: true, configurable: true })
    madeSet(made, e, [code, message])
    return e
  }
  const fromWire = (wire) => {
    const space = indexOf(wire, ' ')
    return hostError(slice(wire, 1, space), slice(wire, space + 1))
  }
  const read = (wire) => {
    if (wire[0] === '!') throw fromWire(wire)
    return parse(wire)
  }

  // What only Echo has (PLUGIN-ENGINE.md §4.5 and §10), with the members each has there. `ctx`
  // leaves them out (rule 3: `undefined` to every presence test), but notes when the last member
  // a plugin touched was one of them (`touched`, `ctx.<name>`; any other member clears it). A
  // TypeError that follows from it, a property read from it or a call of it, is then told as what
  // it is: an Echo-only API used without a check, so the plugin needs a change to run here.
  const ECHO_ONLY = {
    __proto__: null,
    sessions: ['skills', 'read', 'channel', 'clearChannel'],
    view: ['hints'],
    agent: ['set'],
    scripts: ['run'],
    threads: ['get', 'set', 'list'],
    slots: ['list', 'add'],
    channel: [],
    knowledge: [],
  }
  const ECHO_ONLY_CLAUDE = { __proto__: null, hasPlugin: [], installPlugin: [] }
  let touched = ''
  const noting = (target, prefix, absent) =>
    new ProxyType(target, {
      get: (t, key, receiver) => {
        if (typeof key === 'string') touched = key in absent && !hasOwn(t, key) ? prefix + key : ''
        return reflectGet(t, key, receiver)
      },
    })
  // The Echo-only member to blame for a TypeError, or ''.
  const blame = (e, message) => {
    if (!touched || getPrototypeOf(e) !== TypeErrorProto) return ''
    if (indexOf(message, 'not a function') >= 0) return touched
    const members = indexOf(touched, 'ctx.claude.') === 0 ? null : ECHO_ONLY[slice(touched, 4)]
    if (!members || indexOf(message, 'of undefined') < 0) return ''
    if (members.length === 0) return touched
    for (let i = 0; i < members.length; i += 1) {
      if (indexOf(message, `'${members[i]}'`) >= 0) return touched
    }
    return ''
  }
  const about = Object.freeze(parse(bridge.about))
  const appName = typeof about.name === 'string' && about.name ? about.name : 'This app'

  // A thrown value as the host hears it, `[code, message]`: a host-made error keeps its code;
  // anything else is the plugin's own failure (code ''), described by a string `message`, unless
  // it came from an Echo-only API (`unsupported`). It runs in the plugin's own time, so a getter
  // that never returns is stopped with the turn.
  const describe = (e) => {
    try {
      const host = madeGet(made, e)
      if (host !== undefined) return host
      if (typeof e === 'string') return ['', e]
      if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
        const raw = e.message
        const message = typeof raw === 'string' ? raw : ''
        const echoOnly = blame(e, message)
        if (echoOnly) {
          const why = `${appName} doesn't have ${echoOnly} (only Echo has it), so this plugin needs a change to run here`
          return ['unsupported', message ? `${why}: ${message}` : why]
        }
        return ['', message]
      }
      return ['', e === undefined || e === null ? '' : Str(e)]
    } catch {
      return ['', '']
    }
  }
  const failure = (e) => {
    const d = describe(e)
    return `!${d[0]} ${d[1]}`
  }
  const report = (where, e) => {
    const d = describe(e)
    bridge.report(`${where}: ${d[1] || 'failed without a message'}`)
  }

  // Each service takes its arguments as one JSON array, in the order the plugin gave them.
  const direct = (name) => (...args) => read(bridge.host(name, stringify(args)))
  const deferred = (name) => (...args) => then(bridge.hostAsync(name, stringify(args)), read)
  const fn = (what, f) => {
    if (typeof f !== 'function') throw new TypeErrorType(`${what} needs a function`)
    return f
  }
  const text = (value) => {
    if (typeof value === 'string') return value
    try {
      return Str(value)
    } catch {
      return '[unprintable]'
    }
  }
  // A rejected promise already marked as looked at, so ignoring it isn't reported.
  const quietRejection = (e) => {
    const p = new P((_, reject) => reject(e))
    then(p, undefined, () => {})
    return p
  }

  const commands = new Map()
  const providers = new Map()
  const listeners = new Map()
  const timers = new Map()

  // Members Connect doesn't have are left out (PLUGIN-ENGINE.md rule 3): `sessions`,
  // `channel`, `agent`, `scripts`, `threads`, `view`, `slots`, `knowledge` and
  // `claude.hasPlugin/installPlugin` (`ECHO_ONLY`). Plugins test for them.
  const ctx = noting({
    id: bridge.id,
    host: about,
    terminal: false,
    log: (...parts) => direct('log')(parts.map(text).join(' ')),

    command: (name, f) => {
      commands.set(Str(name), fn('ctx.command', f))
    },
    every: (seconds, f) => {
      fn('ctx.every', f)
      timers.set(read(bridge.every(Num(seconds))), f)
    },
    on: (event, f) => {
      fn('ctx.on', f)
      const name = Str(event)
      const granted = bridge.listen(name)
      if (granted[0] === '!') {
        const e = fromWire(granted)
        report(`ctx.on(${name})`, e)
        return quietRejection(e)
      }
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(f)
      return P.resolve(true)
    },

    store: {
      read: direct('store.read'),
      write: direct('store.write'),
      list: direct('store.list'),
      remove: direct('store.remove'),
      path: direct('store.path'),
    },
    settings: { get: direct('settings.get'), set: direct('settings.set') },
    shared: { get: direct('shared.get'), set: direct('shared.set') },
    package: { read: direct('package.read'), list: direct('package.list') },
    fs: {
      folders: direct('fs.folders'),
      list: direct('fs.list'),
      read: direct('fs.read'),
      readMany: deferred('fs.readMany'),
      walk: deferred('fs.walk'),
      write: direct('fs.write'),
      move: direct('fs.move'),
      remove: direct('fs.remove'),
      forget: direct('fs.forget'),
    },
    system: { pickFolder: deferred('system.pickFolder'), which: direct('system.which') },
    http: { fetch: deferred('http.fetch') },
    claude: noting({ run: deferred('claude.run') }, 'ctx.claude.', ECHO_ONLY_CLAUDE),
    profiles: direct('profiles'),

    notify: direct('notify'),
    markdown: direct('markdown'),
    inbox: { set: direct('inbox.set'), clear: direct('inbox.clear') },
    widgets: {
      provide: (id, f) => {
        fn('ctx.widgets.provide', f)
        direct('widgets.provide')(id)
        providers.set(`widget:${id}`, f)
      },
      set: direct('widgets.set'),
      clear: direct('widgets.clear'),
      changed: direct('widgets.changed'),
    },
    work: {
      provide: (f) => {
        fn('ctx.work.provide', f)
        direct('work.provide')()
        providers.set('work', f)
      },
      changed: direct('work.changed'),
    },
    deliver: {
      send: deferred('deliver.send'),
      provide: (kind, way) => {
        const send = fn('ctx.deliver.provide', way && way.send)
        direct('deliver.provide')(kind, { label: way.label })
        providers.set(`deliver:${kind}`, (message) => apply(send, way, [message]))
      },
      ready: direct('deliver.ready'),
      status: direct('deliver.status'),
    },

    echo: { read: direct('echo.read'), dictionary: { add: direct('echo.dictionary.add') } },
    signin: {
      get: deferred('signin.get'),
      keep: direct('signin.keep'),
      forget: direct('signin.forget'),
      sources: direct('signin.sources'),
    },
  }, 'ctx.', ECHO_ONLY)

  // Runs `work()` and answers the host's call once its value (or promise) is known: the value
  // as JSON text, or the failure.
  const answerWith = (call, work) => {
    let answered = false
    const send = (wire) => {
      if (!answered) {
        answered = true
        bridge.answer(call, wire)
      }
    }
    const done = (value) => {
      let json
      try {
        json = stringify(value === undefined ? null : value)
      } catch (e) {
        return send(failure(e))
      }
      send(json === undefined ? 'null' : json)
    }
    const failed = (e) => send(failure(e))
    try {
      then(new P((resolve) => resolve(work())), done, failed)
    } catch (e) {
      failed(e)
    }
  }

  // Runs a listener or a timer on its own; its failures are reported.
  const runAlone = (where, f, args) => {
    try {
      then(new P((resolve) => resolve(f(args))), undefined, (e) => report(where, e))
    } catch (e) {
      report(where, e)
    }
  }

  // The host's way in: a command or provider answers through `bridge.answer(call, …)`; an
  // event or a timer tick runs on its own.
  const dispatch = (kind, name, json, call) => {
    touched = ''
    const args = json === undefined ? undefined : parse(json)
    if (kind === 'command' || kind === 'provider') {
      const target = (kind === 'command' ? commands : providers).get(name)
      if (!target) {
        const what = kind === 'command' ? 'no command' : 'nothing provides'
        bridge.answer(call, `!not_found ${what} “${name}”`)
        return
      }
      answerWith(call, () => target(args))
    } else if (kind === 'event') {
      for (const f of listeners.get(name) || []) runAlone(name, f, args)
    } else if (kind === 'timer' && timers.has(Num(name))) {
      runAlone('ctx.every', timers.get(Num(name)), args)
    }
  }

  // Runs `apply(ctx)` from main.js's exports and answers `call` when it has finished (it may
  // be async).
  const load = (exports, call) =>
    answerWith(call, () => {
      touched = ''
      if (typeof exports.apply !== 'function') {
        throw hostError('plugin_error', 'main.js doesn’t export apply(ctx)')
      }
      return then(new P((resolve) => resolve(exports.apply(ctx))), () => null)
    })

  return { dispatch, load, failure }
}
