import { Service, type Context } from '@deepseek-ai/cordis'
import type { StoreHandle, StoreSpec } from './state.ts'
import { createStore } from './state.ts'
import type { VNode, VNodeChild } from './vnode.ts'
import { h } from './vnode.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Renderer-independent UI service (`dsh-neoforge/ui`). */
    ui: UIService
  }
  interface Events {
    /** A UI layer became available. */
    'ui/layer/ready'(id: string): void
    /** A UI layer was removed. */
    'ui/layer/gone'(id: string): void
  }
}

export interface PageDescriptor {
  id: string
  title?: string
  route?: string
  layer?: string
}

export interface LayerDescriptor {
  id: string
  kind?: string
  capabilities?: readonly string[]
}

export interface SlotDescriptor {
  id: string
  page?: string
  layer?: string
  order?: number
  title?: string
}

export type ComponentRender = (create: typeof h, props?: Record<string, unknown>) => VNode | VNodeChild

export interface ComponentDescriptor {
  id: string
  slot?: string
  title?: string
  render: ComponentRender
  /** Per-layer overrides; missing layers fall back to `render`. */
  renderers?: Record<string, ComponentRender>
  state?: StoreHandle
  options?: Record<string, unknown>
}

/** How one surface mounts a declared component. */
export interface SurfaceAdapter {
  /** Layer id served by this adapter. */
  layer: string
  /** Cordis service name the surface registers (soft-detected). */
  service: string
  mount(ctx: Context, desc: ComponentDescriptor, slot: SlotDescriptor | undefined, surface: any): (() => void) | undefined
}

interface ComponentEntry {
  desc: ComponentDescriptor
  ctx: Context
  mounts: Map<string, () => void>
}

export interface UiKitOptions {
  /** Adapters to install. Hosts provide React/Ink/native bindings here. */
  adapters?: SurfaceAdapter[]
}

function mountKey(adapter: SurfaceAdapter, componentId: string): string {
  return `${adapter.layer}:${componentId}`
}

/**
 * Renderer-independent UI service. One `ctx.ui` owns the four structural
 * levels — page → layer → slot → component — and the state seats components
 * bind to. Every registration is an effect on the calling fiber, so DSH HMR
 * cleans up exactly like `ctx.on`.
 */
export class UIService extends Service {
  static provide = 'ui'

  private readonly pages = new Map<string, PageDescriptor>()
  private readonly layers = new Map<string, LayerDescriptor>()
  private readonly slots = new Map<string, SlotDescriptor>()
  private readonly components = new Map<string, ComponentEntry>()
  private readonly stores = new Map<string, StoreHandle>()
  private readonly adapters = new Map<string, SurfaceAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'ui')
    ctx.on('ui/layer/ready', () => this.reconcile())
    ctx.on('ui/layer/gone', (id) => this.unmountLayer(id))
  }

  // ---- page ----------------------------------------------------------------

  page(desc: PageDescriptor): Readonly<PageDescriptor> {
    if (!desc.id) throw new Error('ui: page.id is required')
    if (this.pages.has(desc.id)) throw new Error(`ui: page "${desc.id}" is already registered`)
    this.pages.set(desc.id, desc)
    this.ctx.effect(() => () => { this.pages.delete(desc.id) }, `ui:page(${desc.id})`)
    return desc
  }

  // ---- layer ---------------------------------------------------------------

  layer(desc: LayerDescriptor): Readonly<LayerDescriptor> {
    if (!desc.id) throw new Error('ui: layer.id is required')
    if (this.layers.has(desc.id)) throw new Error(`ui: layer "${desc.id}" is already registered`)
    this.layers.set(desc.id, desc)
    this.ctx.emit('ui/layer/ready', desc.id)
    this.ctx.effect(() => () => {
      this.layers.delete(desc.id)
      this.ctx.emit('ui/layer/gone', desc.id)
    }, `ui:layer(${desc.id})`)
    return desc
  }

  // ---- slot ----------------------------------------------------------------

  slot(desc: SlotDescriptor): Readonly<SlotDescriptor> {
    if (!desc.id) throw new Error('ui: slot.id is required')
    if (this.slots.has(desc.id)) throw new Error(`ui: slot "${desc.id}" is already registered`)
    this.slots.set(desc.id, desc)
    this.ctx.effect(() => () => { this.slots.delete(desc.id) }, `ui:slot(${desc.id})`)
    this.reconcile()
    return desc
  }

  // ---- state ---------------------------------------------------------------

  state<S, A extends Record<string, (draft: S, ...args: any[]) => void>>(spec: StoreSpec<S, A>): StoreHandle<S, A> {
    if (!spec.id) throw new Error('ui: state.id is required')
    if (this.stores.has(spec.id)) throw new Error(`ui: state "${spec.id}" is already defined`)
    const store = createStore(spec)
    this.stores.set(spec.id, store)
    this.ctx.effect(() => () => { this.stores.delete(spec.id) }, `ui:state(${spec.id})`)
    return store
  }

  getState(id: string): StoreHandle | undefined {
    return this.stores.get(id)
  }

  // ---- component -----------------------------------------------------------

  component(desc: ComponentDescriptor): Readonly<ComponentDescriptor> {
    if (!desc.id) throw new Error('ui: component.id is required')
    if (typeof desc.render !== 'function') throw new Error(`ui: component "${desc.id}" render must be a function`)
    if (this.components.has(desc.id)) throw new Error(`ui: component "${desc.id}" is already registered`)
    const entry: ComponentEntry = { desc, ctx: this.ctx, mounts: new Map() }
    this.components.set(desc.id, entry)
    this.ctx.effect(() => () => {
      this.unmountEntry(entry)
      this.components.delete(desc.id)
    }, `ui:component(${desc.id})`)
    this.mountEntry(entry)
    return desc
  }

  registerAdapter(adapter: SurfaceAdapter): void {
    if (!adapter.layer || !adapter.service || typeof adapter.mount !== 'function') {
      throw new Error('ui: adapter requires layer, service, and mount')
    }
    if (this.adapters.has(adapter.layer)) throw new Error(`ui: adapter for layer "${adapter.layer}" is already registered`)
    this.adapters.set(adapter.layer, adapter)
    this.ctx.effect(() => () => {
      this.adapters.delete(adapter.layer)
      this.unmountLayer(adapter.layer)
    }, `ui:adapter(${adapter.layer})`)
    this.reconcile()
  }

  // ---- diagnostics ---------------------------------------------------------

  listPages(): PageDescriptor[] { return [...this.pages.values()] }
  listLayers(): LayerDescriptor[] { return [...this.layers.values()] }
  listSlots(): SlotDescriptor[] { return [...this.slots.values()] }
  listComponents(): ComponentDescriptor[] { return [...this.components.values()].map((entry) => entry.desc) }
  listStores(): StoreHandle[] { return [...this.stores.values()] }

  hasAdapter(layer: string): boolean {
    return this.adapters.has(layer)
  }

  status(): { id: string; mounted: string[] }[] {
    return [...this.components.entries()].map(([id, entry]) => ({
      id,
      mounted: [...entry.mounts.keys()].map((key) => key.slice(0, key.indexOf(':'))),
    }))
  }

  // ---- internals -----------------------------------------------------------

  private reconcile() {
    for (const entry of this.components.values()) this.mountEntry(entry)
  }

  private mountEntry(entry: ComponentEntry) {
    const desc = entry.desc
    const slot = desc.slot ? this.slots.get(desc.slot) : undefined
    if (desc.slot && !slot) return

    for (const adapter of this.adapters.values()) {
      const key = mountKey(adapter, desc.id)
      if (entry.mounts.has(key)) continue
      if (!this.layers.has(adapter.layer)) continue
      const renderer = desc.renderers?.[adapter.layer] ?? desc.render
      const surface = entry.ctx.get(adapter.service, false)
      if (!surface) continue
      try {
        const dispose = adapter.mount(entry.ctx, { ...desc, render: renderer }, slot, surface)
        if (dispose) entry.mounts.set(key, dispose)
      } catch (error) {
        entry.ctx.logger('ui').warn(`mount "${desc.id}" on ${adapter.layer} failed:`, error)
      }
    }
  }

  private unmountEntry(entry: ComponentEntry) {
    for (const dispose of entry.mounts.values()) dispose()
    entry.mounts.clear()
  }

  private unmountLayer(layer: string) {
    for (const entry of this.components.values()) {
      for (const [key, dispose] of [...entry.mounts]) {
        if (key.startsWith(`${layer}:`)) {
          dispose()
          entry.mounts.delete(key)
        }
      }
    }
  }
}

/** Mount `ctx.ui` once at the root; idempotent per root. */
export function createUiKit(options: UiKitOptions = {}) {
  return {
    name: 'dsh-neoforge-ui',
    apply(ctx: Context) {
      const root = ctx.root
      let ui = root.get('ui', false) as UIService | undefined
      if (!ui) ui = new UIService(root)
      for (const adapter of options.adapters ?? []) {
        if (!ui.hasAdapter(adapter.layer)) ui.registerAdapter(adapter)
      }
    },
  }
}
