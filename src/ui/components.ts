import { Service, type Context } from '@deepseek-ai/cordis'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar/client/service'
import type { StoreHandle } from './states.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Component registry: declare once, every present UI layer renders. */
    components: ComponentsService
  }
}

/**
 * One component, declared once. `renderers` maps layer id → that layer's
 * renderer (route A: explicit per-surface renderers, no least-common-denominator
 * DSL). Layers without an entry are simply skipped.
 */
export interface ComponentDescriptor {
  id: string
  title: string
  /** layer id → renderer. 'webui': React FC; 'tui': line projector; … */
  renderers: Record<string, unknown>
  /** Optional state seat handed to adapters for projections. */
  state?: StoreHandle
  /** Free-form per-adapter options (e.g. sidebar tab overrides). */
  options?: Record<string, unknown>
}

/** How one UI surface mounts a component. Adapters are registered by hosts. */
export interface SurfaceAdapter {
  /** Layer id this adapter serves (matches `renderers` keys). */
  layer: string
  /** Cordis service providing the surface (soft-detected via ctx.get). */
  service: string
  mount(ctx: Context, desc: ComponentDescriptor, surface: any): (() => void) | undefined
}

interface Entry {
  desc: ComponentDescriptor
  mounts: Map<string, () => void>
}

/**
 * The component registry. One declaration, one projection per present layer.
 * Surfaces are soft-detected — a plugin loads on any host, and components
 * appear wherever their renderer exists. Mounts follow layer lifecycle:
 * `layer/ready` mounts late arrivals, `layer/gone` disposes that layer's
 * mounts, and plugin unload disposes everything it registered.
 */
export class ComponentsService extends Service {
  static provide = 'components'

  private readonly adapters = new Map<string, SurfaceAdapter>()
  private readonly entries = new Map<string, Entry>()

  constructor(ctx: Context) {
    super(ctx, 'components')
    ctx.on('layer/ready', () => this.reconcile())
    ctx.on('layer/gone', (id) => this.unmountLayer(id))
  }

  registerAdapter(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.layer, adapter)
    this.reconcile()
  }

  register(desc: ComponentDescriptor): void {
    if (this.entries.has(desc.id)) throw new Error(`components: "${desc.id}" is already registered`)
    const entry: Entry = { desc, mounts: new Map() }
    this.entries.set(desc.id, entry)
    this.mountEntry(entry)
    this.ctx.effect(() => {
      return () => {
        for (const dispose of entry.mounts.values()) dispose()
        this.entries.delete(desc.id)
      }
    }, `components:register(${desc.id})`)
  }

  /** Live view: which layers each component is mounted on. */
  status(): { id: string; mounted: string[] }[] {
    return [...this.entries.values()].map((e) => ({ id: e.desc.id, mounted: [...e.mounts.keys()] }))
  }

  private reconcile() {
    for (const entry of this.entries.values()) this.mountEntry(entry)
  }

  private mountEntry(entry: Entry) {
    for (const adapter of this.adapters.values()) {
      if (entry.mounts.has(adapter.layer)) continue
      const renderer = entry.desc.renderers[adapter.layer]
      if (!renderer) continue
      const surface = this.ctx.get(adapter.service, false)
      if (!surface) continue
      try {
        const dispose = adapter.mount(this.ctx, entry.desc, surface)
        if (dispose) entry.mounts.set(adapter.layer, dispose)
      } catch (error) {
        this.ctx.logger('components').warn(`mount "${entry.desc.id}" on ${adapter.layer} failed:`, error)
      }
    }
  }

  private unmountLayer(layer: string) {
    for (const entry of this.entries.values()) {
      entry.mounts.get(layer)?.()
      entry.mounts.delete(layer)
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

/** WebUI via better-sidebar: renderer is the tab component; state feeds the badge. */
export function betterSidebarAdapter(overrides: Partial<TabDescriptor> = {}): SurfaceAdapter {
  return {
    layer: 'webui',
    service: 'betterSidebar',
    mount(ctx, desc, surface: BetterSidebarService) {
      return surface.registerTab({
        single: true,
        ...overrides,
        ...desc.options,
        id: desc.id,
        title: desc.title,
        badge: () => {
          const snapshot = desc.state?.getSnapshot()
          return typeof snapshot === 'number' || typeof snapshot === 'string' ? snapshot : null
        },
        component: (desc.renderers.webui ?? (() => null)) as TabDescriptor['component'],
      } as TabDescriptor)
    },
  }
}

/** TUI via the community TuiRegistry contract: renderer is a line projector. */
export function tuiAdapter(): SurfaceAdapter {
  return {
    layer: 'tui',
    service: 'tui',
    mount(ctx, desc, surface: { registerPanel(d: any): () => void }) {
      const project = desc.renderers.tui as (state: unknown) => readonly string[]
      return surface.registerPanel({
        id: desc.id,
        title: desc.title,
        lines: () => project(desc.state?.getSnapshot()),
      })
    },
  }
}
