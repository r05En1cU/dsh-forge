import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Reactive state registry: renderer-agnostic store seats. */
    states: StatesService
  }
}

/** Draft-style action set: functions receive a mutable draft first. */
export type StoreActions<S> = Record<string, (draft: S, ...args: any[]) => void>
/** Actions as exposed to consumers: the draft parameter is baked away. */
export type BakedActions<S, A> = {
  [K in keyof A]: A[K] extends (draft: S, ...args: infer P) => void ? (...args: P) => void : never
}

export interface StoreSpec<S, A extends StoreActions<S>> {
  id: string
  init: () => S
  actions?: A
}

/**
 * A store seat: the renderer-agnostic observable contract (bare
 * getSnapshot/subscribe, never a framework hook — hook binding belongs to the
 * renderer, same discipline as the official slots store family).
 */
export interface StoreHandle<S = unknown, A = {}> {
  readonly id: string
  getSnapshot(): S
  subscribe(listener: () => void): () => void
  /** Subscribe to a selector's derived value; fires only on change. */
  select<T>(selector: (state: S) => T, listener: (value: T) => void): () => void
  readonly actions: BakedActions<S, A>
}

class Store<S, A extends StoreActions<S>> implements StoreHandle<S, A> {
  private spec: StoreSpec<S, A>
  private state: S
  private listeners = new Set<() => void>()
  public readonly actions: BakedActions<S, A>

  constructor(spec: StoreSpec<S, A>) {
    this.spec = spec
    this.state = spec.init()
    const actions: Record<string, Function> = {}
    for (const [name, fn] of Object.entries(spec.actions ?? {})) {
      actions[name] = (...args: unknown[]) => {
        const draft = structuredClone(this.state)
        fn(draft, ...args)
        this.state = draft
        for (const listener of [...this.listeners]) listener()
      }
    }
    this.actions = actions as BakedActions<S, A>
  }

  get id() { return this.spec.id }
  getSnapshot() { return this.state }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  select<T>(selector: (state: S) => T, listener: (value: T) => void) {
    let current = selector(this.state)
    return this.subscribe(() => {
      const next = selector(this.state)
      if (!Object.is(next, current)) {
        current = next
        listener(next)
      }
    })
  }
}

/**
 * State seats as a standard service. Any UI layer binds these stores with its
 * own mechanism (React useSyncExternalStore, Ink useState + subscribe, …).
 */
export class StatesService extends Service {
  static provide = 'states'

  private readonly stores = new Map<string, StoreHandle>()

  constructor(ctx: Context) {
    super(ctx, 'states')
  }

  define<S, A extends StoreActions<S>>(spec: StoreSpec<S, A>): StoreHandle<S, A> {
    if (this.stores.has(spec.id)) throw new Error(`states: "${spec.id}" is already defined`)
    const store = new Store(spec)
    this.stores.set(spec.id, store)
    this.ctx.effect(() => {
      return () => { this.stores.delete(spec.id) }
    }, `states:define(${spec.id})`)
    return store
  }

  get(id: string): StoreHandle | undefined {
    return this.stores.get(id)
  }

  list(): StoreHandle[] {
    return [...this.stores.values()]
  }
}
