import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Catalog, InjectionPoint } from './types.ts'
import { createNeoForge, getNeoForgeStatus } from './neoforge.ts'

/**
 * Harness a catalog author implements once per official plugin. This is the
 * single standard way to contract-test a catalog: one harness, one call.
 */
export interface ContractHarness {
  /** Load the official plugin into the context (any generation). */
  install(ctx: Context): unknown | Promise<unknown>
  /** Trigger the target of `point` exactly once. */
  invoke(point: InjectionPoint, ctx: Context): unknown | Promise<unknown>
}

/**
 * The standard contract suite every catalog must pass:
 * each runtime-tier point binds and emits its observe event exactly once.
 * Mixin-backed points are skipped here; `test/runtime-mixin.test.ts` covers
 * their runtime snapshot/restore contract.
 */
export function contractSuite(catalog: Catalog, harness: ContractHarness) {
  test(`${catalog.plugin}: catalog contract`, async () => {
    const ctx = new Context()
    await harness.install(ctx)
    await ctx.plugin(createNeoForge(catalog))
    const status = getNeoForgeStatus(ctx)
    for (const point of catalog.points) {
      if (point.tier === 3) continue
      let fired = 0
      ctx.on(point.id as any, () => fired++)
      await harness.invoke(point, ctx)
      const record = status.find((r) => r.point === point.id)
      assert.equal(record?.status, 'bound', `${point.id}: expected bound, got ${record?.status} (${record?.reason ?? ''})`)
      assert.equal(fired, 1, `${point.id}: expected exactly one observe event`)
    }
  })
}
