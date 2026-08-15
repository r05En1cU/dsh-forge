import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  contractSuite,
  createForge,
  defineCatalog,
  defineInjectionPoint,
  getForgeStatus,
  kOptOut,
  type ForgeEvent,
} from '../src/index.ts'

// Typed event surface: catalogs ship this augmentation so downstream
// `ctx.on('official-chat/message', ...)` autocompletes and type-checks like an
// official API — no mixin concepts anywhere in the consumer experience.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/message'(event: ForgeEvent): void
    'official-chat/message/before'(event: ForgeEvent): void
    'official-chat/fetch'(event: ForgeEvent): void
    'official-chat/helper/before'(event: ForgeEvent): void
    'vendor-b/trace'(event: ForgeEvent): void
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

// ---------- tier 2: prototype backend ----------

test('order-independent: forge loads before the official plugin', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(createForge([messagePoint()]))
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
  await ctx.plugin(createForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))
  ctx.get('chat').send('world')
  assert.deepEqual(seen, ['[official] world'])
  assert.equal(getForgeStatus(ctx)[0].status, 'bound')
})

test('async methods: after-event carries the settled result', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
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
  const fiber = await ctx.plugin(createForge([messagePoint()]))
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

test('two forge instances chain; lower unload keeps upper working', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const log: string[] = []
  const f1 = await ctx.plugin(createForge([messagePoint()]))
  const f2 = await ctx.plugin(createForge([defineInjectionPoint({
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
  await ctx.plugin(createForge([messagePoint()]))
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
  await ctx.plugin(createForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(fired, 0)
  assert.equal(getForgeStatus(ctx)[0].status, 'opted-out')
})

test('version drift degrades gracefully (missing method)', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/message',
    tier: 2,
    runtime: { service: 'chat', method: '_processMessageV2' },
  })]))
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(getForgeStatus(ctx)[0].status, 'missing')
})

// ---------- tier 1: consumer view backend ----------

test('tier 1: consumer plugin with inject sees wrapped calls', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
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

// ---------- tier 3: fabric backend ----------

test('tier 3: explicit unavailability without the fabric bridge', async () => {
  const ctx = new Context()
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/helper',
    tier: 3,
    fabric: {
      target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
      operation: 'before',
    },
  })]))
  const record = getForgeStatus(ctx)[0]
  assert.equal(record.status, 'unavailable')
  assert.equal(record.backend, 'fabric')
})

test('tier 3: descriptor mapped and events delivered when bridge exists', async () => {
  const ctx = new Context()
  const registrations: any[] = []
  ctx.provide('fabric', { register: (p: any) => registrations.push(p), remove: () => {} })
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/helper',
    tier: 3,
    requires: 'mutate',
    fabric: {
      target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
      operation: 'before',
    },
  })]))
  assert.equal(getForgeStatus(ctx)[0].status, 'bound')
  assert.equal(registrations[0].target.module, '@official/chat')
  const seen: unknown[] = []
  ctx.on('official-chat/helper/before', (e) => { seen.push(...e.args); e.args[0] = 'rewritten' })
  const call = { arguments: ['original'] }
  registrations[0].handler(call)
  assert.deepEqual(seen, ['original'])
  assert.equal(call.arguments[0], 'rewritten')
})

// ---------- registry validation ----------

test('registry rejects malformed and engine-conflicting declarations', () => {
  assert.throws(() => defineInjectionPoint({ id: 'BAD ID', tier: 2, runtime: { service: 'x', method: 'y' } }))
  assert.throws(() => defineInjectionPoint({ id: 'a/b', tier: 2 }))                       // missing runtime target
  assert.throws(() => defineInjectionPoint({ id: 'a/b', tier: 3 }))                       // missing fabric target
  assert.throws(() => defineInjectionPoint({                                              // runtime-reachable but tier 3
    id: 'a/b', tier: 3,
    runtime: { service: 'x', method: 'y' },
    fabric: { target: { module: 'm', versionRange: '*' }, operation: 'before' },
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
  const facade = await ctx.plugin(createForge([messagePoint()]))
  const seen: unknown[] = []
  ctx.on('official-chat/message', (e) => seen.push(e.result))

  assert.equal(ctx.get('chat').send('a'), '[v1] a')
  assert.equal(seen.length, 1)

  // loader replace: dispose old fiber, THEN start the new module's fiber
  await fiber1.dispose()
  await ctx.plugin(v2.plugin)

  // stale generation fully retired, new generation bound
  assert.equal(Object.getOwnPropertyDescriptor(v1.ChatService.prototype, '_processMessage')!.value,
    v1.ChatService.prototype._processMessage) // v1 proto holds its own original again
  let fired = seen.length
  assert.equal(ctx.get('chat').send('b'), '[v2] b')   // new behavior visible
  assert.equal(seen.length, fired + 1)                 // exactly one event per call
  assert.equal(seen.at(-1), '[v2] b')

  await facade.dispose()
  assert.notEqual(
    Object.getOwnPropertyDescriptor(v2.ChatService.prototype, '_processMessage')!.value.toString().includes('dispatchCall'),
    true,
  )
})

test('HMR rollback: old module generation re-binds after a failed replace', async () => {
  const v1 = makeOfficialChat({ prefix: '[v1]' })
  const v2 = makeOfficialChat({ prefix: '[v2]' })
  const ctx = new Context()
  const fiber1 = await ctx.plugin(v1.plugin)
  await ctx.plugin(createForge([messagePoint()]))
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
  await ctx.plugin(createForge([messagePoint()]))
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

// ---------- tier 3 staleness: loud degradation instead of silent fiction ----------
// Tier-3 transforms are baked at load time and cannot be refreshed at runtime.
// Behavior attach/detach rides the facade fiber (register/remove are effects),
// but coverage freshness is verified lazily: bridge registration + versionRange.

test('tier 3: version drift surfaces as stale via diagnostics', async () => {
  const ctx = new Context()
  let installedVersion = '1.2.0'
  ctx.provide('fabric', {
    register: () => {},
    remove: () => {},
    list: () => [{ id: 'official-chat/helper', enabled: true }],
  })
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/helper',
    tier: 3,
    fabric: {
      target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
      operation: 'before',
    },
  })], { fabric: { readVersion: () => installedVersion } }))
  assert.equal(getForgeStatus(ctx)[0].status, 'bound')
  installedVersion = '2.0.0'   // official package upgraded under us
  assert.equal(getForgeStatus(ctx)[0].status, 'stale')
})

test('tier 3: losing the bridge registration surfaces as stale', async () => {
  const ctx = new Context()
  let enabled = true
  ctx.provide('fabric', {
    register: () => {},
    remove: () => {},
    list: () => [{ id: 'official-chat/helper', enabled }],
  })
  await ctx.plugin(createForge([defineInjectionPoint({
    id: 'official-chat/helper',
    tier: 3,
    fabric: {
      target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper' } },
      operation: 'before',
    },
  })]))
  assert.equal(getForgeStatus(ctx)[0].status, 'bound')
  enabled = false   // another owner displaced our registration
  assert.equal(getForgeStatus(ctx)[0].status, 'stale')
})

// ---------- standard service / policy / interface abstraction ----------

test('forge is a standard cordis service: injectable and introspectable', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([messagePoint()]))
  assert.ok(ctx.get('forge'))
  let seen: unknown
  await ctx.plugin({
    name: 'introspector',
    inject: ['forge'],
    apply(c: any) { seen = c.forge.status().length },
  })
  assert.equal(seen, 1)
})

test('host policy: denied points never bind', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const governed = ctx.intercept('forge', { deny: ['official-chat/message'] })
  await governed.plugin(createForge([messagePoint()]))
  let fired = 0
  ctx.on('official-chat/message', () => fired++)
  assert.equal(ctx.get('chat').send('x'), '[official] x')
  assert.equal(fired, 0)
  assert.equal(getForgeStatus(ctx)[0].status, 'denied')
})

test('host policy: allowMutate=false downgrades to observe-only', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  const governed = ctx.intercept('forge', { allowMutate: false })
  await governed.plugin(createForge([messagePoint()]))
  let observed: unknown
  ctx.on('official-chat/message/before', (e) => { e.args[0] = 'HACKED' })   // attempt is discarded
  ctx.on('official-chat/message', (e) => { observed = e.result })
  assert.equal(ctx.get('chat').send('clean'), '[official] clean')           // mutation did not flow back
  assert.equal(observed, '[official] clean')                                 // observation still works
  assert.equal(getForgeStatus(ctx)[0].downgraded, true)
})

test('interface abstraction: map exposes a stable payload instead of raw args', async () => {
  const { plugin } = makeOfficialChat()
  const ctx = new Context()
  await ctx.plugin(plugin)
  await ctx.plugin(createForge([defineInjectionPoint({
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
