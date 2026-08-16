import type { Backend } from '../types.ts'
import { createNeoForgeEvent, dispatchCall } from '../dispatch.ts'

/**
 * Tier 1: wrap the consumer-facing view of a service via Cordis's official
 * `internal/get` waterfall. Events are scoped to the consuming context.
 *
 * Documented limits (verified against cordis 4.0.1):
 * - only fires for property-style access (`ctx.chat`) from plugin fibers that
 *   declared `inject`; root contexts and `ctx.get()` bypass the waterfall;
 * - cannot observe the official plugin's internal self-calls.
 */
export function createGetViewBackend(): Backend {
  return {
    name: 'getview',
    available: () => true,
    bind(ctx, point, hooks, options) {
      const { service, method } = point.runtime!
      // internal/get signature: (ctx, name, error, next) — all positional.
      const dispose = ctx.on('internal/get', (consumerCtx, name, _error, next) => {
        const value = next()
        if (name !== service || !value) return value
        return new Proxy(value, {
          get(target, prop, receiver) {
            const member = Reflect.get(target, prop, receiver)
            if (prop !== method || typeof member !== 'function') return member
            return (...args: unknown[]) => {
              const event = createNeoForgeEvent(point, { service, method, args })
              return dispatchCall(hooks, point, consumerCtx, event,
                (a) => Reflect.apply(member, receiver, a), options.mutate)
            }
          },
        })
      })
      return { status: 'bound', dispose }
    },
  }
}
