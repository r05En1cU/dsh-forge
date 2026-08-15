// PoC: joint encapsulation layer (dsh-forge × cordis-fabric)
// One InjectionPoint declaration → pluggable backends → identical ctx.on() events.
// - PrototypeBackend: runtime prototype patch, zero host dependency (works today)
// - FabricBackend: delegates to cordis-fabric when the bridge is host-installed
import { Context, Service } from '@deepseek-ai/cordis'
import assert from 'node:assert'

let passed = 0
const ok = (name, cond) => { assert(cond, `FAILED: ${name}`); passed++; console.log(`  ✓ ${name}`) }

// ============================================================
// 1. Unified injection-point declaration (the joint contract)
// ============================================================
const point = {
  id: 'official-chat/message',
  // fabric backend target (maps field-by-field to FabricPatchStub)
  fabric: {
    target: {
      module: '@official/chat',
      versionRange: '^1.0.0',
      filePath: 'lib/service.js',
      functionQuery: { functionName: '_processMessage', kind: 'Sync' },
    },
    operation: 'before',
  },
  // runtime fallback target (prototype patch)
  runtime: { service: 'chat', method: '_processMessage' },
}

// ============================================================
// 2. Backends
// ============================================================
// --- prototype backend (verified live against real cordis) ---
function createPrototypeBackend() {
  const patched = new Map()
  return {
    name: 'prototype',
    bind(point, emit, ctx) {
      const { service, method } = point.runtime
      const attach = (value) => {
        const raw = value?.[Symbol.for('cordis.original')] ?? value
        const proto = raw && Object.getPrototypeOf(raw)
        if (!proto || patched.has(proto)) return
        const desc = Object.getOwnPropertyDescriptor(proto, method)
        if (!desc) return ctx.logger('forge').warn(`${service}.${method} missing, skipped`)
        const orig = desc.value
        Object.defineProperty(proto, method, { ...desc, value: function (...args) {
          const event = { args, result: undefined }
          emit(this.ctx, event)                    // ← same translation as fabric backend
          event.result = orig.apply(this, event.args)
          return event.result
        }})
        patched.set(proto, desc)
      }
      const existing = ctx.get(service, false)
      if (existing) attach(existing)
      ctx.on('internal/service', (name, value) => name === service && value && attach(value))
      return () => { for (const [proto, desc] of patched) Object.defineProperty(proto, method, desc) }
    },
  }
}

// --- fabric backend (engine stubbed; verifies mapping + translation seam) ---
function createFabricBackend(fabricBridge) {
  return {
    name: 'fabric',
    available: () => !!fabricBridge,
    bind(point, emit, ctx) {
      // field-level mapping: InjectionPoint.fabric → FabricPatchStub + trusted handler
      fabricBridge.register({
        id: point.id,
        target: point.fabric.target,       // module/versionRange/filePath/functionQuery
        operation: point.fabric.operation, // before/after/around/replace
        handler(call) {                    // FabricCall → our event shape
          const event = { args: call.arguments, result: undefined }
          emit(ctx, event)
          call.arguments = event.args      // mutations flow back to the official call
        },
      })
      return () => fabricBridge.remove(point.id)
    },
  }
}

// ============================================================
// 3. The encapsulation facade (joint layer)
// ============================================================
function createEncapsulation(points, backends) {
  return {
    name: 'dsh-forge',
    apply(ctx) {
      const disposers = []
      const boundAs = {}
      for (const point of points) {
        // translation: backend call → standard cordis events (identical for all backends)
        const emit = (eventCtx, event) => {
          eventCtx.bail(`${point.id}/before`, event)
          // note: after-event emission is the wrapper's job in prototype mode;
          // in fabric mode a second 'after' patch would be registered likewise
        }
        // NOTE: production selection is tier-driven (runtime backends preferred for
        // tier 1/2 targets, fabric only for tier 3); here backends are listed in
        // preference order to verify the delegation seam both ways.
        const backend = backends.find(b => b.available?.() ?? true)
        boundAs[point.id] = backend.name
        const dispose = backend.bind(point, emit, ctx)
        if (dispose) disposers.push(dispose)
        ctx.logger('forge').info(`injection point "${point.id}" bound via ${backend.name} backend`)
      }
      ctx.provide('forge', { boundAs })   // diagnostics: which backend serves each point
      ctx.effect(() => () => disposers.forEach(d => d()), 'forge:restore')
    },
  }
}

// ============================================================
// Scenarios
// ============================================================
class ChatService extends Service {
  constructor(ctx) { super(ctx, 'chat') }
  send(text) { return this._processMessage(text) }
  _processMessage(text) { return `[official] ${text}` }
}
const officialChat = { name: 'official-chat', apply(ctx) { new ChatService(ctx) } }

console.log('A. no fabric bridge → prototype backend, events via ctx.on')
{
  const ctx = new Context()
  const facade = await ctx.plugin(createEncapsulation([point], [createFabricBackend(null), createPrototypeBackend()]))
  ok('prototype backend selected', ctx.get('forge').boundAs['official-chat/message'] === 'prototype')
  const seen = []
  ctx.on('official-chat/message/before', (e) => { seen.push(e.args[0]); e.args[0] = e.args[0].toUpperCase() })
  await ctx.plugin(officialChat)   // official loads after the facade — order-independent
  const out = ctx.get('chat').send('hello')
  ok('downstream ctx.on consumed & mutated the call', out === '[official] HELLO' && seen[0] === 'hello')
  await facade.dispose()           // restore the shared prototype for scenario B
}

console.log('B. fabric bridge present → fabric backend, same declaration, same events')
{
  const ctx = new Context()
  const registrations = []
  // stub of the fabric engine: records registrations, lets us fire a FabricCall
  const fakeBridge = {
    register(p) { registrations.push(p) },
    remove(id) {},
  }
  await ctx.plugin(createEncapsulation([point], [createFabricBackend(fakeBridge), createPrototypeBackend()]))
  ok('fabric backend selected', ctx.get('forge').boundAs['official-chat/message'] === 'fabric')
  const reg = registrations[0]
  ok('descriptor mapped field-by-field to FabricPatchStub',
    reg.id === 'official-chat/message'
    && reg.target.module === '@official/chat'
    && reg.target.versionRange === '^1.0.0'
    && reg.target.functionQuery.functionName === '_processMessage'
    && reg.operation === 'before')
  // simulate the fabric engine delivering a call record through its bridge
  const seen = []
  ctx.on('official-chat/message/before', (e) => { seen.push(e.args[0]); e.args[0] = 'rewritten' })
  const call = { arguments: ['original'], self: null }
  reg.handler(call)
  ok('downstream listener fired via fabric path', seen[0] === 'original')
  ok('mutation flowed back into the official call', call.arguments[0] === 'rewritten')
  ok('prototype untouched in fabric mode', ChatService.prototype._processMessage.length >= 0
    && !ChatService.prototype._processMessage.toString().includes('emit'))
}

console.log(`\nAll ${passed} assertions passed.`)
