/**
 * Optional load-time compatibility exit. The active tier-3 path is the
 * runtime-mixin backend; this entry only exists for hosts that still choose
 * to bootstrap cordis-fabric for runtime-unreachable targets.
 */
export { buildPatchStubs } from './mixin.ts'
export type { FabricPatchStubLike } from './mixin.ts'
