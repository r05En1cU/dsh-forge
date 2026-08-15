import { Service } from '@deepseek-ai/cordis';
import { defineCatalog } from './registry.js';
import { createGetViewBackend } from './backends/getview.js';
import { createPrototypeBackend } from './backends/prototype.js';
import { createFabricBackend } from './backends/fabric.js';
/**
 * The forge layer as a standard Cordis service.
 *
 * Top-down by design: hosts configure behavior with
 * `ctx.intercept('forge', policy)`, catalog plugins register injection points
 * with `ctx.forge.register(catalog)` (each registration is an effect on the
 * caller's fiber), and other services can `inject: ['forge']` to introspect
 * the layer. Mounted once at the root context; downstream consumers only ever
 * see `ctx.on('<point-id>')` events.
 */
export class ForgeService extends Service {
    static provide = 'forge';
    records = new Map();
    constructor(ctx) {
        super(ctx, 'forge');
    }
    /** Register a catalog (or bare point list); unloaded with the calling fiber. */
    register(input, options = {}) {
        const catalog = Array.isArray(input)
            ? defineCatalog({ plugin: 'adhoc', versionRange: '*', points: input })
            : defineCatalog(input);
        // Resolved against the CALLER's context (traceable shadow), so host policy
        // set via ctx.intercept('forge', …) on any ancestor applies per-subtree.
        const policy = this[Service.resolveConfig]();
        const ctx = this.ctx;
        const backends = {
            1: createGetViewBackend(),
            2: createPrototypeBackend(),
            3: createFabricBackend(options.fabric),
        };
        const hooks = {
            before: (eventCtx, event) => eventCtx.bail(`${event.point}/before`, event),
            after: (eventCtx, event) => eventCtx.emit(event.point, event),
        };
        const keys = [];
        const disposers = [];
        for (const point of catalog.points) {
            const key = `${catalog.plugin}:${point.id}`;
            let record;
            if (policy.deny?.includes(point.id)) {
                record = { catalog: catalog.plugin, point: point.id, tier: point.tier, backend: '-', status: 'denied', reason: 'denied by host policy' };
            }
            else {
                const declared = point.requires ?? 'observe';
                const mutate = declared !== 'observe' && policy.allowMutate !== false;
                const backend = backends[point.tier];
                const result = backend.available(ctx)
                    ? backend.bind(ctx, point, hooks, { mutate })
                    : { status: 'unavailable', reason: `${backend.name} backend not available` };
                record = {
                    catalog: catalog.plugin, point: point.id, tier: point.tier, backend: backend.name,
                    downgraded: declared !== 'observe' && !mutate || undefined,
                    ...result,
                };
                if (record.status !== 'bound' && record.status !== 'pending') {
                    ctx.logger('forge').warn(`injection point "${point.id}" ${record.status}${record.reason ? `: ${record.reason}` : ''}`);
                }
                if (result.dispose)
                    disposers.push(result.dispose);
            }
            this.records.set(key, record);
            keys.push(key);
        }
        // fiber-scoped cleanup on the registering plugin's fiber
        ctx.effect(() => {
            return () => {
                for (const dispose of disposers.reverse())
                    dispose();
                for (const key of keys)
                    this.records.delete(key);
            };
        }, `forge:register(${catalog.plugin})`);
        return catalog;
    }
    /** Live diagnostics: every registration, re-verified on read. */
    status() {
        return [...this.records.values()].map(({ dispose, verify, ...record }) => ({
            ...record,
            status: verify?.() ?? record.status,
        }));
    }
}
