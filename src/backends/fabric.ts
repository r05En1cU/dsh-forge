
import type { Backend, BindStatus } from '../types.ts'
import { createEventPhases, dispatchOperation, type OperationCall } from '../advice.ts'
import { satisfies } from '../version.ts'

/**
 * Optional load-time bridge for runtime-unreachable targets (ESM module-level
 * functions, `#private`, closures, browser bundles). Not part of the default
 * runtime path; only points with `source: { kind: 'fabric' }` land here.
 */
export interface FabricBackendOptions {
  /** Resolve a target module's installed version; return undefined when unreadable. */
  readVersion?: (module: string) => string | undefined
}

interface FabricCallLike {
  arguments: unknown[]
  self?: unknown
  moduleVersion?: string
  result?: unknown
}

interface FabricServiceLike {
  register(patch: unknown): unknown
  list?(): readonly { id: string; enabled: boolean }[]
  bindings?(id: string): readonly unknown[]
}

export function createFabricBackend(options: FabricBackendOptions = {}): Backend {
  return {
    name: 'fabric',
    available: (ctx) => typeof (ctx.get('fabric', false) as FabricServiceLike | undefined)?.register === 'function',
    bind(ctx, point, hooks, bindOptions) {
      const fabric = ctx.get('fabric', false) as FabricServiceLike | undefined
      if (typeof fabric?.register !== 'function') {
        return { status: 'unavailable', reason: 'fabric bridge not installed (host not wired)' }
      }
      const mixin = point.mixin!
      const operation = mixin.operation
      const phases = createEventPhases(hooks, point, ctx, bindOptions.mutate, operation)

      fabric.register({
        id: mixin.id,
        target: mixin.target as any,
        operation,
        priority: mixin.priority,
        required: mixin.required,
        handler(call: FabricCallLike, invoke?: () => unknown) {
          const opCall: OperationCall = { self: call.self, args: call.arguments }
          switch (operation) {
            case 'before':
              phases.before?.(opCall)
              call.arguments = opCall.args
              return
            case 'after':
              opCall.result = call.result
              return phases.after?.(opCall)
            case 'around':
            case 'replace':
              return dispatchOperation(operation, opCall, () => invoke!(), phases)
          }
        },
      })

      const verify = (): BindStatus => {
        const listed = fabric.list?.()
        if (listed && !listed.some((p) => p.id === mixin.id && p.enabled)) return 'stale'
        const bindings = fabric.bindings?.(mixin.id)
        if (bindings && bindings.length === 0) return 'pending'
        const version = options.readVersion?.(mixin.target.module)
        if (version !== undefined && !satisfies(version, mixin.target.versionRange)) return 'stale'
        return 'bound'
      }

      const initial = verify()
      return {
        status: initial,
        reason: initial === 'stale'
          ? 'target drifted from declared versionRange or bridge registration lost'
          : initial === 'pending'
            ? 'fabric patch registered but no load-time binding recorded yet'
            : undefined,
        verify,
      }
    },
  }
}
