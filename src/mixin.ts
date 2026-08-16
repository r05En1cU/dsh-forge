import type { CatalogInput, FabricOperation, FabricTargetRef, InjectionPointInput, Mixin, MixinRef } from './types.ts'

/** Same id grammar as cordis-fabric: one or more `/`-separated namespace segments. */
export const MIXIN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._:+-]*)+$/

/**
 * Structural mirror of cordis-fabric's FabricPatchStub — intentionally no
 * runtime import, so the registry stays usable without cordis-fabric installed.
 */
export interface FabricPatchStubLike {
  id: string
  target: FabricTargetRef
  operation: FabricOperation
  required?: boolean
  priority?: number
}

function assertId(id: string, what: string): void {
  if (!MIXIN_ID_RE.test(id)) {
    throw new Error(
      `forge: invalid ${what} ${JSON.stringify(id)}, expected one or more '/'-separated segments matching ${MIXIN_ID_RE}`,
    )
  }
}

/**
 * Normalize a mixin reference, filling the point id when the reference omits
 * its own id. The normalized mixin is frozen; malformed descriptors throw at
 * definition time, never silently at runtime.
 */
export function normalizeMixin(id: string, ref: MixinRef): Readonly<Mixin> {
  assertId(id, 'mixin id')
  const ownId = 'id' in ref ? ref.id : undefined
  if (ownId !== undefined && ownId !== id) {
    throw new Error(`forge: point "${id}" cannot carry mixin id "${ownId}"; omit id to inherit the point id`)
  }
  const mixin: Mixin = {
    id,
    target: ref.target,
    operation: ref.operation,
    priority: ref.priority,
    required: ref.required,
  }
  if (!mixin.target || typeof mixin.target.module !== 'string' || !mixin.target.module) {
    throw new Error(`forge: mixin "${id}" requires target.module`)
  }
  if (typeof mixin.target.versionRange !== 'string' || !mixin.target.versionRange) {
    throw new Error(`forge: mixin "${id}" requires target.versionRange`)
  }
  if (!mixin.target.functionQuery && !mixin.target.astQuery) {
    throw new Error(`forge: mixin "${id}" requires target.functionQuery or target.astQuery`)
  }
  if (mixin.target.filePath && mixin.target.filePaths) {
    throw new Error(`forge: mixin "${id}" target.filePath and target.filePaths are mutually exclusive`)
  }
  if (!['before', 'after', 'around', 'replace'].includes(mixin.operation)) {
    throw new Error(`forge: mixin "${id}" has invalid operation ${JSON.stringify(mixin.operation)}`)
  }
  return Object.freeze(mixin)
}

/** Validate and freeze a first-class mixin declaration. */
export function defineMixin(mixin: Mixin): Readonly<Mixin> {
  return normalizeMixin(mixin.id, mixin)
}

function toStub(mixin: Mixin): FabricPatchStubLike {
  return {
    id: mixin.id,
    target: mixin.target,
    operation: mixin.operation,
    required: mixin.required,
    priority: mixin.priority,
  }
}

/**
 * Optional compatibility exit: compile catalogs / event points / raw mixins
 * into static cordis-fabric patch stubs. The default runtime-mixin backend
 * does NOT need this — only targets that are runtime-unreachable (ESM
 * module-level functions, `#private`, closures, browser bundles) still use a
 * load-time bridge:
 *
 *   import { bootstrapFabric } from 'cordis-fabric'
 *   const disposeHooks = bootstrapFabric(buildPatchStubs([catalog]))
 *
 * Only `kind: 'fabric'` points (or legacy `fabric` fields) produce stubs;
 * runtime mixins need no load-time work. `required` mixins fail startup
 * loudly when they bound nothing.
 */
export function buildPatchStubs(inputs: readonly (CatalogInput | InjectionPointInput[] | Mixin | Mixin[])[]): FabricPatchStubLike[] {
  const stubs: FabricPatchStubLike[] = []
  const seen = new Set<string>()
  const push = (mixin: Mixin, forceRequired = false) => {
    if (seen.has(mixin.id)) {
      throw new Error(`forge: duplicate fabric patch id "${mixin.id}" in buildPatchStubs`)
    }
    seen.add(mixin.id)
    const stub = toStub(mixin)
    if (forceRequired) stub.required = true
    stubs.push(stub)
  }

  for (const input of inputs) {
    if (Array.isArray(input)) {
      if (input.length === 0) continue
      const first = input[0] as InjectionPointInput | Mixin
      if (first && typeof first === 'object' && 'operation' in first && 'target' in first && !('tier' in first)) {
        for (const mixin of input as Mixin[]) push(normalizeMixin(mixin.id, mixin))
      } else {
        for (const point of input as InjectionPointInput[]) {
          if (point.source?.kind === 'fabric') {
            push(normalizeMixin(point.id, point.source), point.engineExclusive)
          } else if (point.fabric) {
            push(normalizeMixin(point.id, point.fabric), point.engineExclusive)
          }
        }
      }
    } else if ('points' in input) {
      for (const point of input.points) {
        if (point.source?.kind === 'fabric') {
          push(normalizeMixin(point.id, point.source), point.engineExclusive)
        } else if (point.fabric) {
          push(normalizeMixin(point.id, point.fabric), point.engineExclusive)
        }
      }
    } else {
      const mixin = input as Mixin
      push(normalizeMixin(mixin.id, mixin))
    }
  }
  return stubs
}
