const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\/[a-z0-9][a-z0-9-]*$/;
/**
 * Validate and freeze an injection point declaration.
 * Throws on malformed descriptors — a point that can never bind must fail here,
 * not silently at runtime.
 */
export function defineInjectionPoint(point) {
    if (!ID_RE.test(point.id)) {
        throw new Error(`forge: invalid injection point id ${JSON.stringify(point.id)}, expect 'plugin-name/event-name'`);
    }
    if (point.tier === 3) {
        if (!point.fabric) {
            throw new Error(`forge: tier-3 point "${point.id}" requires a fabric target`);
        }
        const op = point.fabric.operation;
        if (op === 'around' || op === 'replace') {
            // around/replace own the call — mutating capabilities by definition
            const cap = point.requires ?? 'observe';
            if (op === 'replace' && cap !== 'replace') {
                throw new Error(`forge: "${point.id}" uses replace, requires must be 'replace'`);
            }
            if (op === 'around' && cap === 'observe') {
                throw new Error(`forge: "${point.id}" uses around, requires must be 'mutate' or 'replace'`);
            }
        }
        // Engine exclusivity (JOINT_LAYER_PROPOSAL §5.0.1): a runtime-reachable
        // service method must never be transformed at load time.
        if (point.runtime && !point.engineExclusive) {
            throw new Error(`forge: "${point.id}" is runtime-reachable but declared tier 3; ` +
                `use tier 1/2, or set engineExclusive with documented justification`);
        }
    }
    else if (!point.runtime) {
        throw new Error(`forge: tier-${point.tier} point "${point.id}" requires a runtime target`);
    }
    return Object.freeze({ requires: 'observe', ...point });
}
/** Validate and freeze a catalog of injection points for one official plugin. */
export function defineCatalog(catalog) {
    if (!catalog.plugin || !catalog.versionRange) {
        throw new Error('forge: catalog requires plugin and versionRange');
    }
    const seen = new Set();
    for (const point of catalog.points) {
        if (seen.has(point.id))
            throw new Error(`forge: duplicate injection point "${point.id}"`);
        seen.add(point.id);
    }
    return Object.freeze({ ...catalog, points: catalog.points.map(defineInjectionPoint) });
}
