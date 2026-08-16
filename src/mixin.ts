import { Service, type Context } from '@deepseek-ai/cordis'
import type { Backend, BindResult, Mixin, PointSource } from './types.ts'
import { defineMixin, MIXIN_ID_RE } from './mixin-define.ts'
import { createRuntimeMixinBackend, installRuntimeMixin, type RuntimeMixinOptions } from './backends/runtime-mixin.ts'
import { createModuleMixinBackend } from './backends/module-mixin.ts'
import { MODULE_EVENTS, trackModule, reloadModule, untrackModule, type ModuleRecord } from './module-events.ts'
import { satisfies } from './version.ts'
import { getNeoForge } from './neoforge.ts'

export { defineMixin, MIXIN_ID_RE }
export { satisfies }
export { MODULE_EVENTS, trackModule, reloadModule, untrackModule }
export type { ModuleRecord }
export type { RuntimeMixinOptions }
export { createRuntimeMixinBackend, installRuntimeMixin, createModuleMixinBackend }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional mixin layer service (`dsh-neoforge/mixin`). */
    mixinLayer: MixinService
  }
}

interface MixinRecord extends BindResult {
  id: string
  operation: Mixin['operation']
}

/**
 * Optional mixin layer. Mount through `createMixinLayer()`; this service owns
 * raw mixin registrations (`ctx.mixin.register`) and the module lifecycle
 * event helpers remain re-exported for host integration.
 */
export class MixinService extends Service {
  static provide = 'mixinLayer'

  private readonly records = new Map<string, MixinRecord>()

  constructor(ctx: Context) {
    super(ctx, 'mixinLayer')
  }

  /** Raw mixin registration without event projection. */
  register(input: Mixin, handler: (call: any, invoke?: () => unknown) => unknown, options?: RuntimeMixinOptions): string {
    const mixin = defineMixin(input)
    if (typeof handler !== 'function') {
      throw new Error(`neoforge: mixin "${mixin.id}" requires a trusted handler function`)
    }
    const result = installRuntimeMixin(this.ctx, mixin, handler, options)
    if (result.status === 'unavailable') {
      throw new Error(`neoforge: cannot register mixin "${mixin.id}" — ${result.reason}`)
    }
    if (result.status === 'missing') {
      throw new Error(`neoforge: cannot register mixin "${mixin.id}" — ${result.reason}`)
    }
    this.ctx.effect(() => result.dispose ?? (() => {}), `neoforge:mixin(${mixin.id})`)
    this.records.set(mixin.id, { id: mixin.id, operation: mixin.operation, ...result })
    this.ctx.effect(() => () => { this.records.delete(mixin.id) }, `neoforge:mixin-record(${mixin.id})`)
    if (result.status === 'pending') {
      this.ctx.logger('mixin').warn(`mixin "${mixin.id}" is pending: ${result.reason}`)
    }
    return mixin.id
  }

  status(): Omit<MixinRecord, 'dispose' | 'verify'>[] {
    return [...this.records.values()].map(({ dispose, verify, ...record }) => ({
      ...record,
      status: verify?.() ?? record.status,
    }))
  }
}

/** Mount-aware access to the mixin layer. */
export function getMixinLayer(ctx: Context): MixinService {
  const existing = ctx.get('mixinLayer', false)
  if (existing) return existing
  new MixinService(ctx.root)
  return ctx.get('mixinLayer', false)!
}

/** Combined runtime + module mixin backend registered as the core 'mixin' backend. */
export function createMixinBackend(options: RuntimeMixinOptions = {}): Backend {
  const moduleBackend = createModuleMixinBackend(options)
  const runtimeBackend = createRuntimeMixinBackend(options)
  return {
    name: 'mixin',
    available: () => true,
    bind(ctx, point, hooks, bindOptions) {
      const source = point.source as PointSource & { kind: 'mixin' }
      const query = (source.target.functionQuery ?? {}) as { functionName?: unknown; expressionName?: unknown }
      return (query.functionName || query.expressionName ? moduleBackend : runtimeBackend).bind(ctx, point, hooks, bindOptions)
    },
  }
}

/**
 * Mount the optional mixin layer. Must be mounted before catalogs containing
 * `source.kind === 'mixin'`; unload restores all mixin snapshots it installed.
 */
export function createMixinLayer(options: RuntimeMixinOptions = {}) {
  return {
    name: 'dsh-neoforge-mixin',
    apply(ctx: Context) {
      const root = ctx.root
      let mixin = root.get('mixinLayer', false) as MixinService | undefined
      if (!mixin) mixin = new MixinService(root)
      const neo = getNeoForge(ctx)
      if (!neo.hasBackend('mixin')) neo.registerBackend('mixin', createMixinBackend(options))
    },
  }
}
