import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineMixin } from '../src/mixin.ts'
import {
  contractSuite,
  createNeoForge,
  defineCatalog,
  defineEventPoint,
  defineInjectionPoint,
  getNeoForgeStatus,
  kOptOut,
  type NeoForgeEvent,
} from '../src/index.ts'

// Typed event surface: catalogs ship this augmentation so downstream
// `ctx.on('official-chat/message', ...)` autocompletes and type-checks like an
// official API — no mixin concepts anywhere in the consumer experience.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: NeoForgeEvent): void
    'official-chat/message/before'(event: NeoForgeEvent): void
    'official-chat/fetch'(event: NeoForgeEvent): void
    'official-chat/helper/before'(event: NeoForgeEvent): void
    'official-chat/compute'(event: NeoForgeEvent): void
    'official-chat/compute/before'(event: NeoForgeEvent): void
    'official-chat/greet/before'(event: NeoForgeEvent): void
    'vendor-b/trace'(event: NeoForgeEvent): void
  }
}

// ---- fixture: a fake official plugin (fresh class per test — prototype patches
// are process-global per class, so tests must not share one) ----
function makeOfficialChat({ optOut = false, prefix = '[official]' } = {}) {
  class ChatService extends Service {
    constructor(ctx: any) { super(ctx, 'chat') }
    send(text: string) { return this._processMessage(text) }   // internal self-call
    _processMessage(text: string) { return `${prefix} ${text}` }
    async fetchRemote(id: number) { return await this._fetch(id) }
    async _fetch(id: number) { return `remote:${id}` }
  }
  if (optOut) (ChatService as any)[kOptOut] = true
  return {
    ChatService,
    plugin: { name: 'official-chat', apply(ctx: any) { new ChatService(ctx) } },
  }
}

const messagePoint = () => defineInjectionPoint({
  id: 'official-chat/message',
  tier: 2,
  runtime: { service: 'chat', method: '_processMessage' },
  requires: 'mutate',
})

const helperMixin = () => defineMixin({
  id: 'official-chat/helper',
  target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
  operation: 'before',
})

const helperPoint = () => defineInjectionPoint({
  id: 'official-chat/helper',
  tier: 3,
  mixin: helperMixin(),
  requires: 'mutate',
})

// ---------- first-class mixin declarations ----------

test('defineMixin validates and freezes runtime mixin declarations', () => {
  const mixin = defineMixin({
    id: 'official-chat/helper',
    target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
    operation: 'before',
  })
  assert.ok(Object.isFrozen(mixin))
  assert.throws(() => defineMixin({ id: 'bad id', target: { module: 'm', versionRange: '*', functionQuery: { functionName: 'f' } }, operation: 'before' }))
  assert.throws(() => defineMixin({ id: 'a/b', target: { module: 'm', versionRange: '*', functionQuery: { functionName: 'f' } }, operation: 'nonsense' as any }))
})

test('defineInjectionPoint normalizes legacy tier/mixin into a first-class mixin', () => {
  const point = defineInjectionPoint({
    id: 'official-chat/helper',
    tier: 3,
    mixin: {
      target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
      operation: 'before',
    },
  })
  assert.equal(point.mixin?.id, 'official-chat/helper')
  assert.equal(point.mixin?.operation, 'before')
  assert.equal(point.source.kind, 'mixin')
})

test('ctx.neoforge.on/once/emit/bail are 1:1 delegates of the official Cordis event path', async () => {
  const ctx = new Context()
  await ctx.plugin(createNeoForge([]))
  const seen: string[] = []
  await ctx.plugin({
    name: 'consumer',
    inject: ['neoforge'],
    apply(c: any) {
      c.neoforge.on('vendor-b/trace', () => seen.push('on'))
      c.neoforge.once('vendor-b/trace', () => seen.push('once'))
      c.neoforge.emit('vendor-b/trace', {})
      c.neoforge.emit('vendor-b/trace', {})
      c.neoforge.on('official-chat/message/before', () => seen.push('bail'))
      c.neoforge.bail('official-chat/message/before', {})
    },
  })
  assert.deepEqual(seen, ['on', 'once', 'on', 'bail'])
})

// ---------- tier 2: runtime prototype backend ----------

test('order-independent: neoforge loads before the official plugin', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(createNeoForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message/before', (e) => { seen.push(e.args[0]); e.args[0] = (e.args[0] as string).toUpperCase() })
  ctx.on('official-chat/message', (e) => seen.push(e.result))
  await ctx.plugin(plugin)
  const out = ctx.get('chat').send('hello')
  assert.equal(out, '[official] HELLO')
  assert.deepEqual(seen, ['hello', '[official] HELLO'])
})

test('order-independent: official plugin loads first (catch-up)', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))
  ctx.get('chat').send('world')
  assert.deepEqual(seen, ['[official] world'])
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
})

test('async methods: after-event carries the settled result', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'official-chat/fetch',
    tier: 2,
    runtime: { service: 'chat', method: '_fetch' },
  })]))
  const seen: unknown[] = []
  ctx.on('official-chat/fetch', (e) => seen.push(e.result))
  const out = await ctx.get('chat').fetchRemote(7)
  assert.equal(out, 'remote:7')
  assert.deepEqual(seen, ['remote:7'])
})

test('unload restores the descriptor and stops events', async () => {
  const { ChatService, plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const original = ChatService.prototype._processMessage
  const fiber = await ctx.plugin(createNeoForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  ctx.get('chat').send('x')
  assert.equal(fired, 1)
  await fiber.dispose()
  assert.equal(ChatService.prototype._processMessage, original)
  ctx.get('chat').send('y')
  assert.equal(fired, 1)
  assert.equal(ctx.get('chat').send('z'), '[official] z')
})

test('two neoforge instances chain; lower unload keeps upper working', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const log: string[] = []
  const f1 = await ctx.plugin(createNeoForge([messagePoint()]))
  const f2 = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'vendor-b/trace',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
  })]))
  ctx.on('official-chat/message', () => log.push('a'))
  ctx.on('vendor-b/trace', () => log.push('b'))
  ctx.get('chat').send('1')
  assert.deepEqual(log, ['a', 'b'])
  await f1.dispose()
  log.length = 0
  ctx.get('chat').send('2')
  assert.deepEqual(log, ['b'])
  await f2.dispose()
  log.length = 0
  assert.equal(ctx.get('chat').send('3'), '[official] 3')
  assert.deepEqual(log, [])
})

test('official fiber restart does not double-patch', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  await fiber.restart()
  ctx.get('chat').send('r')
  assert.equal(fired, 1)
})

test('cooperative opt-out is honored', async () => {
  const { plugin } = makeOfficialChat({ optOut: true })
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(fired, 0)
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'opted-out')
})

test('version drift degrades gracefully (missing method)', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessageV2' },
  })]))
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'missing')
})

// ---------- tier 1: consumer view backend ----------

test('tier 1: consumer plugin with inject sees wrapped calls', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 1,
    runtime: { service: 'chat', method: '_processMessage' },
    requires: 'mutate',
  })]))
  const seen: unknown[] = []
  ctx.on('official-chat/message/before', (e) => { e.args[0] = (e.args[0] as string) + '!' })
  let consumerOut!: string
  await ctx.plugin({
    name: 'consumer',
    inject: ['chat'],
    apply(c: any) { consumerOut = c.chat._processMessage('via-consumer'); seen.push('called') },
  })
  assert.deepEqual(seen, ['called'])
  assert.equal(consumerOut, '[official] via-consumer!')
  // root-level ctx.get() bypasses the waterfall — documented limit
  assert.equal(ctx.get('chat')._processMessage('via-root'), '[official] via-root')
})

test('consumer listeners ride the official ctx.on lifecycle (HMR dispose)', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  let fired = 0
  const consumer = await ctx.plugin({
    name: 'consumer',
    apply(c: any) {
      // no custom emitter: this is exactly the official DSH event registration
      c.on('official-chat/message', () => fired++)
    },
  })
  ctx.get('chat').send('x')
  assert.equal(fired, 1)
  await consumer.dispose()          // loader disposes the old plugin generation
  ctx.get('chat').send('y')
  assert.equal(fired, 1)            // listener went with the fiber, no leak
})

// ---------- registry validation ----------

test('registry rejects malformed and engine-conflicting declarations', () => {
  assert.throws(() => defineInjectionPoint({ id: 'BAD ID', tier: 2, runtime: { service: 'x', method: 'y' } }))
  assert.throws(() => defineInjectionPoint({ id: 'a/b', tier: 2 }))                       // missing runtime target
  assert.throws(() => defineInjectionPoint({ id: 'a/b', tier: 3 }))                       // missing mixin target
  assert.throws(() => defineInjectionPoint({                                              // runtime-reachable but tier 3
    id: 'a/b', tier: 3,
    runtime: { service: 'x', method: 'y' },
    mixin: { target: { module: 'm', versionRange: '*' }, operation: 'before' },
  }))
  assert.throws(() => defineInjectionPoint({                                              // around cannot be observe-only
    id: 'a/b', tier: 3,
    mixin: { target: { module: 'm', versionRange: '*' }, operation: 'around' },
  }))
  assert.throws(() => defineInjectionPoint({                                              // replace must own the call
    id: 'a/b', tier: 3, requires: 'mutate',
    mixin: { target: { module: 'm', versionRange: '*' }, operation: 'replace' },
  }))
  assert.throws(() => defineCatalog({ plugin: 'p', versionRange: '1', points: [           // duplicate ids
    { id: 'a/b', tier: 2, runtime: { service: 'x', method: 'y' } },
    { id: 'a/b', tier: 2, runtime: { service: 'x', method: 'z' } },
  ] }))
})

// ---------- HMR: riding the DSH loader's serialized dispose → start → rollback line ----------
// The loader replaces a plugin by disposing the old fiber, re-importing the
// module (a NEW class object), and starting a new fiber — strictly in that
// order, with rollback to the previous module on failure. `internal/service`
// fires synchronously inside notify(), before dependent fibers' async reload
// bodies run, so the facade retires the stale prototype generation and binds
// the new one inside that same window.

test('HMR handover: new module generation replaces the old one cleanly', async () => {
  const v1 = makeOfficialChat({ prefix: '[v1]' })
  const v2 = makeOfficialChat({ prefix: '[v2]' })   // re-imported module = new class
  const ctx = new Context()
  const fiber1 = await ctx.plugin(v1.plugin)
  const facade = await ctx.plugin(createNeoForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))

  assert.equal(ctx.get('chat').send('a'), '[v1] a')
  assert.equal(seen.length, 1)

  // loader replace: dispose old fiber, THEN start the new module's fiber
  await fiber1.dispose()
  await ctx.plugin(v2.plugin)

  let fired = seen.length
  assert.equal(ctx.get('chat').send('b'), '[v2] b')   // new behavior visible
  assert.equal(seen.length, fired + 1)                 // exactly one event per call
  assert.equal(seen.at(-1), '[v2] b')

  await facade.dispose()
  assert.equal(
    Object.getOwnPropertyDescriptor(v2.ChatService.prototype, '_processMessage')!.value.toString().includes('dispatchCall'),
    false,
  )
})

test('HMR rollback: old module generation re-binds after a failed replace', async () => {
  const v1 = makeOfficialChat({ prefix: '[v1]' })
  const v2 = makeOfficialChat({ prefix: '[v2]' })
  const ctx = new Context()
  const fiber1 = await ctx.plugin(v1.plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))

  await fiber1.dispose()
  const fiber2 = await ctx.plugin(v2.plugin)
  assert.equal(ctx.get('chat').send('x'), '[v2] x')

  // rollback: new generation failed, loader restarts the previous module
  await fiber2.dispose()
  await ctx.plugin(v1.plugin)
  const before = seen.length
  assert.equal(ctx.get('chat').send('y'), '[v1] y')
  assert.equal(seen.length, before + 1)   // re-bound exactly once, no double wrap
})

test('HMR ordering: dependent fibers see patched behavior on their first reload call', async () => {
  const v1 = makeOfficialChat({ prefix: '[v1]' })
  const v2 = makeOfficialChat({ prefix: '[v2]' })
  const ctx = new Context()
  const fiber1 = await ctx.plugin(v1.plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))

  // a dependent plugin: cordis reloads it whenever 'chat' is re-provided
  const results: string[] = []
  await ctx.plugin({
    name: 'consumer',
    inject: ['chat'],
    apply(c: any) { results.push(c.chat.send('from-dependent')) },
  })
  assert.deepEqual(results, ['[v1] from-dependent'])
  assert.equal(seen.length, 1)

  // replace the official module; the dependent's reload body must already see
  // the bound (and new-generation) behavior on its very first call
  await fiber1.dispose()
  await ctx.plugin(v2.plugin)
  await new Promise((r) => setTimeout(r, 10))   // let the dependent's async reload settle
  assert.deepEqual(results, ['[v1] from-dependent', '[v2] from-dependent'])
  assert.equal(seen.length, 2)
})

// ---------- standard service / policy / interface abstraction ----------

test('root entry is a valid dsh function plugin (disabled carrier row)', async () => {
  const mod = await import('../src/index.ts')
  assert.equal(mod.name, 'dsh-neoforge')
  assert.equal(typeof mod.apply, 'function')
  const ctx = new Context()
  await ctx.plugin({ name: mod.name, apply: mod.apply })
  assert.ok(ctx.get('neoforge', false))
})

test('neoforge is a standard cordis service: injectable and introspectable', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([messagePoint()]))
  assert.ok(ctx.get('neoforge'))
  let seen: unknown
  await ctx.plugin({
    name: 'introspector',
    inject: ['neoforge'],
    apply(c: any) { seen = c.neoforge.status().length },
  })
  assert.equal(seen, 1)
})

test('host policy: denied points never bind', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const governed = ctx.intercept('neoforge', { deny: ['official-chat/message'] })
  await governed.plugin(createNeoForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(fired, 0)
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'denied')
})

test('host policy: allowMutate=false downgrades to observe-only', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const governed = ctx.intercept('neoforge', { allowMutate: false })
  await governed.plugin(createNeoForge([messagePoint()]))
  let observed: unknown
  ctx.on('official-chat/message/before', (e) => { e.args[0] = 'HACKED' })   // attempt is discarded
  ctx.on('official-chat/message', (e) => { observed = e.result })
  assert.equal(ctx.get('chat').send('clean'), '[official] clean')           // mutation did not flow back
  assert.equal(observed, '[official] clean')                                 // observation still works
  assert.equal(getNeoForgeStatus(ctx)[0].downgraded, true)
})

test('interface abstraction: map exposes a stable payload instead of raw args', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessage' },
    requires: 'mutate',
    map: {
      toEvent: (args: unknown[]) => ({ text: args[0] }),
      applyEvent: (payload: Record<string, unknown>, args: unknown[]) => { args[0] = payload.text },
    },
  })]))
  ctx.on('official-chat/message/before', (e) => { e.payload!.text = (e.payload!.text as string).toUpperCase() })
  assert.equal(ctx.get('chat').send('abstracted'), '[official] ABSTRACTED')
})

// ---------- the standard way to contract-test a catalog ----------

contractSuite(defineCatalog({
  plugin: 'official-chat',
  versionRange: '^1.0.0',
  points: [messagePoint()],
}), {
  async install(ctx) {
    const { plugin } = makeOfficialChat()
    await ctx.plugin(plugin)
  },
  invoke(_point, ctx) {
    ctx.get('chat').send('contract')
  },
})

test('defineEventPoint is the explicit event-bus alias', () => {
  const point = defineEventPoint({
    id: 'official-chat/helper',
    tier: 3,
    mixin: helperMixin(),
    requires: 'mutate',
  })
  assert.equal(point.mixin?.id, point.id)
})

// ---------- conservative version-range diagnostics ----------

test('satisfies supports the ranges real DSH catalogs use', async () => {
  const { satisfies } = await import('../src/mixin.ts')
  assert.equal(satisfies('0.1.0-rc.0', '>=0.0.0-0'), true)
  assert.equal(satisfies('1.2.0', '^1.0.0'), true)
  assert.equal(satisfies('2.0.0', '^1.0.0'), false)
  assert.equal(satisfies('1.2.3', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
})

