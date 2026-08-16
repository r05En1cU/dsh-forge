import type { Context } from '@deepseek-ai/cordis'
import type { CatalogInput, InjectionPointInput, Mixin } from './types.ts'
import { defineCatalog, defineEventPoint, defineInjectionPoint } from './registry.ts'

import { ForgeService, type PointRecord, type RegisterOptions } from './service.ts'

/** Mount-aware access to the forge layer: reuse or install at the root. */
export function getForge(ctx: Context): ForgeService {
  const existing = ctx.get('forge', false)
  if (existing) return existing
  new ForgeService(ctx.root)
  // re-read so callers get the traceable view bound to their own context —
  // policy resolution (ctx.intercept('forge', …)) depends on it
  return ctx.get('forge', false)!
}

/** Diagnostics snapshot: every injection point registered under this root. */
export function getForgeStatus(ctx: Context): Omit<PointRecord, 'dispose' | 'verify'>[] {
  return ctx.get('forge', false)?.status() ?? []
}

/**
 * Create the catalog-carrier plugin. Thin by design: all behavior lives in
 * the standard `ForgeService` (`ctx.forge`); this plugin only registers a
 * catalog into it, fiber-scoped.
 *
 * Downstream developers consume standard Cordis events and never see the
 * interception layer:
 *
 *   ctx.on('official-chat/message', (e) => { console.log(e.result) })
 *   ctx.forge.on('official-chat/message', (e) => { console.log(e.result) })
 *   ctx.on('official-chat/message/before', (e) => { e.args[0] = ... })
 */
export function createForge(input: CatalogInput | InjectionPointInput[] | Mixin[], options: RegisterOptions = {}) {
  const plugin = Array.isArray(input) ? 'adhoc' : input.plugin
  return {
    name: `forge:${plugin}`,
    apply(ctx: Context) {
      getForge(ctx).register(input, options)
    },
  }
}

export { defineInjectionPoint, defineEventPoint, defineCatalog }
