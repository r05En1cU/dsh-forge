import type { Context } from '@deepseek-ai/cordis'

/**
 * Custom module lifecycle event layer for module-level function mixins.
 *
 * Runtime injection cannot observe "a deep dependency was re-evaluated" —
 * Node exposes no such event without load hooks. Hosts/loaders that DO know
 * (profile reload, bundle refresh, test runner, require-cache eviction) publish
 * these standard Cordis events; module mixin backends repatch synchronously.
 */
export const MODULE_EVENTS = {
  /** First time a module handle becomes available. */
  load: 'forge/module/load',
  /** Re-evaluation produced a fresh exports holder. */
  reload: 'forge/module/reload',
  /** The module handle is going away; snapshots are restored. */
  unload: 'forge/module/unload',
} as const

export interface ModuleRecord {
  /**
   * Stable specifier used for matching, e.g. `@pkg/lib/index.js`.
   * Should equal the mixin target's `${module}/${filePath}`.
   */
  id: string
  /** Package name, e.g. `@pkg`. */
  module: string
  /** Package-relative file path, e.g. `lib/index.js`. */
  filePath?: string
  /** Current mutable exports holder (CJS exports object / namespace object). */
  exports: unknown
  /** Installed/evaluated version; optional drift signal. */
  version?: string
}

function publish(ctx: Context, name: string, record: ModuleRecord): void {
  ;(ctx.emit as (event: string, record: ModuleRecord) => void)(name, record)
}

export function trackModule(ctx: Context, record: ModuleRecord): void {
  publish(ctx, MODULE_EVENTS.load, record)
}

export function reloadModule(ctx: Context, record: ModuleRecord): void {
  publish(ctx, MODULE_EVENTS.reload, record)
}

export function untrackModule(ctx: Context, id: string): void {
  ;(ctx.emit as (event: string, id: string) => void)(MODULE_EVENTS.unload, id)
}
