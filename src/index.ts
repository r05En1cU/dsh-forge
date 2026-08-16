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
export { NeoForgeService } from './service.ts'
export type { NeoForgePolicy, PointRecord, RegisterOptions } from './service.ts'
export { contractSuite } from './testkit.ts'
export type { ContractHarness } from './testkit.ts'
export { createNeoForgeRelay } from './relay.ts'
export type { NeoForgeRelayOptions } from './relay.ts'
export { createTuiHost, TUI_HOST_EXIT_EVENT } from './tui-host.ts'
export type { TuiHostOptions, TuiHostOutput, TuiHostStream } from './tui-host.ts'
export type { NeoForgeSnapshot } from './types.ts'
export {
  createUiKit,
  UIService,
  TuiService,
  h,
  Fragment,
  webuiSlotsAdapter,
  tuiPanelAdapter,
  tuiOverlayAdapter,
  tuiAdapter,
  codewhaleTuiAdapter,
  codeWhaleTuiAdapter,
  createTui,
  createCodewhaleTui,
  createCodeWhaleTui,
  asciiFallback,
  brailleAsciiFallback,
  brailleSpinnerFrame,
  formatTokenCountCompact,
  selectionMarker,
  statusMark,
  verificationTickFrame,
} from './ui/index.ts'
export type {
  ComponentDescriptor,
  LayerDescriptor,
  PageDescriptor,
  SlotDescriptor,
  StoreHandle,
  SurfaceAdapter,
  TuiPanelDescriptor,
  TuiPanelRegistration,
  TuiRegistry,
  TuiWorkRow,
  TuiRailPanel,
  TuiWorkSurfacePlacement,
  VNode,
  VNodeChild,
} from './ui/index.ts'
export { kOptOut, kPatched } from './types.ts'
export type {
  Backend,
  BindOptions,
  BindResult,
  BindStatus,
  Catalog,
  MixinOperation,
  MixinTargetRef,
  NeoForgeEvent,
  Hooks,
  InjectionPoint,
  Mixin,
  MixinRef,
  PointSource,
  RuntimeTarget,
} from './types.ts'
