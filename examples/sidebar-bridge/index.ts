import type { Context } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import type { ForgeEvent } from '../../src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The better-sidebar tab registry (browser-side service). */
    betterSidebar: BetterSidebarService
  }
}

export interface SidebarBridgeOptions {
  /** The forge injection point to mirror, e.g. 'official-chat/message'. */
  point: string
  /** Tab identity registered through ctx.betterSidebar. */
  tab: Pick<TabDescriptor, 'id' | 'title'> & Partial<TabDescriptor>
  /** Project the buffered events into the tab-strip badge. Default: event count. */
  badge?: (events: readonly ForgeEvent[]) => string | number | null
  /** Ring buffer size. Default 100. */
  maxEvents?: number
  /**
   * The tab's React component. Only ever evaluated in the browser bundle;
   * tests and host-side usage may omit it (defaults to a null component).
   */
  component?: TabDescriptor['component']
}

/**
 * The reference bridge: a forge injection point → a better-sidebar tab.
 *
 * Demonstrates the full chain with zero new concepts per side:
 * host-side events arrive via plain `ctx.on(point)`; UI presence is a plain
 * `registerTab` whose disposer rides this plugin's fiber. `badge` reads the
 * ring buffer on every tab-bar render, so no manual repaint wiring exists.
 */
export function createSidebarBridge(options: SidebarBridgeOptions) {
  const max = options.maxEvents ?? 100
  return {
    name: `forge-sidebar:${options.point}`,
    inject: ['betterSidebar'],
    apply(ctx: Context) {
      const events: ForgeEvent[] = []
      const disposeTab = ctx.betterSidebar.registerTab({
        single: true,
        ...options.tab,
        badge: () => options.badge?.(events) ?? (events.length || null),
        component: options.component ?? (() => null),
      })
      // the observe event of the injection point — nothing else to learn
      ctx.on(options.point as any, (event: ForgeEvent) => {
        events.push(event)
        if (events.length > max) events.shift()
      })
      return disposeTab
    },
  }
}
