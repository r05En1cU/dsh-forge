import type { Context } from '@deepseek-ai/cordis'
import type { NeoForgeEvent, NeoForgeSnapshot } from './types.ts'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler(req: unknown, res: WebResponseLike): unknown
  }): unknown
}

interface WebResponseLike {
  statusCode?: number
  setHeader?(name: string, value: string): unknown
  end(body: string): unknown
}

export interface NeoForgeRelayOptions {
  /** Exact webserver route, e.g. '/neoforge/snapshot'. */
  path: string
  /** Point ids to buffer and publish. */
  points: string[]
}

/**
 * Host-side relay: buffers the latest observe event per point and serves them
 * as a JSON snapshot through the official `ctx.webServer` exact-route seam.
 * Registration is soft-detected (no hard `inject`), so the same plugin loads
 * on TUI/headless hosts that never mount a webserver.
 */
export function createNeoForgeRelay(options: NeoForgeRelayOptions) {
  if (typeof options.path !== 'string' || !options.path.startsWith('/')) {
    throw new Error(`neoforge-relay: path must start with '/', got ${JSON.stringify(options.path)}`)
  }
  if (!Array.isArray(options.points) || options.points.some((point) => typeof point !== 'string')) {
    throw new Error('neoforge-relay: points must be an array of point ids')
  }

  return {
    name: `neoforge-relay:${options.path}`,
    apply(ctx: Context) {
      const latest = new Map<string, NeoForgeEvent>()
      const listeners = options.points.map((point) => ctx.on(point as any, (event: NeoForgeEvent) => {
        latest.set(point, event)
      }))

      let routeDispose: (() => void) | undefined

      const mount = (webServer: WebServerLike) => {
        routeDispose?.()
        routeDispose = undefined
        const snapshot = (): NeoForgeSnapshot => ({ events: [...latest.values()] })
        const disposed = webServer.register({
          kind: 'exact',
          path: options.path,
          handler(_req, res) {
            res.statusCode = 200
            res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(snapshot()))
          },
        })
        if (typeof disposed === 'function') routeDispose = disposed as () => void
      }

      const existing = ctx.get('webServer', false)
      if (existing && typeof (existing as WebServerLike).register === 'function') {
        mount(existing as WebServerLike)
      }

      // The webserver may mount after this plugin (and may be replaced by HMR).
      const offService = ctx.on('internal/service', (name, value) => {
        if (name !== 'webServer' || !value || typeof (value as WebServerLike).register !== 'function') return
        mount(value as WebServerLike)
      })

      ctx.effect(() => () => {
        for (const off of listeners) off()
        offService()
        routeDispose?.()
        routeDispose = undefined
      }, `neoforge-relay:cleanup(${options.path})`)
    },
  }
}
