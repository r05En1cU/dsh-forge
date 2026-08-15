import type { Backend, BindStatus } from '../types.ts'
import { createForgeEvent } from '../dispatch.ts'

/**
 * Intentionally minimal range check for staleness detection: '*', exact
 * 'x.y.z', and caret '^x.y.z'. Full semver belongs to registry CI; here we
 * only need a conservative drift signal.
 */
export function satisfies(version: string, range: string): boolean {
  if (!range || range === '*') return true
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  if (range.startsWith('^')) {
    const v = parse(version)
    const r = parse(range.slice(1))
    if (v[0] !== r[0]) return false
    if (r[0] === 0 && v[1] !== r[1]) return false
    return cmp(v, r) >= 0
  }
  return version === range
}

export interface FabricBackendOptions {
  /** Resolve a target module's installed version; return undefined when unreadable. */
  readVersion?: (module: string) => string | undefined
}

/**
 * Tier 3: delegate to cordis-fabric's load-time transformation engine.
 * Reserved for runtime-unreachable targets (module-level functions, closures,
 * `#private` members, browser bundles) — never for runtime-reachable service
 * methods (engine exclusivity, JOINT_LAYER_PROPOSAL §5.0.1).
 *
 * HMR stance: the baked transform stub is permanent, but the handler is
 * runtime-bound through the bridge — behavior attach/detach rides the facade
 * fiber's lifecycle like any runtime backend (register/remove are effects).
 * Transform *coverage* cannot be refreshed at runtime; instead `verify()`
 * re-checks bridge registration and the target's versionRange and reports
 * 'stale', sharing the runtime backends' loud-degradation contract.
 */
export function createFabricBackend(options: FabricBackendOptions = {}): Backend {
  return {
    name: 'fabric',
    available: (ctx) => typeof ctx.get('fabric', false)?.register === 'function',
    bind(ctx, point, hooks, bindOptions) {
      const fabric = ctx.get('fabric', false)
      if (typeof fabric?.register !== 'function') {
        return { status: 'unavailable', reason: 'fabric bridge not installed (host not wired)' }
      }
      const spec = point.fabric!
      fabric.register({
        id: point.id,
        target: spec.target as any, // structural mirror of FabricTarget; verified by fabric's own validator
        operation: spec.operation,
        handler(call: { arguments: unknown[]; result?: unknown }, invoke?: () => unknown) {
          const event = createForgeEvent(point, { args: call.arguments })
          const detached = { ...event, args: [...event.args], payload: event.payload ? { ...event.payload } : undefined }
          switch (spec.operation) {
            case 'before':
              if (bindOptions.mutate) {
                hooks.before(ctx, event)
                point.map?.applyEvent?.(event.payload!, event.args)
                call.arguments = event.args
              } else {
                hooks.before(ctx, detached)
              }
              return
            case 'after':
              event.result = call.result
              hooks.after(ctx, event)
              call.result = event.result
              return
            case 'around':
              // before-phase may mutate; `event.veto = true` skips the original
              if (bindOptions.mutate) {
                hooks.before(ctx, event)
                point.map?.applyEvent?.(event.payload!, event.args)
                call.arguments = event.args
                if (event.veto) return event.result
              } else {
                hooks.before(ctx, detached)
              }
              event.result = invoke!()
              hooks.after(ctx, event)
              return event.result
            case 'replace':
              // the listener owns the call; the original runs only via event.invoke()
              if (!bindOptions.mutate) return invoke!()
              event.invoke = () => {
                const r = invoke!()
                event.result = r
                return r
              }
              hooks.before(ctx, event)
              return event.result
          }
        },
      })

      const verify = (): BindStatus => {
        // the bridge still owns an enabled registration under our id?
        const listed = fabric.list?.() as { id: string; enabled: boolean }[] | undefined
        if (listed && !listed.some((p) => p.id === point.id && p.enabled)) return 'stale'
        // the target module's installed version still matches the declaration?
        const version = options.readVersion?.(spec.target.module)
        if (version !== undefined && !satisfies(version, spec.target.versionRange)) return 'stale'
        return 'bound'
      }

      return {
        status: verify(),
        reason: verify() === 'stale' ? 'target drifted from declared versionRange or registration lost' : undefined,
        verify,
        dispose: () => fabric.remove?.(point.id),
      }
    },
  }
}
