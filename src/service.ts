import { Service, type Context } from '@deepseek-ai/cordis'
import type { Backend, BindResult, Catalog, CatalogInput, NeoForgeEvent, Hooks, InjectionPoint, InjectionPointInput, Mixin, PointSource } from './types.ts'
import { defineCatalog, defineInjectionPoint } from './registry.ts'
import { defineMixin } from './mixin.ts'
import { createGetViewBackend } from './backends/getview.ts'
import { createPrototypeBackend } from './backends/prototype.ts'
import { createRuntimeMixinBackend, installRuntimeMixin, type RuntimeMixinOptions } from './backends/runtime-mixin.ts'
import { createModuleMixinBackend } from './backends/module-mixin.ts'
import { createEventAliasBackend } from './backends/event-alias.ts'
import { createFabricBackend, type FabricBackendOptions } from './backends/fabric.ts'

/** Host policy, settable per subtree via `ctx.intercept('neoforge', …)`. */
export interface NeoForgePolicy {
  /** When false, mutating points degrade to observe-only (nothing flows back). */
  allowMutate?: boolean
  /** Injection point ids the host refuses to bind at all. */
  deny?: string[]
}

export interface RegisterOptions {
  /** Options for the runtime mixin backend. */
  mixin?: RuntimeMixinOptions
  /** Options for the optional load-time fabric bridge. */
  fabric?: FabricBackendOptions
}

export interface PointRecord extends BindResult {
  catalog: string
  point: string
  tier: number
  source: PointSource
  kind: PointSource['kind']
  backend: string
  operation?: Mixin['operation']
  /** Host downgraded this mutating point to observe-only. */
  downgraded?: boolean
}

// Dynamic injection-point ids live outside Cordis's statically-known Events
// keys; catalogs re-add them via `declare module` augmentation for consumers.
type DynamicDispatch = (name: string, event: NeoForgeEvent) => void

function isMixin(value: unknown): value is Mixin {
  return !!value && typeof value === 'object'
    && 'target' in value && 'operation' in value
    && !('tier' in value) && !('runtime' in value)
}

function isMixinList(input: InjectionPointInput[] | Mixin[]): input is Mixin[] {
  return input.length > 0 && input.every(isMixin)
}

function pointFromMixin(input: Mixin): Readonly<InjectionPoint> {
  const mixin = defineMixin(input)
  const requires = mixin.operation === 'replace' ? 'replace' : 'mutate'
  return defineInjectionPoint({
    id: mixin.id,
    source: {
      kind: 'mixin',
      target: mixin.target,
      operation: mixin.operation,
      priority: mixin.priority,
      required: mixin.required,
    },
    requires,
  })
}

function normalizeInput(input: CatalogInput | InjectionPointInput[] | Mixin[]): Readonly<Catalog> {
  if (Array.isArray(input)) {
    if (isMixinList(input)) {
      return defineCatalog({ plugin: 'adhoc', versionRange: '*', points: input.map(pointFromMixin) })
    }
    return defineCatalog({ plugin: 'adhoc', versionRange: '*', points: input as InjectionPointInput[] })
  }
  return defineCatalog(input)
}

function backendForSource(source: PointSource, options: RegisterOptions): Backend {
  switch (source.kind) {
    case 'event': return createEventAliasBackend()
    case 'view': return createGetViewBackend()
    case 'service': return createPrototypeBackend()
    case 'mixin': {
      const query = (source.target.functionQuery ?? {}) as { functionName?: unknown; expressionName?: unknown }
      return query.functionName || query.expressionName
        ? createModuleMixinBackend(options.mixin)
        : createRuntimeMixinBackend(options.mixin)
    }
    case 'fabric': return createFabricBackend(options.fabric)
  }
}

/**
 * The neoforge standard API layer as a normal Cordis service.
 *
 * Two pillars, one registration path:
 *
 * 1. First-class mixins — `ctx.neoforge.registerMixin(mixin, handler)` patches the
 *    resolved runtime target in place: exact descriptor snapshot, wrapper
 *    execution, and snapshot restore on unload. No load-time hooks.
 * 2. Event bus — catalog points translate intercepted calls into ordinary
 *    Cordis events. Consumers write plain `ctx.on('vendor/action', …)` (or
 *    the `ctx.neoforge.on(...)` sugar below), so listener registration/recycling
 *    is the official Cordis event registration path and is HMR-safe by
 *    construction — no custom emitter, no global listener table.
 *
 * The service itself is mounted once at the root and governed per subtree
 * with `ctx.intercept('neoforge', policy)`.
 */
export class NeoForgeService extends Service<NeoForgePolicy> {
  static provide = 'neoforge'

  private readonly records = new Map<string, PointRecord>()

  constructor(ctx: Context) {
    super(ctx, 'neoforge')
  }

  /**
   * Official event registration sugar. These methods delegate 1:1 to
   * `ctx.on` / `ctx.once` / `ctx.emit` / `ctx.bail` on the calling context;
   * the returned disposer belongs to the calling fiber, exactly as if the
   * developer had written `ctx.on(...)` themselves. This is what makes the
   * event bus reuse DSH's official HMR event lifecycle.
   */
  on(name: string, listener: (event: any) => any, options?: { prepend?: boolean; global?: boolean } | boolean): () => boolean {
    return this.ctx.on(name as any, listener as any, options as any)
  }

  once(name: string, listener: (event: any) => any, options?: { prepend?: boolean; global?: boolean } | boolean): () => boolean {
    return this.ctx.once(name as any, listener as any, options as any)
  }

  emit(name: string, event: unknown): void {
    this.ctx.emit(name as any, event)
  }

  bail(name: string, event: unknown): unknown {
    return this.ctx.bail(name as any, event)
  }

  /**
   * Register a first-class mixin directly — no event projection, full
   * snapshot/restore runtime semantics. The patch is owned by the calling
   * fiber: unload restores the exact original descriptor.
   */
  registerMixin(input: Mixin, handler: (call: any, invoke?: () => unknown) => unknown, options?: RuntimeMixinOptions): string {
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
    if (result.status === 'pending') {
      this.ctx.logger('neoforge').warn(`mixin "${mixin.id}" is pending: ${result.reason}`)
    }
    return mixin.id
  }

  /** Register a catalog (or bare point/mixin list); unloaded with the calling fiber. */
  register(input: CatalogInput | InjectionPointInput[] | Mixin[], options: RegisterOptions = {}) {
    const catalog = normalizeInput(input)
    // Resolved against the CALLER's context (traceable shadow), so host policy
    // set via ctx.intercept('neoforge', …) on any ancestor applies per-subtree.
    const policy = this[Service.resolveConfig]() as NeoForgePolicy
    const ctx = this.ctx

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
        record = {
          catalog: catalog.plugin, point: point.id, tier: point.tier, source: point.source, kind: point.source.kind,
          backend: '-', status: 'denied', reason: 'denied by host policy',
          operation: point.mixin?.operation,
        }
      } else {
        const declared = point.requires ?? 'observe'
        const mutate = declared !== 'observe' && policy.allowMutate !== false
        const backend = backendForSource(point.source, options)
        const result = backend.available(ctx)
          ? backend.bind(ctx, point, hooks, { mutate })
          : { status: 'unavailable' as const, reason: `${backend.name} backend not available` }
        record = {
          catalog: catalog.plugin, point: point.id, tier: point.tier, source: point.source,
          kind: point.source.kind,
          backend: backend.name, operation: point.mixin?.operation,
          downgraded: declared !== 'observe' && !mutate || undefined,
          ...result,
        }
        if (record.status !== 'bound' && record.status !== 'pending') {
          ctx.logger('neoforge').warn(
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
    }, `neoforge:register(${catalog.plugin})`)

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
