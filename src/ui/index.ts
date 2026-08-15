import type { Context } from '@deepseek-ai/cordis'
import { LayersService } from './layers.ts'
import { StatesService } from './states.ts'
import { ComponentsService, betterSidebarAdapter, tuiAdapter } from './components.ts'

/**
 * Mount the UI portability layer (layers + states + components) with the
 * built-in webui/tui adapters. Idempotent per root: already-mounted services
 * are reused.
 */
export function createUiKit() {
  return {
    name: 'dsh-forge-ui',
    apply(ctx: Context) {
      const root = ctx.root
      if (!root.get('layers', false)) new LayersService(root)
      if (!root.get('states', false)) new StatesService(root)
      if (!root.get('components', false)) {
        const components = new ComponentsService(root)
        components.registerAdapter(betterSidebarAdapter())
        components.registerAdapter(tuiAdapter())
      }
    },
  }
}

export { LayersService, StatesService, ComponentsService, betterSidebarAdapter, tuiAdapter }
