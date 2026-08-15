import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** UI layer registry: which presentation layers are present. */
    layers: LayersService
  }
  interface Events {
    /** A UI layer became available. */
    'layer/ready'(id: string): void
    /** A UI layer was removed. */
    'layer/gone'(id: string): void
  }
}

export interface LayerDescriptor {
  /** Layer id, e.g. 'webui' | 'tui' | 'gui'. */
  id: string
  /** Free-form kind tag for grouping (e.g. 'react-dom', 'ink'). */
  kind?: string
  /** Monotonic capability list, same convention as better-sidebar's features. */
  capabilities?: readonly string[]
}

/**
 * The layer registry. UI hosts (webui/tui/gui) register themselves here;
 * component registries listen for `layer/ready` to mount late-appearing
 * surfaces. Registration is an effect on the caller's fiber.
 */
export class LayersService extends Service {
  static provide = 'layers'

  private readonly layers = new Map<string, LayerDescriptor>()

  constructor(ctx: Context) {
    super(ctx, 'layers')
  }

  register(desc: LayerDescriptor): void {
    if (this.layers.has(desc.id)) throw new Error(`layers: "${desc.id}" is already registered`)
    this.layers.set(desc.id, desc)
    this.ctx.emit('layer/ready', desc.id)
    // this.ctx is the traceable caller context: disposal rides its fiber
    this.ctx.effect(() => {
      return () => {
        this.layers.delete(desc.id)
        this.ctx.emit('layer/gone', desc.id)
      }
    }, `layers:register(${desc.id})`)
  }

  has(id: string): boolean {
    return this.layers.has(id)
  }

  get(id: string): LayerDescriptor | undefined {
    return this.layers.get(id)
  }

  list(): LayerDescriptor[] {
    return [...this.layers.values()]
  }
}
