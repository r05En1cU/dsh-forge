import type { Context } from '@deepseek-ai/cordis'
import type { ForgeEvent, Hooks, InjectionPoint } from './types.ts'

/** Build the event object for one intercepted call (payload via `map.toEvent`). */
export function createForgeEvent(
  point: InjectionPoint,
  extra: { service?: string; method?: string; args: unknown[] },
): ForgeEvent {
  const event: ForgeEvent = { point: point.id, ...extra, result: undefined }
  if (point.map?.toEvent) event.payload = point.map.toEvent(extra.args)
  return event
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
    hooks.before(eventCtx, {
      ...event,
      args: [...event.args],
      payload: event.payload ? { ...event.payload } : undefined,
    })
  }
  const result = invoke(event.args)
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    return (result as Promise<unknown>).then((r) => {
      event.result = r
      hooks.after(eventCtx, event)
      return r
    })
  }
  event.result = result
  hooks.after(eventCtx, event)
  return result
}
