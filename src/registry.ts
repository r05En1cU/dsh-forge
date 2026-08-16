import type {
  Catalog,
  CatalogInput,
  FabricOperation,
  InjectionPoint,
  InjectionPointInput,
  Mixin,
  PointSource,
} from './types.ts'
import { MIXIN_ID_RE, normalizeMixin } from './mixin.ts'

const CAPABILITY: Record<FabricOperation, ReadonlySet<InjectionPoint['requires']>> = {
  before: new Set(['observe', 'mutate']),
  after: new Set(['observe', 'mutate', 'replace']),
  around: new Set(['mutate', 'replace']),
  replace: new Set(['replace']),
}

type Capability = NonNullable<InjectionPoint['requires']>

function capabilityFor(operation: FabricOperation, declared: InjectionPoint['requires']): Capability {
  const allowed = CAPABILITY[operation]
  const actual = declared ?? 'observe'
  if (!allowed.has(actual)) {
    throw new Error(
      `forge: operation "${operation}" does not allow requires ${JSON.stringify(actual)}; allowed: ${[...allowed].join(', ')}`,
    )
  }
  return actual
}

function tierFor(source: PointSource): InjectionPoint['tier'] {
  switch (source.kind) {
    case 'event': return 0
    case 'view': return 1
    case 'service': return 2
    case 'mixin':
    case 'fabric': return 3
  }
}

/** Infer a semantic source from the legacy tier/runtime/mixin/fabric fields. */
function inferSource(point: InjectionPointInput): PointSource {
  if (point.tier === 1) {
    if (!point.runtime) throw new Error(`forge: tier-1 point "${point.id}" requires a runtime target`)
    return { kind: 'view', service: point.runtime.service, method: point.runtime.method }
  }
  if (point.tier === 2) {
    if (!point.runtime) throw new Error(`forge: tier-2 point "${point.id}" requires a runtime target`)
    return { kind: 'service', service: point.runtime.service, method: point.runtime.method }
  }
  if (point.tier === 3) {
    const legacy = point.mixin ?? point.fabric
    if (!legacy) throw new Error(`forge: tier-3 point "${point.id}" requires a first-class mixin`)
    return {
      kind: point.mixin ? 'mixin' : 'fabric',
      target: legacy.target,
      operation: legacy.operation,
      priority: legacy.priority,
      required: legacy.required,
    }
  }
  throw new Error(
    `forge: point "${point.id}" must declare source, or legacy tier 1/2/3 with runtime/mixin`,
  )
}

function isConsistentNormalized(point: InjectionPointInput): boolean {
  if (!point.source) return false
  const source = point.source
  if (point.tier !== tierFor(source)) return false
  switch (source.kind) {
    case 'event':
      return !point.runtime && !point.mixin && !point.fabric
    case 'view':
    case 'service':
      return point.runtime?.service === source.service
        && point.runtime.method === source.method
        && !point.mixin && !point.fabric
    case 'mixin':
    case 'fabric':
      return point.mixin !== undefined
        && ('id' in point.mixin ? point.mixin.id === point.id : true)
        && point.mixin.operation === source.operation
        && (!point.runtime || !!point.engineExclusive)
        && !point.fabric
  }
}

function validateMap(point: InjectionPointInput): void {
  if (!point.map) return
  for (const key of ['toEvent', 'applyEvent'] as const) {
    const fn = point.map[key]
    if (fn !== undefined && typeof fn !== 'function') {
      throw new Error(`forge: point "${point.id}" map.${key} must be a function`)
    }
  }
  if (point.map.applyEvent && !point.map.toEvent) {
    throw new Error(`forge: point "${point.id}" map.applyEvent requires map.toEvent`)
  }
}

/**
 * Validate and freeze an injection point declaration. Semantic `source` is
 * canonical; legacy `tier/runtime/mixin/fabric` fields are normalized here so
 * old catalogs keep working unchanged.
 */
export function defineInjectionPoint(point: InjectionPointInput): Readonly<InjectionPoint> {
  if (!MIXIN_ID_RE.test(point.id)) {
    throw new Error(`forge: invalid injection point id ${JSON.stringify(point.id)}, expected 'namespace/action'`)
  }
  if (point.mixin && point.fabric) {
    throw new Error(`forge: point "${point.id}" declares both mixin and legacy fabric; use mixin only`)
  }
  if (point.source && (point.tier !== undefined || point.runtime || point.mixin || point.fabric)) {
    // defineCatalog / createForge routinely re-validate already-normalized
    // points; accept them when the legacy fields are exactly the derived view.
    if (!isConsistentNormalized(point)) {
      throw new Error(`forge: point "${point.id}" declares source together with inconsistent legacy target fields; choose one`)
    }
  }

  const source: PointSource = point.source ?? inferSource(point)
  let mixin: Readonly<Mixin> | undefined
  let runtime: InjectionPoint['runtime']
  let requires: Capability = point.requires ?? 'observe'

  switch (source.kind) {
    case 'event': {
      if (typeof source.event !== 'string' || !source.event) {
        throw new Error(`forge: point "${point.id}" event source requires a non-empty event name`)
      }
      if (requires !== 'observe') {
        throw new Error(`forge: point "${point.id}" aliases an official event and cannot declare mutating power`)
      }
      if (point.map?.applyEvent) {
        throw new Error(`forge: point "${point.id}" event aliases cannot write back; remove map.applyEvent`)
      }
      break
    }
    case 'view':
    case 'service': {
      if (!source.service || !source.method) {
        throw new Error(`forge: point "${point.id}" ${source.kind} source requires service and method`)
      }
      runtime = { service: source.service, method: source.method }
      break
    }
    case 'mixin':
    case 'fabric': {
      mixin = normalizeMixin(point.id, source)
      requires = capabilityFor(mixin.operation, requires)
      // Legacy guard: a runtime-reachable service method must never go through
      // a load-time bridge without a documented, review-listed exemption.
      if (point.runtime && !point.engineExclusive) {
        throw new Error(
          `forge: "${point.id}" is runtime-reachable but declared ${source.kind}; ` +
          `use a service/view source, or set engineExclusive with documented justification`,
        )
      }
      break
    }
  }

  validateMap(point)

  const normalized: InjectionPoint = {
    id: point.id,
    source,
    tier: tierFor(source),
    runtime,
    mixin,
    requires,
    map: point.map,
    engineExclusive: point.engineExclusive,
    versionRange: point.versionRange,
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
