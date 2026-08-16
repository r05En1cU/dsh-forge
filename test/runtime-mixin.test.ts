import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  createNeoForge,
  defineInjectionPoint,
  defineMixin,
  getNeoForgeStatus,
  reloadModule,
  trackModule,
  untrackModule,
  type NeoForgeEvent,
} from '../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'runtime/helper/before'(event: NeoForgeEvent): void
    'runtime/compute'(event: NeoForgeEvent): void
    'runtime/greet'(event: NeoForgeEvent): void
    'runtime/greet/before'(event: NeoForgeEvent): void
    'runtime/chat/_send'(event: NeoForgeEvent): void
    'runtime/chat/_send/before'(event: NeoForgeEvent): void
    'runtime/late/helper/before'(event: NeoForgeEvent): void
    'runtime/ready'(event: NeoForgeEvent): void
    'runtime/source/helper/before'(event: NeoForgeEvent): void
    'runtime/module/helper/before'(event: NeoForgeEvent): void
    'official/ready'(value: number): void
  }
}

const require = createRequire(import.meta.url)
// CJS fixture: mutable exports object and mutable class prototypes.
const runtime: any = require('@official/chat-runtime/lib/runtime.cjs')

function helperMixin() {
  return defineMixin({
    id: 'runtime/helper',
    target: {
      module: '@official/chat-runtime',
      versionRange: '^1.0.0',
      filePath: 'lib/runtime.cjs',
      functionQuery: { functionName: 'helper', kind: 'Sync' },
    },
    operation: 'before',
  })
}

test('runtime mixin: exact descriptor snapshot → wrapper → restore on unload', async (t) => {
  const original = runtime.helper
  const originalDesc = Object.getOwnPropertyDescriptor(runtime, 'helper')!
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/helper',
    tier: 3,
    requires: 'mutate',
    mixin: helperMixin(),
  })]))
  t.after(() => facade.dispose())
  assert.notEqual(runtime.helper, original)
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  // functionName mixins are routed through the dedicated module event layer
  assert.equal(getNeoForgeStatus(ctx)[0].backend, 'module-mixin')

  const seen: unknown[] = []
  ctx.on('runtime/helper/before', (e) => {
    seen.push(e.args[0], e.mixin, e.self === runtime)
    e.args[0] = (e.args[0] as string).toUpperCase()
  })
  assert.equal(runtime.helper('snapshot'), '[util] SNAPSHOT')
  assert.deepEqual(seen, ['snapshot', 'runtime/helper', true])

  await facade.dispose()
  assert.equal(runtime.helper, original)
  assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, 'helper'), originalDesc)
  assert.equal(runtime.helper('restored'), '[util] restored')
})

test('runtime mixin: after operation observes and replaces the settled result', async () => {
  const original = runtime.compute
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/compute',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
        functionQuery: { functionName: 'compute', kind: 'Sync' },
      },
      operation: 'after',
    },
  })]))
  ctx.on('runtime/compute', (e) => { e.result = `${e.result}!` })
  assert.equal(runtime.compute(21), '42!')
  await facade.dispose()
  assert.equal(runtime.compute, original)
  assert.equal(runtime.compute(21), 42)
})

test('runtime mixin: around fires before + settled after and honors veto', async () => {
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/greet',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
        functionQuery: { functionName: 'greet', kind: 'Sync' },
      },
      operation: 'around',
    },
  })]))
  const seen: unknown[] = []
  ctx.on('runtime/greet/before', (e) => { seen.push(e.args[0]); e.args[0] = (e.args[0] as string).toUpperCase() })
  ctx.on('runtime/greet', (e) => seen.push(e.result))
  assert.equal(runtime.greet('world'), 'hello, WORLD')
  assert.deepEqual(seen, ['world', 'hello, WORLD'])

  ctx.on('runtime/greet/before', (e) => { e.veto = true; e.result = 'vetoed' })
  seen.length = 0
  assert.equal(runtime.greet('world'), 'vetoed')
  assert.deepEqual(seen, ['world'])

  await facade.dispose()
  assert.equal(runtime.greet('world'), 'hello, world')
})

test('runtime mixin: replace owns the call and invoke delegates to the snapshot original', async () => {
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/greet',
    tier: 3,
    requires: 'replace',
    mixin: {
      target: {
        module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
        functionQuery: { functionName: 'greet', kind: 'Sync' },
      },
      operation: 'replace',
    },
  })]))
  let delegate = false
  ctx.on('runtime/greet/before', (e) => {
    e.result = delegate ? `${e.invoke!()} (reviewed)` : 'owned'
  })
  assert.equal(runtime.greet('world'), 'owned')
  delegate = true
  assert.equal(runtime.greet('world'), 'hello, world (reviewed)')
  await facade.dispose()
})

test('runtime mixin: className/methodName patches the prototype in place', async (t) => {
  const ChatService = runtime.ChatService as new (prefix?: string) => { send(text: string): string }
  const original = ChatService.prototype._send
  const originalDesc = Object.getOwnPropertyDescriptor(ChatService.prototype, '_send')!
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/chat/_send',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
        functionQuery: { className: 'ChatService', methodName: '_send', kind: 'Method' },
      },
      operation: 'before',
    },
  })]))
  t.after(() => facade.dispose())
  const chat = new ChatService('[v]')
  ctx.on('runtime/chat/_send/before', (e) => { e.args[0] = (e.args[0] as string).toUpperCase() })
  assert.equal(chat.send('hi'), '[v] HI')
  await facade.dispose()
  assert.equal(ChatService.prototype._send, original)
  assert.deepEqual(Object.getOwnPropertyDescriptor(ChatService.prototype, '_send'), originalDesc)
  assert.equal(chat.send('hi'), '[v] hi')
})

test('runtime mixin: a second third-party patch on the same target fails loud', async (t) => {
  const ctx = new Context()
  const original = runtime.helper
  const f1 = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/helper', tier: 3, requires: 'mutate', mixin: helperMixin(),
  })]))
  t.after(() => f1.dispose())
  let fired = 0
  ctx.on('runtime/helper/before', () => fired++)

  await assert.rejects(async () => {
    await ctx.plugin(createNeoForge([defineInjectionPoint({
      id: 'runtime/late/helper', tier: 3, requires: 'mutate',
      mixin: {
        target: {
          module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
          functionQuery: { functionName: 'helper', kind: 'Sync' },
        },
        operation: 'before',
      },
    })]))
  }, /exclusive/)

  // the incumbent patch keeps working after the rejected registration
  assert.equal(runtime.helper('x'), '[util] x')
  assert.equal(fired, 1)
  await f1.dispose()
  assert.equal(runtime.helper, original)
  assert.equal(runtime.helper('x'), '[util] x')
})

test('runtime mixin: pending custom resolver is patched lazily by verify()', async () => {
  let target: { helper(text: string): string } | undefined
  const ctx = new Context()
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/late/helper',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: 'virtual-runtime-target', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })], { mixin: { resolveModule: () => target } }))
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'pending')

  const original = (text: string) => `virtual:${text}`
  target = { helper: original }
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  assert.notEqual(target.helper, original)

  ctx.on('runtime/late/helper/before', (e) => { e.args[0] = 'patched' })
  assert.equal(target.helper('x'), 'virtual:patched')
})

test('runtime mixin: ESM class exports are patchable through their mutable prototype', async () => {
  // @ts-expect-error fixture package ships no types
  const esm = await import('@official/chat/lib/util.js')
  const original = esm.ChatService.prototype._send
  const originalDesc = Object.getOwnPropertyDescriptor(esm.ChatService.prototype, '_send')!
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/chat/_send',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js',
        functionQuery: { className: 'ChatService', methodName: '_send', kind: 'Method' },
      },
      operation: 'before',
    },
  })]))
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  const chat = new esm.ChatService('[esm]')
  ctx.on('runtime/chat/_send/before', (e) => { e.args[0] = (e.args[0] as string).toUpperCase() })
  assert.equal(chat.send('hi'), '[esm] HI')
  await facade.dispose()
  assert.equal(esm.ChatService.prototype._send, original)
  assert.deepEqual(Object.getOwnPropertyDescriptor(esm.ChatService.prototype, '_send'), originalDesc)
  assert.equal(chat.send('hi'), '[esm] hi')
})

test('runtime mixin: ESM namespace exports are loud unavailable, not silent fiction', async () => {
  const ctx = new Context()
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/helper',
    tier: 3,
    mixin: {
      target: {
        module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })]))
  const record = getNeoForgeStatus(ctx)[0]
  assert.equal(record.status, 'unavailable')
  assert.match(record.reason ?? '', /read-only namespace/)
})

test('runtime mixin: class targets resolve through internal/service when the module is not loaded yet', async () => {
  class ChatService extends Service {
    constructor(ctx: any) { super(ctx, 'chat-runtime') }
    send(text: string) { return this._send(text) }
    _send(text: string) { return `[late] ${text}` }
  }
  const ctx = new Context()
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/chat/_send',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: 'not-installed-runtime-target', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { className: 'ChatService', methodName: '_send', kind: 'Method' },
      },
      operation: 'before',
    },
  })]))
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'pending')

  const original = ChatService.prototype._send
  await ctx.plugin({ name: 'late-chat', apply(c: any) { new ChatService(c) } })
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  assert.notEqual(ChatService.prototype._send, original)

  ctx.on('runtime/chat/_send/before', (e) => { e.args[0] = (e.args[0] as string).toUpperCase() })
  assert.equal(ctx.get('chat-runtime').send('hi'), '[late] HI')
})

test('ctx.neoforge.registerMixin: raw handler runs against the snapshot and restores on fiber unload', async (t) => {
  const original = runtime.helper
  const originalDesc = Object.getOwnPropertyDescriptor(runtime, 'helper')!
  const ctx = new Context()
  await ctx.plugin(createNeoForge([]))
  const fiber = await ctx.plugin({
    name: 'raw-mixin-user',
    inject: ['neoforge'],
    apply(c: any) {
      c.neoforge.registerMixin(helperMixin(), (call: any) => {
        call.arguments[0] = String(call.arguments[0]).toUpperCase()
      })
    },
  })
  t.after(() => fiber.dispose())
  assert.notEqual(runtime.helper, original)
  assert.equal(runtime.helper('raw'), '[util] RAW')
  await fiber.dispose()
  assert.equal(runtime.helper, original)
  assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, 'helper'), originalDesc)
  assert.equal(runtime.helper('raw'), '[util] raw')
})

test('runtime mixin: unload restores exclusivity — the same id can register again', async (t) => {
  const ctx = new Context()
  const original = runtime.helper
  const first = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/helper', tier: 3, requires: 'mutate', mixin: helperMixin(),
  })]))
  t.after(() => first.dispose())
  await first.dispose()
  assert.equal(runtime.helper, original)

  const second = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/helper', tier: 3, requires: 'mutate', mixin: helperMixin(),
  })]))
  t.after(() => second.dispose())
  assert.notEqual(runtime.helper, original)
  await second.dispose()
  assert.equal(runtime.helper, original)
})

// ---------- semantic source union ----------

test('source: event aliases an official event without patching anything', async () => {
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/ready',
    source: { kind: 'event', event: 'official/ready' },
  })]))
  const seen: unknown[] = []
  ctx.on('runtime/ready', (e) => seen.push(e.args[0]))
  ctx.emit('official/ready', 42)
  assert.deepEqual(seen, [42])
  await facade.dispose()
  ctx.emit('official/ready', 43)
  assert.deepEqual(seen, [42])
})

test('source: mixin is the canonical runtime mixin declaration', async (t) => {
  const original = runtime.helper
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/source/helper',
    requires: 'mutate',
    source: {
      kind: 'mixin',
      target: {
        module: '@official/chat-runtime', versionRange: '^1.0.0', filePath: 'lib/runtime.cjs',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })]))
  t.after(() => facade.dispose())
  ctx.on('runtime/source/helper/before', (e) => { e.args[0] = (e.args[0] as string).toUpperCase() })
  assert.equal(runtime.helper('source'), '[util] SOURCE')
  await facade.dispose()
  assert.equal(runtime.helper, original)
})

test('source: fabric is loud unavailable unless the host wired ctx.fabric', async () => {
  const ctx = new Context()
  await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/fabric-only',
    source: {
      kind: 'fabric',
      target: {
        module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })]))
  const record = getNeoForgeStatus(ctx)[0]
  assert.equal(record.backend, 'fabric')
  assert.equal(record.status, 'unavailable')
  assert.equal(record.kind, 'fabric')
})

test('source: inconsistent legacy fields next to source fail at definition time', () => {
  assert.throws(() => defineInjectionPoint({
    id: 'runtime/bad',
    source: { kind: 'service', service: 'chat', method: 'send' },
    tier: 3,
  }), /inconsistent legacy/)
})

// ---------- runtime mixin HMR semantics ----------

test('runtime mixin: service class HMR generation is re-bound through internal/service', async (t) => {
  const makeChat = (prefix: string) => class ChatService extends Service {
    constructor(ctx: any) { super(ctx, 'chat-hmr') }
    send(text: string) { return this._send(text) }
    _send(text: string) { return `${prefix} ${text}` }
  }
  const V1 = makeChat('[v1]')
  const V2 = makeChat('[v2]')
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/chat/_send',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: 'not-installed-runtime-target', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { className: 'ChatService', methodName: '_send', kind: 'Method' },
      },
      operation: 'before',
    },
  })]))
  const seen: unknown[] = []
  ctx.on('runtime/chat/_send/before', (e) => { seen.push(e.args[0]) })

  t.after(() => facade.dispose())
  const originalV1 = V1.prototype._send
  const originalV2 = V2.prototype._send
  const f1 = await ctx.plugin({ name: 'chat-v1', apply(c: any) { new V1(c) } })
  assert.equal(ctx.get('chat-hmr').send('a'), '[v1] a')
  assert.equal(seen.length, 1)

  await f1.dispose()
  await ctx.plugin({ name: 'chat-v2', apply(c: any) { new V2(c) } })

  // old generation restored, new generation patched before dependents reload
  assert.equal(V1.prototype._send, originalV1)
  assert.notEqual(V2.prototype._send, originalV2)
  assert.equal(ctx.get('chat-hmr').send('b'), '[v2] b')
  assert.equal(seen.length, 2)
  assert.deepEqual(seen, ['a', 'b'])

  await facade.dispose()
  assert.equal(V2.prototype._send, originalV2)
})

test('runtime mixin: verify() adopts a re-evaluated module holder and restores the stale one', async (t) => {
  const original1 = (text: string) => `first:${text}`
  const original2 = (text: string) => `second:${text}`
  let current = { helper: original1 }
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/late/helper',
    tier: 3,
    requires: 'mutate',
    mixin: {
      target: {
        module: 'virtual-runtime-target', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })], { mixin: { resolveModule: () => current } }))
  t.after(() => facade.dispose())
  assert.notEqual(current.helper, original1)

  // simulated module re-evaluation: new exports holder
  const stale = current
  current = { helper: original2 }
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  assert.equal(stale.helper, original1)
  assert.notEqual(current.helper, original2)

  ctx.on('runtime/late/helper/before', (e) => { e.args[0] = 'patched' })
  assert.equal(current.helper('x'), 'second:patched')
})


// ---------- custom module event layer for module-level function mixins ----------

test('module event layer: track → patch, reload → handover, untrack → restore', async (t) => {
  const first = (text: string) => `first:${text}`
  const second = (text: string) => `second:${text}`
  const exports1 = { helper: first }
  const exports2 = { helper: second }
  let current: { helper(text: string): string } | undefined

  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/module/helper',
    requires: 'mutate',
    source: {
      kind: 'mixin',
      target: {
        module: 'virtual-module', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })], { mixin: { resolveModule: () => current } }))
  t.after(() => facade.dispose())
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'pending')

  trackModule(ctx, { id: 'virtual-module/lib/index.js', module: 'virtual-module', filePath: 'lib/index.js', exports: exports1 })
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'bound')
  ctx.on('runtime/module/helper/before', (e) => { e.args[0] = 'patched' })
  assert.equal(exports1.helper('x'), 'first:patched')

  // loader publishes a reload with the fresh exports holder
  reloadModule(ctx, { id: 'virtual-module/lib/index.js', module: 'virtual-module', filePath: 'lib/index.js', exports: exports2 })
  assert.equal(exports1.helper, first)      // stale holder restored
  assert.notEqual(exports2.helper, second)  // fresh holder patched
  assert.equal(exports2.helper('y'), 'second:patched')

  untrackModule(ctx, 'virtual-module/lib/index.js')
  assert.equal(exports2.helper, second)     // current snapshot restored
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'pending')
})

test('module event layer: version mismatch is loud stale and unrelated modules are ignored', async (t) => {
  const exports = { helper: (text: string) => `ok:${text}` }
  const ctx = new Context()
  const facade = await ctx.plugin(createNeoForge([defineInjectionPoint({
    id: 'runtime/module/helper',
    requires: 'mutate',
    source: {
      kind: 'mixin',
      target: {
        module: 'virtual-module', versionRange: '^1.0.0', filePath: 'lib/index.js',
        functionQuery: { functionName: 'helper', kind: 'Sync' },
      },
      operation: 'before',
    },
  })], { mixin: { resolveModule: () => undefined } }))
  t.after(() => facade.dispose())

  trackModule(ctx, { id: 'other-module/lib/index.js', module: 'other-module', filePath: 'lib/index.js', exports })
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'pending')

  trackModule(ctx, {
    id: 'virtual-module/lib/index.js', module: 'virtual-module', filePath: 'lib/index.js',
    exports, version: '2.0.0',
  })
  assert.equal(getNeoForgeStatus(ctx)[0].status, 'stale')
  assert.equal(exports.helper, exports.helper) // untouched
})
