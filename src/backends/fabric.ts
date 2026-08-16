import type { Context } from '@deepseek-ai/cordis'
import type { Backend, BindStatus, FabricTargetRef, ForgeEvent, Mixin } from '../types.ts'
import { createForgeEvent, detachedEvent } from '../dispatch.ts'

/**
 * Conservative range check for staleness detection. Supports the ranges used
 * by real DSH catalogs: '*', exact 'x.y.z', '^x.y.z', '~x.y', and single
 * '>= | > | <= | < x.y.z' comparators. Unknown composite ranges return true
 * (no drift signal) rather than a false 'stale'; full semver verification
 * belongs to registry CI.
 */
export function satisfies(version: string, range: string): boolean {
  if (!range || range === '*') return true
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const v = parse(version)

  if (range.startsWith('^')) {
    const r = parse(range.slice(1))
    if (v[0] !== r[0]) return false
    if (r[0] === 0 && v[1] !== r[1]) return false
    return cmp(v, r) >= 0
  }
  if (range.startsWith('~')) {
    const r = parse(range.slice(1))
    return v[0] === r[0] && v[1] === r[1] && cmp(v, r) >= 0
  }
  if (range.startsWith('>=')) return cmp(v, parse(range.slice(2))) >= 0
  if (range.startsWith('<=')) return cmp(v, parse(range.slice(2))) <= 0
  if (range.startsWith('>')) return cmp(v, parse(range.slice(1))) > 0
  if (range.startsWith('<')) return cmp(v, parse(range.slice(1))) < 0
  return version === range
}

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

interface FabricPatchLike {
  id: string
  target: FabricTargetRef
  operation: Mixin['operation']
  priority?: number
  required?: boolean
  handler: (call: FabricCallLike, invoke?: () => unknown) => unknown
}

interface FabricServiceLike {
  register(patch: FabricPatchLike): unknown
  remove?(id: string): unknown
  list?(): readonly { id: string; enabled: boolean }[]
  bindings?(id: string): readonly unknown[]
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function'
}

function resolveEventCtx(call: FabricCallLike, fallback: Context): Context {
  const self = call.self as { ctx?: unknown } | undefined
  const eventCtx = self?.ctx
  return eventCtx && typeof (eventCtx as Context).emit === 'function'
    ? (eventCtx as Context)
    : fallback
}

function settle(result: unknown, settleEvent: (value: unknown) => unknown): unknown {
  if (isThenable(result)) return result.then(settleEvent)
  return settleEvent(result)
}

/**
 * Tier 3: delegate to cordis-fabric's load-time transformation engine. The
 * first-class Mixin is forwarded verbatim — fabric owns validation, priority
 * composition, load-time binding, and the HMR ownership transfer — while this
 * backend translates `FabricCall` records into the standard `{id}` /
 * `{id}/before` Cordis event contract.
 *
 * HMR stance: the baked transform stub is permanent, but the handler is
 * runtime-bound through the bridge — behavior attach/detach rides the facade
 * fiber's lifecycle exactly like `ctx.on` (register/remove are effects).
 * Transform *coverage* cannot be refreshed at runtime; instead `verify()`
 * re-checks bridge registration, load-time bindings, and the target's
 * versionRange and reports 'stale'/'pending', never silent fiction.
 */
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
      const beforeName = `${point.id}/before`

      fabric.register({
        id: mixin.id,
        target: mixin.target,
        operation,
        priority: mixin.priority,
        required: mixin.required,
        handler(call, invoke) {
          const eventCtx = resolveEventCtx(call, ctx)
          const event = createForgeEvent(point, {
            args: call.arguments,
            mixin: mixin.id,
            self: call.self,
            moduleVersion: call.moduleVersion,
          })

          switch (operation) {
            case 'before': {
              if (bindOptions.mutate) {
                hooks.before(eventCtx, event)
                point.map?.applyEvent?.(event.payload!, event.args)
                call.arguments = event.args
              } else {
                hooks.before(eventCtx, detachedEvent(event))
              }
              return
            }

            case 'after': {
              event.result = call.result
              if (bindOptions.mutate) {
                hooks.after(eventCtx, event)
                call.result = event.result
              } else {
                hooks.after(eventCtx, detachedEvent(event))
              }
              return
            }

            case 'around': {
              if (bindOptions.mutate) {
                hooks.before(eventCtx, event)
                point.map?.applyEvent?.(event.payload!, event.args)
                call.arguments = event.args
                if (event.veto) return event.result
              } else {
                hooks.before(eventCtx, detachedEvent(event))
              }
              const result = invoke!()
              return settle(result, (settled) => {
                event.result = settled
                hooks.after(eventCtx, bindOptions.mutate ? event : detachedEvent(event))
                return settled
              })
            }

            case 'replace': {
              if (!bindOptions.mutate) return invoke!()
              event.invoke = () => {
                const result = invoke!()
                return settle(result, (settled) => {
                  event.result = settled
                  return settled
                })
              }
              hooks.before(eventCtx, event)
              return event.result
            }
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
        // No explicit dispose here on purpose: ctx.fabric.register is already a
        // fiber effect with HMR ownership transfer. A second remove() would
        // bypass its "only while my generation still owns the patch" guard.
      }
    },
  }
}
