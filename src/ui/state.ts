/**
 * Renderer-agnostic state seat. Adapters bind this contract with their own
 * framework primitive (React useSyncExternalStore, Ink useState+subscribe,
 * React Native useSyncExternalStore).
 */
export type StoreActions<S> = Record<string, (draft: S, ...args: any[]) => void>
export type BakedActions<S, A extends StoreActions<S>> = {
  [K in keyof A]: A[K] extends (draft: S, ...args: infer P) => void ? (...args: P) => void : never
}

export interface StoreSpec<S, A extends StoreActions<S>> {
  id: string
  init: () => S
  actions?: A
}

export interface StoreHandle<S = unknown, A extends StoreActions<S> = StoreActions<S>> {
  readonly id: string
  getSnapshot(): S
  subscribe(listener: () => void): () => void
  select<T>(selector: (state: S) => T, listener: (value: T) => void): () => void
  readonly actions: BakedActions<S, A>
}

function clone<T>(value: T): T {
  if (globalThis.structuredClone) return globalThis.structuredClone(value)
  if (Array.isArray(value)) return [...value] as T
  if (value && typeof value === 'object') return { ...value } as T
  return value
}

class Store<S, A extends StoreActions<S>> implements StoreHandle<S, A> {
  private readonly spec: StoreSpec<S, A>
  private state: S
  private readonly listeners = new Set<() => void>()
  readonly actions: BakedActions<S, A>

  constructor(spec: StoreSpec<S, A>) {
    this.spec = spec
    this.state = spec.init()
    const actions: Record<string, Function> = {}
    for (const [name, action] of Object.entries(spec.actions ?? {})) {
      actions[name] = (...args: unknown[]) => {
        const draft = clone(this.state)
        ;(action as (draft: S, ...args: unknown[]) => void)(draft, ...args)
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

export function createStore<S, A extends StoreActions<S>>(spec: StoreSpec<S, A>): StoreHandle<S, A> {
  return new Store(spec)
}
