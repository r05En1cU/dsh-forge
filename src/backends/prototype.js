import { kOptOut, kOriginal } from '../types.js';
import { createForgeEvent, dispatchCall } from '../dispatch.js';
const unwrap = (value) => value?.[kOriginal] ?? value;
function isOptedOut(proto) {
    for (let c = proto.constructor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
        if (Object.hasOwn(c, kOptOut) && c[kOptOut])
            return true;
    }
    return false;
}
/**
 * Tier 2: patch the official service's prototype method in place.
 * Intercepts internal self-calls (`this._method()`), which instance proxies
 * cannot reach. Detection is order-independent: catch-up via `ctx.get(name,
 * false)` plus the official `internal/service` hook.
 *
 * Multi-middleware discipline (shimmer-style): on dispose we restore the
 * descriptor only while our wrapper is on top of the chain; otherwise we go
 * inert (pass-through) and let upper layers clean up.
 *
 * HMR discipline (aligned with the DSH loader's serialized dispose → start →
 * rollback line, entry.ts `Entry.update`): module re-evaluation produces a NEW
 * service class. `internal/service` fires synchronously inside `notify()`,
 * before dependent fibers' async reload bodies run — so when a replacement
 * prototype shows up we retire the stale generation first, then patch the new
 * one, all within the same synchronous window. A rollback re-delivers the old
 * class, which simply attaches again.
 */
export function createPrototypeBackend() {
    return {
        name: 'prototype',
        available: () => true,
        bind(ctx, point, hooks, options) {
            const { service, method } = point.runtime;
            // Must be iterable for cleanup — a WeakMap cannot be walked.
            const patched = new Map();
            let status = 'pending';
            const retire = (proto) => {
                const entry = patched.get(proto);
                if (!entry)
                    return;
                const current = Object.getOwnPropertyDescriptor(proto, method);
                if (current?.value === entry.wrapper) {
                    Object.defineProperty(proto, method, entry.desc);
                }
                else {
                    entry.state.active = false;
                }
                patched.delete(proto);
            };
            const attach = (value) => {
                const raw = unwrap(value);
                const proto = raw && Object.getPrototypeOf(raw);
                if (!proto || proto === Object.prototype)
                    return 'missing';
                // Generation handover: a different prototype for the same service means
                // the official module was re-evaluated (HMR). Retire stale generations
                // before binding the new one — never let two generations stay live.
                if (!patched.has(proto)) {
                    for (const oldProto of [...patched.keys()])
                        retire(oldProto);
                }
                if (patched.has(proto))
                    return 'bound';
                if (isOptedOut(proto))
                    return 'opted-out';
                const desc = Object.getOwnPropertyDescriptor(proto, method);
                if (!desc || typeof desc.value !== 'function')
                    return 'missing';
                const orig = desc.value;
                const state = { active: true };
                const wrapper = function (...args) {
                    if (!state.active)
                        return orig.apply(this, args);
                    // Route events through the service's own context when available.
                    const eventCtx = this?.ctx ?? ctx;
                    const event = createForgeEvent(point, { service, method, args });
                    return dispatchCall(hooks, point, eventCtx, event, (a) => orig.apply(this, a), options.mutate);
                };
                Object.defineProperty(proto, method, { ...desc, value: wrapper });
                patched.set(proto, { wrapper, state, desc });
                return 'bound';
            };
            const existing = ctx.get(service, false);
            if (existing)
                status = attach(existing);
            ctx.on('internal/service', (name, value) => {
                if (name !== service || !value)
                    return;
                const next = attach(value);
                if (status !== 'bound')
                    status = next;
            });
            return {
                status,
                verify: () => status,
                dispose: () => {
                    for (const proto of [...patched.keys()])
                        retire(proto);
                },
            };
        },
    };
}
