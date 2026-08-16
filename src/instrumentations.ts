/**
 * Backwards-compatible entry: the host bootstrap seam now lives in
 * `./mixin.ts` and is re-exported from the package root as `buildPatchStubs`.
 */
export { buildPatchStubs } from './mixin.ts'
export type { FabricPatchStubLike } from './mixin.ts'
