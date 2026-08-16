import { Service, type Context } from '@deepseek-ai/cordis'
import type { Backend, BindResult, Catalog, CatalogInput, NeoForgeEvent, Hooks, InjectionPoint, InjectionPointInput, Mixin, PointSource } from './types.ts'
import { defineCatalog, defineInjectionPoint } from './registry.ts'
import { defineMixin } from './mixin-define.ts'
import { createGetViewBackend } from './backends/getview.ts'
import { createPrototypeBackend } from './backends/prototype.ts'
import { createEventAliasBackend } from './backends/event-alias.ts'

/** Host policy, settable per subtree via `ctx.intercept('neoforge', …)`. */
export interface NeoForgePolicy {
  /** When false, mutating points degrade to observe-only (nothing flows back). */
  allowMutate?: boolean
  /** Injection point ids the host refuses to bind at all. */
  deny?: string[]
}

export interface RegisterOptions {}

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
    source: { kind: 'mixin', target: mixin.target, operation: mixin.operation },
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

function unavailableBackend(name: string, reason: string): Backend {
  return {
    name,
    available: () => false,
    bind: () => ({ status: 'unavailable', reason }),
  }
}

/**
 * Core neoforge layer: catalog registration, official seams, event sugar,
 * host policy. Runtime mixins are deliberately NOT imported here; mount
 * `dsh-neoforge/mixin` and register its backend through `registerBackend()`.
 */
export class NeoForgeService extends Service<NeoForgePolicy> {
  static provide = 'neoforge'

  private readonly records = new Map<string, PointRecord>()
  private readonly backends = new Map<string, Backend>()
  private readonly backendBindings = new Map<string, Set<string>>()

  constructor(ctx: Context) {
    super(ctx, 'neoforge')
  }

  /** Register an external backend (e.g. the mixin layer). Fiber-scoped. */
  registerBackend(name: string, backend: Backend): void {
    if (!name || !backend || typeof backend.bind !== 'function') {
      throw new Error('neoforge: registerBackend requires a name and a backend')
    }
    if (this.backends.has(name)) {
      throw new Error(`neoforge: backend "${name}" is already registered`)
    }
    this.backends.set(name, backend)
    const keys = this.backendBindings.get(name) ?? new Set<string>()
    this.backendBindings.set(name, keys)
    this.ctx.effect(() => {
      return () => {
        for (const key of [...keys]) {
          const record = this.records.get(key)
          if (record) {
            record.dispose?.()
            record.status = 'unavailable'
            record.reason = `backend "${name}" was unloaded`
          }
        }
        keys.clear()
        this.backends.delete(name)
      }
    }, `neoforge:backend(${name})`)
  }

  hasBackend(name: string): boolean {
    return this.backends.has(name)
  }

  /**
   * Official event registration sugar. These methods delegate 1:1 to
   * `ctx.on` / `ctx.once` / `ctx.emit` / `ctx.bail` on the calling context.
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

  /** Register a catalog (or bare point/mixin list); unloaded with the calling fiber. */
  register(input: CatalogInput | InjectionPointInput[] | Mixin[], _options: RegisterOptions = {}) {
    const catalog = normalizeInput(input)
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
        const backend = this.resolveBackend(point.source)
        const result = backend.available(ctx)
          ? backend.bind(ctx, point, hooks, { mutate })
          : { status: 'unavailable' as const, reason: `${backend.name} backend not available: ${backend.name === 'mixin' ? 'mount dsh-neoforge/mixin first' : 'backend unavailable'}` }
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
        if (result.dispose) {
          disposers.push(result.dispose)
          let bound = this.backendBindings.get(backend.name)
          if (!bound) this.backendBindings.set(backend.name, (bound = new Set()))
          bound.add(key)
        }
      }
      this.records.set(key, record)
      keys.push(key)
    }

    ctx.effect(() => {
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        for (const key of keys) {
          const record = this.records.get(key)
          const bound = record ? this.backendBindings.get(record.backend) : undefined
          bound?.delete(key)
          this.records.delete(key)
        }
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

  private resolveBackend(source: PointSource): Backend {
    switch (source.kind) {
      case 'event': return createEventAliasBackend()
      case 'view': return createGetViewBackend()
      case 'service': return createPrototypeBackend()
      case 'mixin': {
        return this.backends.get('mixin')
          ?? unavailableBackend('mixin', 'mixin layer not installed; mount createMixinLayer() before catalogs')
      }
    }
  }
}
