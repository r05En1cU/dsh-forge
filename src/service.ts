import { Service, type Context } from '@deepseek-ai/cordis'
import type { Backend, BindResult, Catalog, ForgeEvent, Hooks, InjectionPoint } from './types.ts'
import { defineCatalog } from './registry.ts'
import { createGetViewBackend } from './backends/getview.ts'
import { createPrototypeBackend } from './backends/prototype.ts'
import { createFabricBackend, type FabricBackendOptions } from './backends/fabric.ts'

/** Host policy, settable per subtree via `ctx.intercept('forge', …)`. */
export interface ForgePolicy {
  /** When false, mutating points degrade to observe-only (nothing flows back). */
  allowMutate?: boolean
  /** Injection point ids the host refuses to bind at all. */
  deny?: string[]
}

export interface RegisterOptions {
  fabric?: FabricBackendOptions
}

export interface PointRecord extends BindResult {
  catalog: string
  point: string
  tier: number
  backend: string
  /** Host downgraded this mutating point to observe-only. */
  downgraded?: boolean
}

// Dynamic injection-point ids live outside Cordis's statically-known Events
// keys; catalogs re-add them via `declare module` augmentation for consumers.
type DynamicDispatch = (name: string, event: ForgeEvent) => void

/**
 * The forge layer as a standard Cordis service.
 *
 * Top-down by design: hosts configure behavior with
 * `ctx.intercept('forge', policy)`, catalog plugins register injection points
 * with `ctx.forge.register(catalog)` (each registration is an effect on the
 * caller's fiber), and other services can `inject: ['forge']` to introspect
 * the layer. Mounted once at the root context; downstream consumers only ever
 * see `ctx.on('<point-id>')` events.
 */
export class ForgeService extends Service<ForgePolicy> {
  static provide = 'forge'

  private readonly records = new Map<string, PointRecord>()

  constructor(ctx: Context) {
    super(ctx, 'forge')
  }

  /** Register a catalog (or bare point list); unloaded with the calling fiber. */
  register(input: Catalog | InjectionPoint[], options: RegisterOptions = {}) {
    const catalog = Array.isArray(input)
      ? defineCatalog({ plugin: 'adhoc', versionRange: '*', points: input })
      : defineCatalog(input)
    // Resolved against the CALLER's context (traceable shadow), so host policy
    // set via ctx.intercept('forge', …) on any ancestor applies per-subtree.
    const policy = this[Service.resolveConfig]() as ForgePolicy
    const ctx = this.ctx

    const backends: Record<number, Backend> = {
      1: createGetViewBackend(),
      2: createPrototypeBackend(),
      3: createFabricBackend(options.fabric),
    }
    const hooks: Hooks = {
      before: (eventCtx, event) => (eventCtx.bail as DynamicDispatch)(`${event.point}/before`, event),
      after: (eventCtx, event) => (eventCtx.emit as DynamicDispatch)(event.point, event),
    }

    const keys: string[] = []
    const disposers: (() => void)[] = []
    for (const point of catalog.points) {
      const key = `${catalog.plugin}:${point.id}`
      let record: PointRecord
      if (policy.deny?.includes(point.id)) {
        record = { catalog: catalog.plugin, point: point.id, tier: point.tier, backend: '-', status: 'denied', reason: 'denied by host policy' }
      } else {
        const declared = point.requires ?? 'observe'
        const mutate = declared !== 'observe' && policy.allowMutate !== false
        const backend = backends[point.tier]
        const result = backend.available(ctx)
          ? backend.bind(ctx, point, hooks, { mutate })
          : { status: 'unavailable' as const, reason: `${backend.name} backend not available` }
        record = {
          catalog: catalog.plugin, point: point.id, tier: point.tier, backend: backend.name,
          downgraded: declared !== 'observe' && !mutate || undefined,
          ...result,
        }
        if (record.status !== 'bound' && record.status !== 'pending') {
          ctx.logger('forge').warn(
            `injection point "${point.id}" ${record.status}${record.reason ? `: ${record.reason}` : ''}`,
          )
        }
        if (result.dispose) disposers.push(result.dispose)
      }
      this.records.set(key, record)
      keys.push(key)
    }

    // fiber-scoped cleanup on the registering plugin's fiber
    ctx.effect(() => {
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        for (const key of keys) this.records.delete(key)
      }
    }, `forge:register(${catalog.plugin})`)

    return catalog
  }

  /** Live diagnostics: every registration, re-verified on read. */
  status(): Omit<PointRecord, 'dispose' | 'verify'>[] {
    return [...this.records.values()].map(({ dispose, verify, ...record }) => ({
      ...record,
      status: verify?.() ?? record.status,
    }))
  }
}
