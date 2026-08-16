import type { Context } from '@deepseek-ai/cordis'
import type { ForgeEvent, ForgeSnapshot } from './types.ts'

export interface ForgeClientOptions {
  /** Host relay route, e.g. '/forge/snapshot'. */
  route: string
  /** When set, only these point ids are re-emitted. */
  points?: string[]
  /** Poll interval in ms; pass 0 to poll once. Default 1000. */
  interval?: number
  /** Poll immediately after apply. Default true. */
  immediate?: boolean
  /** Injectable fetch for tests/bundlers. Defaults to globalThis.fetch. */
  fetch?: typeof fetch
  onError?: (error: unknown) => void
}

/**
 * Browser-safe entry (`dsh-forge/client`). Polls a host-side forge relay and
 * re-emits the same ForgeEvent-shaped events on the browser Cordis tree.
 * This file must stay free of Node builtins; it is the WebUI counterpart of
 * the host/TUI event bus.
 */
export function createForgeClient(options: ForgeClientOptions) {
  if (typeof options.route !== 'string' || !options.route.startsWith('/')) {
    throw new Error(`forge-client: route must start with '/', got ${JSON.stringify(options.route)}`)
  }
  const points = options.points
  if (points !== undefined && (!Array.isArray(points) || points.some((point) => typeof point !== 'string'))) {
    throw new Error('forge-client: points must be an array of point ids')
  }
  const interval = options.interval ?? 1000
  const immediate = options.immediate ?? true

  return {
    name: `forge-client:${options.route}`,
    apply(ctx: Context) {
      const fetchImpl = options.fetch ?? globalThis.fetch
      const allowed = points ? new Set(points) : undefined

      const poll = async () => {
        if (!fetchImpl) return
        try {
          const response = await fetchImpl(options.route, { cache: 'no-store' })
          if (!response.ok) return
          const snapshot = await response.json() as ForgeSnapshot
          if (!Array.isArray(snapshot.events)) return
          for (const event of snapshot.events) {
            if (allowed && !allowed.has(event.point)) continue
            ctx.emit(event.point as any, event satisfies ForgeEvent)
          }
        } catch (error) {
          options.onError?.(error)
        }
      }

      if (immediate) void poll()
      const timer = interval > 0 ? setInterval(() => void poll(), interval) : undefined
      ctx.effect(() => () => {
        if (timer !== undefined) clearInterval(timer)
      }, `forge-client:cleanup(${options.route})`)
    },
  }
}

// Pure declaration helpers are browser-safe, so catalogs can share them.
export { defineCatalog, defineEventPoint, defineInjectionPoint } from './registry.ts'
export { defineMixin } from './mixin.ts'
export type {
  Catalog,
  CatalogInput,
  FabricOperation,
  FabricTargetRef,
  ForgeEvent,
  ForgeSnapshot,
  InjectionPoint,
  InjectionPointInput,
  Mixin,
  MixinRef,
  PointSource,
} from './types.ts'
