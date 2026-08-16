import type { Mixin, MixinRef, MixinTargetRef } from './types.ts'

/** One or more `/`-separated namespace segments. */
export const MIXIN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._:+-]*)+$/

function assertId(id: string): void {
  if (!MIXIN_ID_RE.test(id)) {
    throw new Error(
      `neoforge: invalid mixin id ${JSON.stringify(id)}, expected one or more '/'-separated segments matching ${MIXIN_ID_RE}`,
    )
  }
}

/**
 * Normalize a mixin reference, filling the point id when the reference omits
 * its own id. Malformed descriptors throw at definition time.
 */
export function normalizeMixin(id: string, ref: MixinRef): Readonly<Mixin> {
  assertId(id)
  const ownId = 'id' in ref ? ref.id : undefined
  if (ownId !== undefined && ownId !== id) {
    throw new Error(`neoforge: point "${id}" cannot carry mixin id "${ownId}"; omit id to inherit the point id`)
  }
  const mixin: Mixin = {
    id,
    target: ref.target,
    operation: ref.operation,
  }
  validateTarget(mixin)
  return Object.freeze(mixin)
}

/** Validate and freeze a first-class mixin declaration. */
export function defineMixin(mixin: Mixin): Readonly<Mixin> {
  return normalizeMixin(mixin.id, mixin)
}

function validateTarget(mixin: Mixin): void {
  const target: MixinTargetRef = mixin.target
  if (!target || typeof target.module !== 'string' || !target.module) {
    throw new Error(`neoforge: mixin "${mixin.id}" requires target.module`)
  }
  if (typeof target.versionRange !== 'string' || !target.versionRange) {
    throw new Error(`neoforge: mixin "${mixin.id}" requires target.versionRange`)
  }
  if (!target.functionQuery) {
    throw new Error(`neoforge: mixin "${mixin.id}" requires target.functionQuery`)
  }
  if (target.filePath && target.filePaths) {
    throw new Error(`neoforge: mixin "${mixin.id}" target.filePath and target.filePaths are mutually exclusive`)
  }
  if (!['before', 'after', 'around', 'replace'].includes(mixin.operation)) {
    throw new Error(`neoforge: mixin "${mixin.id}" has invalid operation ${JSON.stringify(mixin.operation)}`)
  }
}
