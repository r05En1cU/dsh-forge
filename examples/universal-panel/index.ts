import type { Context } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import type { ForgeEvent } from '../../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebar: BetterSidebarService
    /** Proposed community TUI registry — no official counterpart exists yet. */
    tui: TuiRegistry
  }
}

/**
 * Proposed TUI registry contract (community convention — an Ink/blessed-based
 * implementation can fill this in later; the pattern does not depend on the
 * renderer). Mirrors the better-sidebar shape: register, get a disposer.
 */
export interface TuiRegistry {
  registerPanel(descriptor: TuiPanelDescriptor): () => void
}

export interface TuiPanelDescriptor {
  id: string
  title: string
  /** Plain-text line projection for terminal rendering. */
  lines: () => readonly string[]
}

/** One panel declaration, one adapter per UI surface. */
export interface UniversalPanelOptions {
  /** The forge injection point to mirror, e.g. 'official-chat/message'. */
  point: string
  id: string
  title: string
  /** WebUI surface: better-sidebar tab overrides. */
  sidebar?: Partial<TabDescriptor>
  /** TUI surface: project buffered events into text lines. Default: latest results. */
  lines?: (events: readonly ForgeEvent[]) => readonly string[]
  /** Ring buffer size shared by all surfaces. Default 100. */
  maxEvents?: number
}

/**
 * One plugin, every UI surface: declare the panel once, and each surface that
 * is present gets it — surfaces are soft-detected (`ctx.get`), never injected,
 * so the same plugin loads on web-only, tui-only, and headless hosts alike.
 *
 * The forge event stream is the single source of truth; surfaces are pure
 * projections of the same ring buffer.
 */
export function createUniversalPanel(options: UniversalPanelOptions) {
  const max = options.maxEvents ?? 100
  return {
    name: `forge-panel:${options.id}`,
    // deliberately no `inject`: every surface is optional
    apply(ctx: Context) {
      const events: ForgeEvent[] = []
      const disposers: (() => void)[] = []
      const bound: string[] = []

      // WebUI surface: better-sidebar tab
      const sidebar = ctx.get('betterSidebar', false)
      if (sidebar) {
        disposers.push(sidebar.registerTab({
          single: true,
          ...options.sidebar,
          id: options.id,
          title: options.title,
          badge: () => events.length || null,
          component: options.sidebar?.component ?? (() => null),
        }))
        bound.push('betterSidebar')
      }

      // TUI surface: community registry (contract above)
      const tui = ctx.get('tui', false)
      if (tui) {
        const project = options.lines ?? ((es: readonly ForgeEvent[]) => es.slice(-10).map((e) => String(e.result)))
        disposers.push(tui.registerPanel({
          id: options.id,
          title: options.title,
          lines: () => project(events),
        }))
        bound.push('tui')
      }

      if (!bound.length) {
        ctx.logger('forge-panel').info(`panel "${options.id}": no UI surface present, headless mode`)
      }

      ctx.on(options.point as any, (event: ForgeEvent) => {
        events.push(event)
        if (events.length > max) events.shift()
      })

      ctx.root.logger('forge-panel').debug?.(`panel "${options.id}" bound surfaces: ${bound.join(', ') || 'none'}`)
      return () => disposers.forEach((d) => d())
    },
  }
}
