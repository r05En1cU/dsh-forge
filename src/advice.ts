import type { Context } from '@deepseek-ai/cordis'
import type { MixinOperation, NeoForgeEvent, Hooks, InjectionPoint } from './types.ts'
import { createNeoForgeEvent, detachedEvent } from './dispatch.ts'

/**
 * The single interception primitive: every operation (`before` / `after` /
 * `around` / `replace`) is a projection over one `around`-shaped phase pair.
 * `proceed` always runs the original body with the current `call.args`.
 */
export interface OperationCall {
  self: unknown
  args: unknown[]
  result?: unknown
  invoke?: () => unknown
}

export interface OperationPhases {
  before?(call: OperationCall): void
  after?(call: OperationCall): unknown
  around?(call: OperationCall, proceed: () => unknown): unknown
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function'
}

export function settleOperation(value: unknown, settle: (value: unknown) => unknown): unknown {
  if (isThenable(value)) return value.then(settle)
  return settle(value)
}

/**
 * The one and only operation switch. `around` and `replace` intentionally
 * share the low-level calling convention — the phase decides whether to call
 * `proceed`.
 */
export function dispatchOperation(
  operation: MixinOperation,
  call: OperationCall,
  proceed: () => unknown,
  phases: OperationPhases,
): unknown {
  switch (operation) {
    case 'before': {
      phases.before?.(call)
      return proceed()
    }
    case 'after': {
      const result = proceed()
      return settleOperation(result, (value) => {
        call.result = value
        const rewritten = phases.after?.(call)
        return rewritten === undefined ? call.result : rewritten
      })
    }
    case 'around':
    case 'replace': {
      return phases.around?.(call, proceed)
    }
  }
}

function eventContextFor(call: OperationCall, fallback: Context): Context {
  const eventCtx = (call.self as { ctx?: unknown } | undefined)?.ctx
  return eventCtx && typeof (eventCtx as Context).emit === 'function'
    ? (eventCtx as Context)
    : fallback
}

/**
 * Compile a mixin operation into OperationPhases that dispatch the standard
 * `{id}/before` + `{id}` Cordis events. Used by the runtime-mixin backend and
 * runtime backends.
 */
export function createEventPhases(
  hooks: Hooks,
  point: InjectionPoint,
  fallbackCtx: Context,
  mutate: boolean,
  operation: MixinOperation,
): OperationPhases {
  const beforeEvent = (call: OperationCall): NeoForgeEvent => {
    const event = createNeoForgeEvent(point, {
      args: call.args,
      mixin: point.mixin?.id,
      self: call.self,
    })
    return event
  }

  return {
    before(call) {
      const event = beforeEvent(call)
      if (mutate) {
        hooks.before(eventContextFor(call, fallbackCtx), event)
        point.map?.applyEvent?.(event.payload!, event.args)
        call.args = event.args
      } else {
        hooks.before(eventContextFor(call, fallbackCtx), detachedEvent(event))
      }
    },

    after(call) {
      const event = beforeEvent(call)
      event.result = call.result
      if (mutate) {
        hooks.after(eventContextFor(call, fallbackCtx), event)
        return event.result
      }
      hooks.after(eventContextFor(call, fallbackCtx), detachedEvent(event))
      return call.result
    },

    around(call, proceed) {
      const event = beforeEvent(call)
      const eventCtx = eventContextFor(call, fallbackCtx)

      if (operation === 'replace') {
        if (!mutate) return proceed()
        event.invoke = () => settleOperation(proceed(), (value) => {
          event.result = value
          return value
        })
        hooks.before(eventCtx, event)
        return event.result
      }

      if (mutate) {
        hooks.before(eventCtx, event)
        point.map?.applyEvent?.(event.payload!, event.args)
        call.args = event.args
        if (event.veto) return event.result
      } else {
        hooks.before(eventCtx, detachedEvent(event))
      }

      const result = proceed()
      return settleOperation(result, (value) => {
        event.result = value
        hooks.after(eventCtx, mutate ? event : detachedEvent(event))
        return value
      })
    },
  }
}

interface RawCallLike {
  arguments: unknown[]
  self: unknown
  result?: unknown
}

/** Compile the raw `(call, invoke?)` handler contract into phases. */
export function createRawPhases(
  handler: (call: RawCallLike, invoke?: () => unknown) => unknown,
): OperationPhases {
  const raw = (call: OperationCall): RawCallLike => ({
    arguments: call.args,
    self: call.self,
    result: call.result,
  })

  return {
    before(call) {
      handler(raw(call))
    },
    after(call) {
      return handler(raw(call))
    },
    around(call, proceed) {
      return handler(raw(call), proceed)
    },
  }
}

/** Wrap a function with operation phases; callers still own snapshot/restore. */
export function wrapOperation(
  original: Function,
  operation: MixinOperation,
  phases: OperationPhases,
): Function {
  return function (this: unknown, ...args: unknown[]) {
    const call: OperationCall = { self: this, args }
    return dispatchOperation(operation, call, () => original.apply(this, call.args), phases)
  }
}
