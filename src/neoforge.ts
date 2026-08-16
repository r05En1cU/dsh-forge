import type { Context } from '@deepseek-ai/cordis'
import type { CatalogInput, InjectionPointInput, Mixin } from './types.ts'
import { defineCatalog, defineEventPoint, defineInjectionPoint } from './registry.ts'

import { NeoForgeService, type PointRecord, type RegisterOptions } from './service.ts'

/** Mount-aware access to the neoforge layer: reuse or install at the root. */
export function getNeoForge(ctx: Context): NeoForgeService {
  const existing = ctx.get('neoforge', false)
  if (existing) return existing
  new NeoForgeService(ctx.root)
  // re-read so callers get the traceable view bound to their own context —
  // policy resolution (ctx.intercept('neoforge', …)) depends on it
  return ctx.get('neoforge', false)!
}

/** Diagnostics snapshot: every injection point registered under this root. */
export function getNeoForgeStatus(ctx: Context): Omit<PointRecord, 'dispose' | 'verify'>[] {
  return ctx.get('neoforge', false)?.status() ?? []
}

/**
 * Create the catalog-carrier plugin. Thin by design: all behavior lives in
 * the standard `NeoForgeService` (`ctx.neoforge`); this plugin only registers a
 * catalog into it, fiber-scoped.
 *
 * Downstream developers consume standard Cordis events and never see the
 * interception layer:
 *
 *   ctx.on('official-chat/message', (e) => { console.log(e.result) })
 *   ctx.neoforge.on('official-chat/message', (e) => { console.log(e.result) })
 *   ctx.on('official-chat/message/before', (e) => { e.args[0] = ... })
 */
export function createNeoForge(input: CatalogInput | InjectionPointInput[] | Mixin[], options: RegisterOptions = {}) {
  const plugin = Array.isArray(input) ? 'adhoc' : input.plugin
  return {
    name: `neoforge:${plugin}`,
    apply(ctx: Context) {
      getNeoForge(ctx).register(input, options)
    },
  }
}

export { defineInjectionPoint, defineEventPoint, defineCatalog }
