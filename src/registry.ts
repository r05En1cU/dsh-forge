import type { Catalog, CatalogInput, FabricOperation, InjectionPoint, InjectionPointInput } from './types.ts'
import { MIXIN_ID_RE, normalizeMixin } from './mixin.ts'

const CAPABILITY: Record<FabricOperation, ReadonlySet<InjectionPoint['requires']>> = {
  before: new Set(['observe', 'mutate']),
  after: new Set(['observe', 'mutate', 'replace']),
  around: new Set(['mutate', 'replace']),
  replace: new Set(['replace']),
}

function capabilityFor(operation: FabricOperation, declared: InjectionPoint['requires']): InjectionPoint['requires'] {
  const allowed = CAPABILITY[operation]
  if (!declared || !allowed.has(declared)) {
    throw new Error(
      `forge: operation "${operation}" does not allow requires ${JSON.stringify(declared ?? 'observe')}; allowed: ${[...allowed].join(', ')}`,
    )
  }
  return declared
}

/**
 * Validate and freeze an injection point declaration. This is the one place
 * where a descriptor that can never bind fails — at definition time, not
 * silently at runtime.
 */
export function defineInjectionPoint(point: InjectionPointInput): Readonly<InjectionPoint> {
  if (!MIXIN_ID_RE.test(point.id)) {
    throw new Error(`forge: invalid injection point id ${JSON.stringify(point.id)}, expected 'namespace/action'`)
  }
  if (point.mixin && point.fabric) {
    throw new Error(`forge: point "${point.id}" declares both mixin and legacy fabric; use mixin only`)
  }

  const normalized = { requires: 'observe', ...point } as InjectionPoint

  if (point.tier === 3) {
    if (!point.mixin && !point.fabric) {
      throw new Error(`forge: tier-3 point "${point.id}" requires a first-class mixin`)
    }
    const mixin = normalizeMixin(point.id, (point.mixin ?? point.fabric) as InjectionPointInput['mixin'] & {})
    normalized.mixin = mixin
    delete normalized.fabric
    const declared = capabilityFor(mixin.operation, normalized.requires)
    normalized.requires = declared
    // Engine exclusivity: a runtime-reachable service method must never be
    // transformed at load time without a documented, review-listed exemption.
    if (point.runtime && !point.engineExclusive) {
      throw new Error(
        `forge: "${point.id}" is runtime-reachable but declared tier 3; ` +
        `use tier 1/2, or set engineExclusive with documented justification`,
      )
    }
    if (point.engineExclusive) normalized.engineExclusive = true
  } else {
    if (!point.runtime) {
      throw new Error(`forge: tier-${point.tier} point "${point.id}" requires a runtime target`)
    }
    if (point.mixin || point.fabric) {
      throw new Error(`forge: point "${point.id}" is runtime tier ${point.tier}; mixin-backed points must be tier 3`)
    }
  }

  if (normalized.map) {
    for (const key of ['toEvent', 'applyEvent'] as const) {
      const fn = normalized.map[key]
      if (fn !== undefined && typeof fn !== 'function') {
        throw new Error(`forge: point "${point.id}" map.${key} must be a function`)
      }
    }
    if (normalized.map.applyEvent && !normalized.map.toEvent) {
      throw new Error(`forge: point "${point.id}" map.applyEvent requires map.toEvent`)
    }
  }
  return Object.freeze(normalized)
}

/** Alias making the event-bus semantics explicit. */
export const defineEventPoint = defineInjectionPoint

/** Validate and freeze a catalog of injection points for one official plugin. */
export function defineCatalog(catalog: CatalogInput): Readonly<Catalog> {
  if (!catalog.plugin || !catalog.versionRange) {
    throw new Error('forge: catalog requires plugin and versionRange')
  }
  const seenPoints = new Set<string>()
  const seenMixins = new Set<string>()
  const points = catalog.points.map((point) => {
    if (seenPoints.has(point.id)) throw new Error(`forge: duplicate injection point "${point.id}"`)
    seenPoints.add(point.id)
    const frozen = defineInjectionPoint(point)
    const mixinId = frozen.mixin?.id
    if (mixinId) {
      if (seenMixins.has(mixinId)) throw new Error(`forge: duplicate fabric patch id "${mixinId}"`)
      seenMixins.add(mixinId)
    }
    return frozen
  })
  return Object.freeze({ ...catalog, points })
}
