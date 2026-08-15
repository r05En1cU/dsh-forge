// PoC: Forge-like middleware on @deepseek-ai/cordis@4.0.1
// Verifies: order-independent interception, prototype patching vs instance Proxy,
// cleanup/rollback, multi-middleware chaining, graceful degradation, perf.
import { Context, Service } from '@deepseek-ai/cordis'
import assert from 'node:assert'

const kOriginal = Symbol.for('cordis.original')
const unwrap = (v) => v?.[kOriginal] ?? v

let passed = 0
function ok(name, cond) {
  assert(cond, `FAILED: ${name}`)
  passed++
  console.log(`  ✓ ${name}`)
}

// fresh official plugin per scenario — the service CLASS (and thus its
// prototype) must not leak patched state across scenarios
function makeOfficialChat() {
  class ChatService extends Service {
    constructor(ctx) { super(ctx, 'chat') }
    send(text) {
      // internal self-call — the key case instance-Proxy cannot intercept
      return this._processMessage(text)
    }
    _processMessage(text) {
      return `[official] ${text}`
    }
  }
  return {
    ChatService,
    plugin: { name: 'official-chat', apply(ctx) { new ChatService(ctx) } },
  }
}

// ---------- middleware factory (prototype patch, shimmer-style chain) ----------
function createForge({ service: serviceName, methods }) {
  // NOTE: must be iterable for cleanup — WeakMap is not iterable
  const patched = new Map() // proto -> Map<method, entry>

  function patchInstance(value, ctx) {
    const raw = unwrap(value)
    if (!raw) return false
    const proto = Object.getPrototypeOf(raw)
    if (typeof proto !== 'object' || proto === Object.prototype) return false
    let table = patched.get(proto)
    if (!table) patched.set(proto, (table = new Map()))
    for (const [method, eventName] of Object.entries(methods)) {
      if (table.has(method)) continue // idempotent: already patched by us
      const desc = Object.getOwnPropertyDescriptor(proto, method)
      if (!desc || typeof desc.value !== 'function') {
        ctx?.logger('forge').warn(`method "${method}" not found on ${serviceName} prototype, skipped (version drift?)`)
        continue
      }
      const orig = desc.value
      const state = { active: true, orig }
      const wrapper = function (...args) {
        if (!state.active) return orig.apply(this, args) // unloaded mid-chain: pass-through
        const ctx = this.ctx
        if (!ctx) return orig.apply(this, args)
        const event = { service: serviceName, method, args, result: undefined }
        ctx.bail(`${eventName}/before`, event) // mutable/cancellable pre-event
        event.result = orig.apply(this, event.args)
        ctx.emit(`${eventName}/after`, event)
        return event.result
      }
      Object.defineProperty(proto, method, { ...desc, value: wrapper })
      table.set(method, { wrapper, state, desc })
    }
    return true
  }

  return {
    name: 'forge-' + serviceName,
    // no inject: we must load regardless of whether the official service exists
    apply(ctx) {
      // case 1: official service already registered before us
      const existing = ctx.get(serviceName, false)
      if (existing) patchInstance(existing, ctx)
      // case 2: registered later — official hook, no load-order assumption
      ctx.on('internal/service', (name, value) => {
        if (name !== serviceName) return
        if (value) patchInstance(value, ctx) // (re)provided / fiber re-activated
      })
      // cleanup: restore prototype exactly, or go inert if someone wrapped above us
      ctx.effect(() => {
        return () => {
          for (const [proto, table] of patched) {
            for (const [method, entry] of table) {
              const current = Object.getOwnPropertyDescriptor(proto, method)
              if (current?.value === entry.wrapper) {
                Object.defineProperty(proto, method, entry.desc) // we are top: restore
              } else {
                entry.state.active = false // another middleware above us: pass-through
              }
            }
          }
        }
      }, 'forge-restore')
    },
  }
}

// ---------- scenario A: middleware loads BEFORE official plugin ----------
console.log('A. order independence (middleware first)')
{
  const { ChatService, plugin } = makeOfficialChat()
  const ctx = new Context()
  const events = []
  await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  ctx.on('official-chat/message/before', (e) => { events.push(['before', e.args[0]]); e.args[0] = e.args[0].toUpperCase() })
  ctx.on('official-chat/message/after', (e) => events.push(['after', e.result]))
  await ctx.plugin(plugin) // official loads AFTER middleware
  const chat = ctx.get('chat')
  ok('service registered after middleware', !!chat)
  const out = chat.send('hello')
  ok('internal self-call intercepted & mutated by listener', out === '[official] HELLO')
  ok('before/after events fired', events.length === 2 && events[0][0] === 'before' && events[1][0] === 'after')
  ok('instanceof preserved', unwrap(chat) instanceof ChatService)
  ok('name metadata preserved', unwrap(chat).name === 'chat')
}

// ---------- scenario B: official loads BEFORE middleware (catch-up) ----------
console.log('B. catch-up (official first)')
{
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const events = []
  await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  ctx.on('official-chat/message/after', (e) => events.push(e.result))
  ctx.get('chat').send('world')
  ok('already-registered service patched via ctx.get(name, false)', events.length === 1)
}

// ---------- scenario C: unload restores original behavior ----------
console.log('C. cleanup / rollback')
{
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const proto = Object.getPrototypeOf(unwrap(ctx.get('chat', false)))
  const beforeDesc = Object.getOwnPropertyDescriptor(proto, '_processMessage')
  const fiber = await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  let fired = 0
  ctx.on('official-chat/message/after', () => fired++)
  ctx.get('chat').send('x')
  ok('events fire while loaded', fired === 1)
  await fiber.dispose()
  const afterDesc = Object.getOwnPropertyDescriptor(proto, '_processMessage')
  ok('prototype descriptor restored identically', afterDesc.value === beforeDesc.value && afterDesc.writable === beforeDesc.writable)
  ctx.get('chat').send('y')
  ok('no events after unload', fired === 1)
  ok('service still functional after unload', ctx.get('chat').send('y') === '[official] y')
}

// ---------- scenario D: two middlewares, unload out of order ----------
console.log('D. multi-middleware chaining')
{
  const { ChatService, plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const log = []
  const f1 = await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'mw1/message' } }))
  const f2 = await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'mw2/message' } }))
  ctx.on('mw1/message/after', () => log.push('mw1'))
  ctx.on('mw2/message/after', () => log.push('mw2'))
  ctx.get('chat').send('a')
  ok('both middlewares fire (chain)', log.join(',') === 'mw1,mw2')
  await f1.dispose() // unload the LOWER layer first — the tricky case
  log.length = 0
  ctx.get('chat').send('b')
  ok('upper middleware still works after lower unloaded', log.join(',') === 'mw2')
  ok('call still correct', ctx.get('chat').send('b') === '[official] b')
  await f2.dispose()
  const proto = Object.getPrototypeOf(unwrap(ctx.get('chat', false)))
  ok('fully restored to official implementation',
    proto._processMessage === ChatService.prototype._processMessage)
}

// ---------- scenario E: graceful degradation on version drift ----------
console.log('E. version drift (method renamed upstream)')
{
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const warnings = []
  // Logger methods are per-instance own props built by this._method() — hook that
  const loggerProto = Object.getPrototypeOf(ctx.logger('forge'))
  const origMethod = loggerProto._method
  loggerProto._method = function (type, ...rest) {
    const fn = origMethod.call(this, type, ...rest)
    if (type !== 'warn') return fn
    return (...a) => { warnings.push(a.join(' ')); return fn(...a) }
  }
  await ctx.plugin(createForge({ service: 'chat', methods: { _processMessageV2: 'official-chat/message' } }))
  loggerProto._method = origMethod
  ok('missing method skipped with warning, no crash', warnings.length === 1)
  ok('service unaffected', ctx.get('chat').send('z') === '[official] z')
}

// ---------- scenario F: instance-Proxy limitation (why prototype wins) ----------
console.log('F. instance Proxy cannot intercept internal self-calls')
{
  const { ChatService, plugin } = makeOfficialChat()
  const ctx = new Context()
  let rawService
  await ctx.plugin({
    name: 'official-chat',
    apply(ctx) {
      rawService = new ChatService(ctx)
    },
  })
  let proxiedCalls = 0
  // wrap what CONSUMERS see via the official internal/get waterfall.
  // NOTE 1: signature is (ctx, name, error, next) — all positional.
  // NOTE 2: the waterfall only fires on property-style access (ctx.chat) from a
  // plugin fiber that declared inject; root ctx and ctx.get() bypass it entirely.
  ctx.on('internal/get', (c, name, error, next) => {
    const value = next()
    if (name !== 'chat' || !value) return value
    return new Proxy(value, {
      get: (t, p, r) => {
        if (p === '_processMessage') proxiedCalls++
        return Reflect.get(t, p, r)
      },
    })
  })
  let consumer
  await ctx.plugin({ name: 'consumer', inject: ['chat'], apply(c) { consumer = c } })
  const chat = consumer.chat
  chat._processMessage('direct') // external call through proxy
  ok('external call via proxy intercepted', proxiedCalls === 1)
  // truly internal trigger: official code calling through its own raw `this`
  // (e.g. a timer/callback inside the plugin) — never touches any proxy
  rawService.send('from-inside')
  ok('internal self-call NOT intercepted by instance Proxy', proxiedCalls === 1)
}

// ---------- scenario G: official plugin hot-restart ----------
console.log('G. official fiber restart (no double patch)')
{
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin)
  let fired = 0
  await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  ctx.on('official-chat/message/after', () => fired++)
  await fiber.restart() // service disposed & re-provided -> internal/service fires again
  ctx.get('chat').send('r')
  ok('exactly one after-event per call after restart (no double wrap)', fired === 1)
}

// ---------- scenario G2: prototype patch is process-global across roots ----------
console.log('G2. patch leaks across Context roots (caveat demo)')
{
  const { plugin } = makeOfficialChat() // one shared class, two root contexts
  const ctx1 = new Context()
  const ctx2 = new Context()
  await ctx1.plugin(plugin)
  await ctx2.plugin(plugin)
  await ctx1.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  let fired1 = 0, fired2 = 0
  ctx1.on('official-chat/message/after', () => fired1++)
  ctx2.on('official-chat/message/after', () => fired2++)
  ctx1.get('chat').send('a') // wrapper emits on the SERVICE's own ctx (ctx1 fiber)
  ok('call in ctx1 fires ctx1 listeners', fired1 === 1)
  ctx2.get('chat').send('b') // prototype shared, but event goes to ctx2
  ok('call in ctx2 fires ctx2 listeners (event routed by service ctx)', fired2 === 1 && fired1 === 1)
}

// ---------- scenario H: performance ----------
console.log('H. performance (1e6 calls)')
{
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const raw = ctx.get('chat')
  const N = 1e6
  let t0 = performance.now()
  for (let i = 0; i < N; i++) raw.send('perf')
  const base = performance.now() - t0
  await ctx.plugin(createForge({ service: 'chat', methods: { _processMessage: 'official-chat/message' } }))
  t0 = performance.now()
  for (let i = 0; i < N; i++) raw.send('perf')
  const patched0 = performance.now() - t0
  ctx.on('official-chat/message/before', () => {})
  ctx.on('official-chat/message/after', () => {})
  t0 = performance.now()
  for (let i = 0; i < N; i++) raw.send('perf')
  const patched2 = performance.now() - t0
  console.log(`  raw: ${((base / N) * 1e6).toFixed(0)}ns/call, patched(no listener): ${((patched0 / N) * 1e6).toFixed(0)}ns, patched(2 listeners): ${((patched2 / N) * 1e6).toFixed(0)}ns`)
  ok('overhead within 20x of raw (sanity)', patched2 < base * 20 + 1000)
}

console.log(`\nAll ${passed} assertions passed.`)
