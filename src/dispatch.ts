import type { Context } from '@deepseek-ai/cordis'
import type { ForgeEvent, Hooks, InjectionPoint } from './types.ts'

interface EventExtras {
  service?: string
  method?: string
  args: unknown[]
  mixin?: string
  self?: unknown
  moduleVersion?: string
}

/** Build the event object for one intercepted call (payload via `map.toEvent`). */
export function createForgeEvent(point: InjectionPoint, extra: EventExtras): ForgeEvent {
  const event: ForgeEvent = { point: point.id, args: extra.args, result: undefined }
  if (extra.mixin !== undefined) event.mixin = extra.mixin
  if (extra.service !== undefined) event.service = extra.service
  if (extra.method !== undefined) event.method = extra.method
  if (extra.self !== undefined) event.self = extra.self
  if (extra.moduleVersion !== undefined) event.moduleVersion = extra.moduleVersion
  if (point.map?.toEvent) event.payload = point.map.toEvent(extra.args)
  return event
}

/** Shallow copy that can be handed to observe-only listeners. */
export function detachedEvent(event: ForgeEvent): ForgeEvent {
  return {
    ...event,
    args: [...event.args],
    payload: event.payload ? { ...event.payload } : undefined,
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function'
}

/**
 * Run one intercepted call through the event translation:
 * `{id}/before` (bail, mutable) → invoke → `{id}` (emit, settled result).
 * Thenable results settle first so async methods keep their contract.
 *
 * With `mutate: false` (host policy), the before phase sees detached copies
 * and `map.applyEvent` is skipped — observation without influence.
 */
export function dispatchCall(
  hooks: Hooks,
  point: InjectionPoint,
  eventCtx: Context,
  event: ForgeEvent,
  invoke: (args: unknown[]) => unknown,
  mutate: boolean,
): unknown {
  if (mutate) {
    hooks.before(eventCtx, event)
    point.map?.applyEvent?.(event.payload!, event.args)
  } else {
    hooks.before(eventCtx, detachedEvent(event))
  }
  const result = invoke(event.args)
  if (isThenable(result)) {
    return result.then((r) => {
      event.result = r
      hooks.after(eventCtx, event)
      return r
    })
  }
  event.result = result
  hooks.after(eventCtx, event)
  return result
}
