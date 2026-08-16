import type { Context } from '@deepseek-ai/cordis'

/** Cooperative opt-out: an official plugin sets this static field to refuse patching. */
export const kOptOut = Symbol.for('dsh-neoforge.optout')
/** Cordis internal: unwrap traceable proxies to the raw service instance. */
export const kOriginal = Symbol.for('cordis.original')
/** Marks runtime-mixin wrappers; shared across package copies for chain diagnostics. */
export const kPatched = Symbol.for('dsh-neoforge.patched')

/** Fabric patch behavior kind, identical to cordis-fabric's FabricOperation. */
export type FabricOperation = 'before' | 'after' | 'around' | 'replace'

/**
 * Structural mirror of cordis-fabric's FabricTarget. The standard layer keeps
 * no hard runtime dependency on the unpublished fabric package; when the host
 * provides `ctx.fabric`, the descriptor is forwarded verbatim and validated by
 * fabric's own validator.
 */
export interface FabricTargetRef {
  /** npm package name matched against the resolved module's owner. */
  module: string
  /** semver range the owning package version must satisfy. */
  versionRange: string
  /** File path or pattern relative to the package root. */
  filePath?: string
  filePaths?: string[]
  /** Name-based function query (function, method, class, private method…). */
  functionQuery?: Record<string, unknown>
  /** Raw esquery selector; takes precedence over `functionQuery`. */
  astQuery?: string
  /** Which match to transform when a selector picks several functions. */
  index?: number | null
}

/**
 * A first-class Mixin declaration: one fabric patch descriptor without its
 * runtime handler. Mixins are versioned, priority-ordered, validated at
 * definition time, compiled into load-time instrumentation stubs by
 * `buildPatchStubs()`, and registered at runtime through `ctx.neoforge.registerMixin()`.
 */
export interface Mixin {
  /** Patch id, also the default event namespace for the derived event point. */
  id: string
  target: FabricTargetRef
  operation: FabricOperation
  /** Higher priorities run first (outermost), matching cordis-fabric. */
  priority?: number
  /** Fail startup loudly when the load-time transform bound nothing. */
  required?: boolean
}

/** A mixin reference inside an event point; the id may default to the point id. */
export type MixinRef = Mixin | Omit<Mixin, 'id'>

/**
 * Event object delivered to `'{id}'` and `'{id}/before'` listeners.
 * Catalogs can narrow the payload type in their `Events` augmentation:
 *
 *   interface Events {
 *     'agent-preset/switch'(event: NeoForgeEvent<{ to: string }>): void
 *   }
 */
export interface NeoForgeEvent<TPayload = Record<string, unknown>> {
  /** Event point id, e.g. 'official-chat/message'. */
  point: string
  /** First-class mixin id when the point is fabric-backed. */
  mixin?: string
  /** Service name (runtime targets). */
  service?: string
  /** Intercepted method name (runtime targets). */
  method?: string
  /** Call arguments; `before` listeners may mutate in place. */
  args: unknown[]
  /** Stable domain-facing payload, when the point declares a `map`. */
  payload?: TPayload
  /** Settled result; only present on observe events (and around after-phase). */
  result?: unknown
  /** Original `this` receiver of the intercepted call (fabric targets). */
  self?: unknown
  /** Version of the owning package captured at fabric transformation time. */
  moduleVersion?: string
  /** `around` only: set true to skip the original body and return `result`. */
  veto?: boolean
  /** `replace` only: run the original body; its return becomes `result`. */
  invoke?: () => unknown
}

/** Runtime-reachable target: a method on a Cordis service's prototype chain. */
export interface RuntimeTarget {
  service: string
  method: string
}

/**
 * Semantic target declaration. Catalog authors describe intent instead of a
 * magic tier; `tier/runtime/mixin/fabric` legacy fields are normalized into
 * this union by `defineInjectionPoint()`.
 */
export type PointSource =
  /** Official event already exists: alias it, patch nothing. */
  | { kind: 'event'; event: string }
  /** Patch only the consumer-facing view (`internal/get`). */
  | { kind: 'view'; service: string; method: string }
  /** Patch a Cordis service prototype method (`internal/service`). */
  | { kind: 'service'; service: string; method: string }
  /** Runtime mixin: resolve + snapshot + wrap + restore. */
  | { kind: 'mixin'; target: FabricTargetRef; operation: FabricOperation; priority?: number; required?: boolean }
  /** Optional load-time fabric bridge for runtime-unreachable targets. */
  | { kind: 'fabric'; target: FabricTargetRef; operation: FabricOperation; priority?: number; required?: boolean }

/**
 * One injection point: the event bus contract over a semantic `source`.
 *
 * Event name contract, identical for every backend:
 * - `{id}`        — observe event, dispatched after the call settles
 * - `{id}/before` — power phase (`ctx.bail`), dispatched before the call
 *
 * Which phases exist for a fabric-backed point follows the mixin operation:
 *
 * | operation | `{id}/before` | `{id}`        |
 * |-----------|---------------|---------------|
 * | before    | yes (mutate args) | no        |
 * | after     | no            | yes (mutate result) |
 * | around    | yes (args/veto) | yes (settled result) |
 * | replace   | yes (owns call via `invoke()`) | no |
 */
export interface InjectionPoint {
  /** Event namespace and downstream entry, e.g. 'official-chat/message'. */
  id: string
  /** Canonical semantic source. */
  source: PointSource
  /** Derived legacy tier: 0=event, 1=view, 2=service, 3=mixin/fabric. */
  tier: 0 | 1 | 2 | 3
  /** Derived legacy runtime target for view/service sources. */
  runtime?: RuntimeTarget
  /** Derived first-class mixin for mixin/fabric sources. */
  mixin?: Mixin
  /**
   * @deprecated legacy nested form; `defineInjectionPoint()` normalizes it
   * into a first-class `mixin` field. New catalogs should pass `mixin`.
   */
  fabric?: { target: FabricTargetRef; operation: FabricOperation; priority?: number; required?: boolean }
  /** 'observe' (default) | 'mutate' | 'replace'. Mutating points are review-listed. */
  requires?: 'observe' | 'mutate' | 'replace'
  /**
   * Interface abstraction: present a stable domain payload to listeners
   * instead of raw positional args. `toEvent` builds `event.payload` from the
   * call args; `applyEvent` writes a mutated payload back into the args.
   */
  map?: {
    toEvent?: (args: unknown[]) => Record<string, unknown>
    applyEvent?: (payload: Record<string, unknown>, args: unknown[]) => void
  }
  /**
   * Tier-3 exemption marker for the optional load-time bridge: transforming a
   * runtime-reachable service method forfeits runtime compatibility
   * guarantees. Review-listed.
   */
  engineExclusive?: boolean
  /** Official plugin version range this point was contract-tested against. */
  versionRange?: string
}

/** Raw declaration accepted by `defineInjectionPoint()`: semantic or legacy fields. */
export interface InjectionPointInput {
  id: string
  source?: PointSource
  tier?: 0 | 1 | 2 | 3
  runtime?: RuntimeTarget
  mixin?: MixinRef
  /** @deprecated legacy nested load-time form. */
  fabric?: { target: FabricTargetRef; operation: FabricOperation; priority?: number; required?: boolean }
  requires?: 'observe' | 'mutate' | 'replace'
  map?: InjectionPoint['map']
  engineExclusive?: boolean
  versionRange?: string
}

/** Raw catalog declaration shape accepted by `defineCatalog()`. */
export interface CatalogInput {
  /** Official plugin name, e.g. '@deepseek-ai/dsh-agent'. */
  plugin: string
  /** Official plugin version range this catalog targets. */
  versionRange: string
  points: InjectionPointInput[]
}

/** A normalized, frozen set of injection points for one official plugin. */
export interface Catalog {
  /** Official plugin name, e.g. '@deepseek-ai/dsh-agent'. */
  plugin: string
  /** Official plugin version range this catalog targets. */
  versionRange: string
  points: InjectionPoint[]
}

/**
 * JSON snapshot served by a host-side neoforge relay and consumed by the
 * browser-safe client entry. `events` contains the latest event per point.
 */
export interface NeoForgeSnapshot {
  events: NeoForgeEvent[]
}

export type BindStatus = 'bound' | 'pending' | 'missing' | 'opted-out' | 'unavailable' | 'stale' | 'denied'

export interface BindResult {
  status: BindStatus
  reason?: string
  dispose?: () => void
  /**
   * Lazy re-validation, called by diagnostics. Runtime backends report their
   * live status; the fabric backend re-checks bridge registration, load-time
   * bindings and the target versionRange — tier-3 transforms cannot be
   * refreshed at runtime, so drift surfaces as 'stale' (loud degradation)
   * instead of silent fiction.
   */
  verify?: () => BindStatus
}

/** Event translation hooks supplied by the facade; identical across backends. */
export interface Hooks {
  before(eventCtx: Context, event: NeoForgeEvent): void
  after(eventCtx: Context, event: NeoForgeEvent): void
}

/** An interception engine. Selection is per-point via `InjectionPoint.tier`. */
export interface Backend {
  name: string
  available(ctx: Context): boolean
  bind(ctx: Context, point: InjectionPoint, hooks: Hooks, options: BindOptions): BindResult
}

export interface BindOptions {
  /**
   * Host policy: when false (host set `allowMutate: false`), before/after
   * phases receive detached copies — listeners observe but nothing flows
   * back into the official call.
   */
  mutate: boolean
}
