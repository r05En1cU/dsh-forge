export {
  createForge,
  getForge,
  getForgeStatus,
  defineCatalog,
  defineInjectionPoint,
  defineEventPoint,
} from './forge.ts'
export { defineMixin, buildPatchStubs, MIXIN_ID_RE } from './mixin.ts'
export type { FabricPatchStubLike } from './mixin.ts'
export { ForgeService } from './service.ts'
export type { ForgePolicy, PointRecord, RegisterOptions } from './service.ts'
export { contractSuite } from './testkit.ts'
export type { ContractHarness } from './testkit.ts'
export { createRuntimeMixinBackend, installRuntimeMixin } from './backends/runtime-mixin.ts'
export { createModuleMixinBackend } from './backends/module-mixin.ts'
export { MODULE_EVENTS, trackModule, reloadModule, untrackModule } from './module-events.ts'
export type { ModuleRecord } from './module-events.ts'
export { createForgeRelay } from './relay.ts'
export type { ForgeRelayOptions } from './relay.ts'
export type { ForgeSnapshot } from './types.ts'
export { createFabricBackend } from './backends/fabric.ts'
export { satisfies } from './version.ts'
export type { RuntimeMixinOptions } from './backends/runtime-mixin.ts'
export type { FabricBackendOptions } from './backends/fabric.ts'
export { kOptOut, kPatched } from './types.ts'
export type {
  Backend,
  BindOptions,
  BindResult,
  BindStatus,
  Catalog,
  FabricOperation,
  FabricTargetRef,
  ForgeEvent,
  Hooks,
  InjectionPoint,
  Mixin,
  MixinRef,
  PointSource,
  RuntimeTarget,
} from './types.ts'
