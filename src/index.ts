import type { Context } from '@deepseek-ai/cordis'
import { getNeoForge } from './neoforge.ts'

/** Standard function-plugin shape: mounts the base service when the row is enabled. */
export const name = 'dsh-neoforge'

export function apply(ctx: Context): void {
  getNeoForge(ctx)
}

export {
  createNeoForge,
  getNeoForge,
  getNeoForgeStatus,
  defineCatalog,
  defineInjectionPoint,
  defineEventPoint,
} from './neoforge.ts'
export { defineMixin, buildPatchStubs, MIXIN_ID_RE } from './mixin.ts'
export type { FabricPatchStubLike } from './mixin.ts'
export { NeoForgeService } from './service.ts'
export type { NeoForgePolicy, PointRecord, RegisterOptions } from './service.ts'
export { contractSuite } from './testkit.ts'
export type { ContractHarness } from './testkit.ts'
export { createRuntimeMixinBackend, installRuntimeMixin } from './backends/runtime-mixin.ts'
export { createModuleMixinBackend } from './backends/module-mixin.ts'
export { MODULE_EVENTS, trackModule, reloadModule, untrackModule } from './module-events.ts'
export type { ModuleRecord } from './module-events.ts'
export { createNeoForgeRelay } from './relay.ts'
export type { NeoForgeRelayOptions } from './relay.ts'
export type { NeoForgeSnapshot } from './types.ts'
export { createUiKit, UIService, h, Fragment, webuiSlotsAdapter, tuiPanelAdapter } from './ui/index.ts'
export type {
  ComponentDescriptor,
  LayerDescriptor,
  PageDescriptor,
  SlotDescriptor,
  StoreHandle,
  SurfaceAdapter,
  VNode,
  VNodeChild,
} from './ui/index.ts'
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
  NeoForgeEvent,
  Hooks,
  InjectionPoint,
  Mixin,
  MixinRef,
  PointSource,
  RuntimeTarget,
} from './types.ts'
