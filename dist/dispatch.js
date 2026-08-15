/** Build the event object for one intercepted call (payload via `map.toEvent`). */
export function createForgeEvent(point, extra) {
    const event = { point: point.id, ...extra, result: undefined };
    if (point.map?.toEvent)
        event.payload = point.map.toEvent(extra.args);
    return event;
}
/**
 * Run one intercepted call through the event translation:
 * `{id}/before` (bail, mutable) → invoke → `{id}` (emit, settled result).
 * Thenable results settle first so async methods keep their contract.
 *
 * With `mutate: false` (host policy), the before phase sees detached copies
 * and `map.applyEvent` is skipped — observation without influence.
 */
export function dispatchCall(hooks, point, eventCtx, event, invoke, mutate) {
    if (mutate) {
        hooks.before(eventCtx, event);
        point.map?.applyEvent?.(event.payload, event.args);
    }
    else {
        hooks.before(eventCtx, {
            ...event,
            args: [...event.args],
            payload: event.payload ? { ...event.payload } : undefined,
        });
    }
    const result = invoke(event.args);
    if (result && typeof result.then === 'function') {
        return result.then((r) => {
            event.result = r;
            hooks.after(eventCtx, event);
            return r;
        });
    }
    event.result = result;
    hooks.after(eventCtx, event);
    return result;
}
