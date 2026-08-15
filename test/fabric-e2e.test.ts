import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { bootstrapFabric, FabricService } from 'cordis-fabric'
import {
  buildPatchStubs,
  createForge,
  defineCatalog,
  getForgeStatus,
  type ForgeEvent,
} from '../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'official-chat/helper'(event: ForgeEvent): void
    'official-chat/helper/before'(event: ForgeEvent): void
    'official-chat/compute'(event: ForgeEvent): void
    'official-chat/compute/before'(event: ForgeEvent): void
    'official-chat/greet/before'(event: ForgeEvent): void
  }
}

const catalog = defineCatalog({
  plugin: 'official-chat',
  versionRange: '^1.0.0',
  points: [
    {
      id: 'official-chat/helper', tier: 3, requires: 'mutate',
      fabric: { target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'helper', kind: 'Sync' } }, operation: 'before' },
    },
    {
      id: 'official-chat/compute', tier: 3, requires: 'mutate',
      fabric: { target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'compute', kind: 'Sync' } }, operation: 'around' },
    },
    {
      id: 'official-chat/greet', tier: 3, requires: 'replace',
      fabric: { target: { module: '@official/chat', versionRange: '^1.0.0', filePath: 'lib/util.js', functionQuery: { functionName: 'greet', kind: 'Sync' } }, operation: 'replace' },
    },
  ],
})

// Host bootstrap seam: hooks install BEFORE the target module is imported.
const disposeHooks = bootstrapFabric(buildPatchStubs([catalog]) as any)
// @ts-expect-error fixture package ships no types
const util: any = await import('./fixtures/node_modules/@official/chat/lib/util.js')

// The fabric runtime is process-local: patch ids are exclusive to one owner,
// so each test gets its own Context and must dispose it on exit.
async function setup(t: any) {
  const ctx = new Context()
  new FabricService(ctx as any)
  const facade = await ctx.plugin(createForge(catalog))
  t.after(() => facade.dispose())
  return ctx
}

test('e2e: real fabric engine, before-operation point', async (t) => {
  const ctx = await setup(t)
  assert.equal(getForgeStatus(ctx).find((r) => r.point === 'official-chat/helper')?.status, 'bound')
  const seen: unknown[] = []
  ctx.on('official-chat/helper/before', (e) => { seen.push(e.args[0]); e.args[0] = (e.args[0] as string).toUpperCase() })
  assert.equal(util.helper('real'), '[util] REAL')
  assert.deepEqual(seen, ['real'])
})

test('e2e: around — mutate args, observe result, veto skips the original', async (t) => {
  const ctx = await setup(t)
  const seen: unknown[] = []
  ctx.on('official-chat/compute', (e) => seen.push(e.result))
  assert.equal(util.compute(21), 42)
  assert.deepEqual(seen, [42])
  // veto: the original body never runs
  ctx.on('official-chat/compute/before', (e) => { e.veto = true; e.result = 'vetoed' })
  assert.equal(util.compute(21) as unknown, 'vetoed')
})

test('e2e: replace — listener owns the call, original only via event.invoke()', async (t) => {
  const ctx = await setup(t)
  let callOriginal = false
  ctx.on('official-chat/greet/before', (e) => {
    if (callOriginal) { e.invoke!(); e.result = `${e.result} (reviewed)` } else { e.result = 'owned' }
  })
  assert.equal(util.greet('world') as unknown, 'owned')
  callOriginal = true
  assert.equal(util.greet('world') as unknown, 'hello, world (reviewed)')
})

test('e2e: facade unload detaches handlers — transformed code falls back', async (t) => {
  const ctx = new Context()
  new FabricService(ctx as any)
  const facade = await ctx.plugin(createForge(catalog))
  t.after(() => facade.dispose())
  ctx.on('official-chat/helper/before', (e) => { e.args[0] = 'patched' })
  assert.equal(util.helper('x'), '[util] patched')
  await facade.dispose()
  assert.equal(util.helper('x'), '[util] x')
})

test('e2e: event object honors the cross-backend contract', async (t) => {
  const ctx = new Context()
  new FabricService(ctx as any)
  const facade = await ctx.plugin(createForge(catalog))
  t.after(() => facade.dispose())
  let beforeKeys: string[] = []
  let afterEvent: ForgeEvent | undefined
  // the around point fires both phases, like the runtime backends do
  ctx.on('official-chat/compute/before', (e) => { beforeKeys = Object.keys(e).sort() })
  ctx.on('official-chat/compute', (e) => { afterEvent = e })
  util.compute(21)
  // the contract every backend honors: point id + args on before, result on observe
  assert.deepEqual(beforeKeys, ['args', 'point', 'result'])
  assert.equal(afterEvent?.point, 'official-chat/compute')
  assert.equal(afterEvent?.result, 42)
})
