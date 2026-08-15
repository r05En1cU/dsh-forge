import type { Context } from '@deepseek-ai/cordis'

/** Cooperative opt-out: an official plugin sets this static field to refuse patching. */
export const kOptOut = Symbol.for('dsh-forge.optout')
/** Cordis internal: unwrap traceable proxies to the raw service instance. */
export const kOriginal = Symbol.for('cordis.original')

/** Event object delivered to `'{id}'` (observe) and `'{id}/before'` (mutate) listeners. */
export interface ForgeEvent {
  /** Injection point id, e.g. 'official-chat/message'. */
  point: string
  /** Service name (runtime targets). */
  service?: string
  /** Intercepted method name (runtime targets). */
  method?: string
  /** Call arguments; `before` listeners may mutate in place. */
  args: unknown[]
  /** Stable domain-facing payload, when the point declares a `map`. */
  payload?: Record<string, unknown>
  /** Settled result; only present on the observe event. */
  result?: unknown
  /** tier-3 `around` only: set true to skip the original body and return `result`. */
  veto?: boolean
  /** tier-3 `replace` only: run the original body; its return becomes `result`. */
  invoke?: () => unknown
}

/** Runtime-reachable target: a method on a Cordis service's prototype chain. */
export interface RuntimeTarget {
  service: string
  method: string
}

/** Structural mirror of cordis-fabric's FabricTarget (no hard dependency). */
export interface FabricTargetRef {
  module: string
  versionRange: string
  filePath?: string
  filePaths?: string[]
  functionQuery?: Record<string, unknown>
  astQuery?: string
  index?: number | null
}

/**
 * One injection point: a single declaration consumable by any backend.
 * See JOINT_LAYER_PROPOSAL.md §4/§5 for the tiering and exclusivity rules.
 */
export interface InjectionPoint {
  /** Event namespace and downstream entry, e.g. 'official-chat/message'. */
  id: string
  /** 1 = consumer call view; 2 = service prototype method; 3 = runtime-unreachable (fabric only). */
  tier: 1 | 2 | 3
  /** Required for tier 1/2. */
  runtime?: RuntimeTarget
  /** Required for tier 3. M1 supports 'before'/'after' operations only. */
  fabric?: { target: FabricTargetRef; operation: 'before' | 'after' | 'around' | 'replace' }
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
  /** Tier-3 exemption marker: forfeits runtime compatibility guarantees (§5.0.1). */
  engineExclusive?: boolean
  /** Official plugin version range this point was contract-tested against. */
  versionRange?: string
}

/** A versioned set of injection points for one official plugin. */
export interface Catalog {
  /** Official plugin name, e.g. 'official-chat'. */
  plugin: string
  /** Official plugin version range this catalog targets. */
  versionRange: string
  points: InjectionPoint[]
}

export type BindStatus = 'bound' | 'pending' | 'missing' | 'opted-out' | 'unavailable' | 'stale' | 'denied'

export interface BindResult {
  status: BindStatus
  reason?: string
  dispose?: () => void
  /**
   * Lazy re-validation, called by diagnostics. Runtime backends report their
   * live status; the fabric backend re-checks bridge registration and target
   * versionRange — tier-3 transforms cannot be refreshed at runtime, so drift
   * surfaces as 'stale' (loud degradation) instead of silent fiction.
   */
  verify?: () => BindStatus
}

/** Event translation hooks supplied by the facade; identical across backends. */
export interface Hooks {
  before(eventCtx: Context, event: ForgeEvent): void
  after(eventCtx: Context, event: ForgeEvent): void
}

/** An interception engine. Selection is per-point via `InjectionPoint.tier`. */
export interface Backend {
  name: string
  available(ctx: Context): boolean
  bind(ctx: Context, point: InjectionPoint, hooks: Hooks, options: BindOptions): BindResult
}

export interface BindOptions {
  /**
   * Host policy: when false (host set `allowMutate: false`), the before event
   * is dispatched with detached copies — listeners observe but nothing flows
   * back into the official call.
   */
  mutate: boolean
}
