/**
 * Compile catalogs into static fabric patch stubs — the host bootstrap seam.
 *
 * Feed the result to cordis-fabric's `bootstrapFabric()` (or merge into the
 * host's `config.fabric.patches`) BEFORE any target module is imported:
 *
 *   import { bootstrapFabric } from 'cordis-fabric'
 *   const disposeHooks = bootstrapFabric(buildPatchStubs(catalogs))
 *
 * Only tier-3 points produce stubs; runtime tiers need no load-time work.
 * `engineExclusive` points become `required: true` (fail-loud at boot when
 * the transform never bound).
 */
export function buildPatchStubs(catalogs) {
    const stubs = [];
    for (const input of catalogs) {
        const points = Array.isArray(input) ? input : input.points;
        for (const point of points) {
            if (point.tier !== 3 || !point.fabric)
                continue;
            stubs.push({
                id: point.id,
                target: point.fabric.target,
                operation: point.fabric.operation,
                required: point.engineExclusive ?? false,
            });
        }
    }
    return stubs;
}
