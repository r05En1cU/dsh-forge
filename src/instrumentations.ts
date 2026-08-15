import type { Catalog, FabricTargetRef, InjectionPoint } from './types.ts'

/**
 * Structural mirror of cordis-fabric's FabricPatchStub — intentionally no
 * import, so the registry stays usable without cordis-fabric installed.
 */
export interface FabricPatchStubLike {
  id: string
  target: FabricTargetRef
  operation: 'before' | 'after' | 'around' | 'replace'
  required?: boolean
}

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
export function buildPatchStubs(catalogs: (Catalog | InjectionPoint[])[]): FabricPatchStubLike[] {
  const stubs: FabricPatchStubLike[] = []
  for (const input of catalogs) {
    const points = Array.isArray(input) ? input : input.points
    for (const point of points) {
      if (point.tier !== 3 || !point.fabric) continue
      stubs.push({
        id: point.id,
        target: point.fabric.target,
        operation: point.fabric.operation,
        required: point.engineExclusive ?? false,
      })
    }
  }
  return stubs
}
