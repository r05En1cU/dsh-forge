import type { Backend, BindStatus, FabricTargetRef } from '../types.ts'
import type { RuntimeMixinOptions } from './runtime-mixin.ts'
import {
  createPatchSession,
  findFunction,
  loadTarget,
  mixinOwner,
  queryOf,
  specifiersOf,
} from './runtime-mixin.ts'
import { MODULE_EVENTS, type ModuleRecord } from '../module-events.ts'
import { createEventPhases, wrapOperation } from '../advice.ts'
import { satisfies } from '../version.ts'

function matchesRecord(target: FabricTargetRef, record: ModuleRecord): boolean {
  if (specifiersOf(target).includes(record.id)) return true
  if (record.module !== target.module) return false
  const files = target.filePath ? [target.filePath] : target.filePaths
  if (!files) return true
  const rel = record.filePath
    ?? (record.id.startsWith(`${target.module}/`) ? record.id.slice(target.module.length + 1) : undefined)
  return rel ? files.includes(rel.replace(/^\/+/, '')) : false
}

/**
 * Dedicated backend for module-level function mixins. It consumes the custom
 * `forge/module/load|reload|unload` event layer (see `module-events.ts`), so a
 * host/loader that knows about module re-evaluation can repatch fresh exports
 * synchronously — without any load-time hook.
 *
 * ESM named exports remain runtime-unreachable: the layer can repatch a CJS
 * exports object or a class prototype on the fresh handle, but it cannot
 * rewrite an ESM namespace binding.
 */
export function createModuleMixinBackend(options: RuntimeMixinOptions = {}): Backend {
  return {
    name: 'module-mixin',
    available: () => true,
    bind(ctx, point, hooks, bindOptions) {
      const mixin = point.mixin!
      const query = queryOf(mixin.target)
      if (!query.functionName && !query.expressionName) {
        return { status: 'unavailable', reason: 'module-mixin backend only handles functionName/expressionName targets' }
      }

      const session = createPatchSession(mixin, mixinOwner(ctx), (original, state) => {
        const wrapper = wrapOperation(original, mixin.operation, createEventPhases(hooks, point, ctx, bindOptions.mutate, mixin.operation)) as
          (this: unknown, ...args: unknown[]) => unknown
        return function (this: unknown, ...args: unknown[]) {
          if (!state.active) return original.apply(this, args)
          return wrapper.apply(this, args)
        }
      })

      let status: BindStatus = 'pending' as BindStatus
      let reason: string | undefined = 'module handle has not been published yet'

      const patchRecord = (record: ModuleRecord): boolean => {
        if (!matchesRecord(mixin.target, record)) return false
        if (record.version && !satisfies(record.version, mixin.target.versionRange)) {
          status = 'stale'
          reason = `module version ${record.version} does not satisfy ${mixin.target.versionRange}`
          return false
        }
        const resolution = findFunction(mixin.target, record.exports, '', options)
        if (!resolution.ok) {
          if (status === 'pending' || resolution.status !== 'pending') {
            status = resolution.status
            reason = resolution.reason
          }
          return false
        }
        const adopted = session.replaceWith(resolution.holder, resolution.key)
        if (adopted === 'bound') {
          status = 'bound'
          reason = undefined
          return true
        }
        if (adopted !== 'missing') {
          status = 'unavailable'
          reason = 'target descriptor is not writable at runtime'
        }
        return false
      }

      const tryResolution = (): void => {
        const resolution = loadTarget(mixin.target, options)
        if (!resolution.ok) {
          if (status === 'pending' || resolution.status !== 'pending') {
            status = resolution.status
            reason = resolution.reason
          }
          return
        }
        const adopted = session.replaceWith(resolution.holder, resolution.key)
        if (adopted === 'bound') {
          status = 'bound'
          reason = undefined
        } else if (adopted !== 'missing') {
          status = 'unavailable'
          reason = 'target descriptor is not writable at runtime'
        }
      }

      tryResolution()

      const offLoad = ctx.on(MODULE_EVENTS.load as any, (record: ModuleRecord) => { patchRecord(record) })
      const offReload = ctx.on(MODULE_EVENTS.reload as any, (record: ModuleRecord) => { patchRecord(record) })
      const offUnload = ctx.on(MODULE_EVENTS.unload as any, (id: string) => {
        if (!specifiersOf(mixin.target).includes(id)) return
        session.retireAll()
        status = 'pending'
        reason = `module ${id} was unpublished`
      })

      const verify = (): BindStatus => {
        if (status !== 'bound') {
          tryResolution()
          return status
        }
        const resolution = loadTarget(mixin.target, options)
        if (resolution.ok) {
          const adopted = session.replaceWith(resolution.holder, resolution.key)
          if (adopted === 'bound') return 'bound'
          if (adopted === 'unavailable') return 'unavailable'
        }
        return status
      }

      return {
        status,
        reason,
        verify,
        dispose: () => {
          offLoad()
          offReload()
          offUnload()
          session.retireAll()
        },
      }
    },
  }
}
