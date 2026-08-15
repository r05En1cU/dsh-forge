import { defineCatalog, defineInjectionPoint } from './registry.js';
import { ForgeService } from './service.js';
/** Mount-aware access to the forge layer: reuse or install at the root. */
export function getForge(ctx) {
    const existing = ctx.get('forge', false);
    if (existing)
        return existing;
    new ForgeService(ctx.root);
    // re-read so callers get the traceable view bound to their own context —
    // policy resolution (ctx.intercept('forge', …)) depends on it
    return ctx.get('forge', false);
}
/** Diagnostics snapshot: every injection point registered under this root. */
export function getForgeStatus(ctx) {
    return ctx.get('forge', false)?.status() ?? [];
}
/**
 * Create the catalog-carrier plugin. Thin by design: all behavior lives in
 * the standard `ForgeService` (`ctx.forge`); this plugin only registers a
 * catalog into it, fiber-scoped.
 *
 * Downstream developers consume standard Cordis events and never see the
 * interception layer:
 *
 *   ctx.on('official-chat/message', (e) => { console.log(e.result) })
 *   ctx.on('official-chat/message/before', (e) => { e.args[0] = ... })
 */
export function createForge(input, options = {}) {
    const catalog = Array.isArray(input)
        ? defineCatalog({ plugin: 'adhoc', versionRange: '*', points: input })
        : defineCatalog(input);
    return {
        name: `forge:${catalog.plugin}`,
        apply(ctx) {
            getForge(ctx).register(catalog, options);
        },
    };
}
export { defineInjectionPoint, defineCatalog };
