import type { Backend } from '../types.ts'
import { createForgeEvent } from '../dispatch.ts'

/**
 * Seam-first backend: the point aliases an official Cordis event, so nothing
 * is patched at all. `{id}` is emitted for every official event; `{id}/before`
 * intentionally does not exist because aliases have no write-back power.
 */
export function createEventAliasBackend(): Backend {
  return {
    name: 'event-alias',
    available: () => true,
    bind(ctx, point, hooks) {
      const source = point.source
      if (source.kind !== 'event') return { status: 'unavailable', reason: 'not an event source' }
      const dispose = ctx.on(source.event as any, (...args: unknown[]) => {
        const event = createForgeEvent(point, { args })
        hooks.after(ctx, event)
      })
      return { status: 'bound', dispose }
    },
  }
}
