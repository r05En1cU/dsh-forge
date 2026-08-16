import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Backend, BindResult, BindStatus, FabricTargetRef, Hooks, Mixin } from '../types.ts'
import { satisfies } from '../version.ts'
import { kOriginal, kPatched } from '../types.ts'
import { createEventPhases, createRawPhases, wrapOperation } from '../advice.ts'

export interface RuntimeMixinOptions {
  /**
   * Resolve a package specifier to a mutable exports object. Defaults to a
   * synchronous CommonJS `require(specifier)`. Override in tests, or when the
   * host already holds the target module object and wants to avoid a second
   * module instance.
   */
  resolveModule?: (specifier: string) => unknown
  /** Resolve a target module's installed version; return undefined when unreadable. */
  readVersion?: (module: string) => string | undefined
}

interface Entry {
  wrapper: Function
  state: { active: boolean }
  desc: PropertyDescriptor
}

interface FunctionQueryLike {
  className?: string
  methodName?: string
  privateMethodName?: string
  functionName?: string
  expressionName?: string
}

export type Resolution =
  | { ok: true; holder: object; key: PropertyKey; desc: PropertyDescriptor; version?: string }
  | { ok: false; status: BindStatus; reason: string }

const nodeRequire = createRequire(import.meta.url)

export function ownFunctionDesc(target: object, key: PropertyKey): PropertyDescriptor | undefined {
  const desc = Object.getOwnPropertyDescriptor(target, key)
  return desc && typeof desc.value === 'function' ? desc : undefined
}

export function queryOf(target: FabricTargetRef): FunctionQueryLike {
  return (target.functionQuery ?? {}) as FunctionQueryLike
}

export function specifiersOf(target: FabricTargetRef): string[] {
  if (target.filePath) return [`${target.module}/${target.filePath.replace(/^\/+/, '')}`]
  if (target.filePaths?.length) {
    return target.filePaths.map((file) => `${target.module}/${file.replace(/^\/+/, '')}`)
  }
  return [target.module]
}

function versionNear(resolvedPath: string): string | undefined {
  let dir = dirname(resolvedPath)
  for (;;) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).version as string | undefined
      } catch {
        return undefined
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function versionMismatch(target: FabricTargetRef, resolvedPath: string, options: RuntimeMixinOptions): Resolution | undefined {
  const version = options.readVersion?.(target.module) ?? (resolvedPath ? versionNear(resolvedPath) : undefined)
  if (version !== undefined && !satisfies(version, target.versionRange)) {
    return { ok: false, status: 'missing', reason: `installed version ${version} does not satisfy ${target.versionRange}` }
  }
  return undefined
}

function isExportsObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isModuleNamespace(value: unknown): boolean {
  return isExportsObject(value)
    && ((value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === 'Module'
      || Object.prototype.toString.call(value) === '[object Module]')
}

function getProp(value: unknown, key: PropertyKey): unknown {
  return isExportsObject(value) ? (value as Record<PropertyKey, unknown>)[key] : undefined
}

export function findFunction(target: FabricTargetRef, exports: unknown, resolvedPath: string, options: RuntimeMixinOptions): Resolution {
  const mismatch = versionMismatch(target, resolvedPath, options)
  if (mismatch) return mismatch

  const query = queryOf(target)
  if (target.astQuery && !query.functionName && !query.expressionName && !query.className && !query.methodName) {
    return { ok: false, status: 'unavailable', reason: 'astQuery targets are load-time selectors and cannot be resolved at runtime' }
  }
  if (query.privateMethodName) {
    return { ok: false, status: 'unavailable', reason: '#private methods are not runtime-reachable' }
  }

  const root = exports as Record<PropertyKey, unknown>
  const fallback = isExportsObject(root?.default) ? (root.default as Record<PropertyKey, unknown>) : undefined
  const namespace = isModuleNamespace(exports)

  // class method target: patch the prototype so every instance (including
  // existing ones) sees the wrapper on its next property lookup. This works
  // for ESM class exports too — the namespace binding stays read-only but the
  // prototype object is mutable.
  if (query.className && query.methodName) {
    let cls = getProp(root, query.className)
    if (typeof cls !== 'function' && fallback) cls = getProp(fallback, query.className)
    if (typeof cls !== 'function') {
      return { ok: false, status: 'missing', reason: `class export "${query.className}" not found` }
    }
    const ctor = cls as unknown as Record<PropertyKey, unknown>
    let holder = (ctor.prototype ?? Object.getPrototypeOf(cls)) as object
    let desc = ownFunctionDesc(holder, query.methodName)
    if (!desc) {
      holder = cls as object
      desc = ownFunctionDesc(holder, query.methodName)
    }
    if (!desc) {
      return { ok: false, status: 'missing', reason: `method "${query.className}.${query.methodName}" not found` }
    }
    return { ok: true, holder, key: query.methodName, desc }
  }

  // bare method target: exactly one exported class/object may carry it.
  if (query.methodName) {
    const candidates: { holder: object; key: PropertyKey; desc: PropertyDescriptor }[] = []
    const scan = (value: unknown) => {
      if (!isExportsObject(value)) return
      const record = value as Record<PropertyKey, unknown>
      for (const key of Reflect.ownKeys(record)) {
        const member = record[key]
        if (typeof member === 'function') {
          const proto = (member as { prototype?: unknown }).prototype
          if (proto && isExportsObject(proto)) {
            const desc = ownFunctionDesc(proto as object, query.methodName!)
            if (desc) candidates.push({ holder: proto as object, key: query.methodName!, desc })
          }
          const staticDesc = ownFunctionDesc(member as object, query.methodName!)
          if (staticDesc) candidates.push({ holder: member as object, key: query.methodName!, desc: staticDesc })
        } else if (isExportsObject(member)) {
          const desc = ownFunctionDesc(member as object, query.methodName!)
          if (desc) candidates.push({ holder: member as object, key: query.methodName!, desc })
        }
      }
    }
    scan(root)
    scan(fallback)
    if (candidates.length === 1) {
      const [candidate] = candidates
      return { ok: true, ...candidate }
    }
    if (candidates.length === 0) {
      return { ok: false, status: 'missing', reason: `method "${query.methodName}" not found on any export` }
    }
    return { ok: false, status: 'missing', reason: `method "${query.methodName}" is ambiguous across exports; declare className` }
  }

  const name = query.functionName ?? query.expressionName
  if (name) {
    if (namespace) {
      return {
        ok: false,
        status: 'unavailable',
        reason: `ESM named export "${name}" is a read-only namespace binding; declare a class method target or a CJS export`,
      }
    }
    const desc = ownFunctionDesc(root, name) ?? (fallback ? ownFunctionDesc(fallback, name) : undefined)
    if (!desc) {
      return { ok: false, status: 'missing', reason: `function export "${name}" not found` }
    }
    return { ok: true, holder: fallback && ownFunctionDesc(root, name) === undefined ? fallback : root, key: name, desc }
  }

  return { ok: false, status: 'unavailable', reason: 'functionQuery shape is not runtime-resolvable' }
}

/** Load a mutable CommonJS exports object synchronously. */
export function loadTarget(target: FabricTargetRef, options: RuntimeMixinOptions): Resolution {
  const specs = specifiersOf(target)
  let lastError: string | undefined
  let lastStatus: BindStatus | undefined
  for (const specifier of specs) {
    let exports: unknown
    if (options.resolveModule) {
      exports = options.resolveModule(specifier)
      if (exports === undefined) {
        lastError = `resolver returned no object for ${specifier}`
        lastStatus = 'pending'
        continue
      }
    } else {
      let resolvedPath: string
      try {
        resolvedPath = nodeRequire.resolve(specifier)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'MODULE_NOT_FOUND') {
          lastError = `module ${specifier} is not resolvable yet`
          lastStatus = 'pending'
          continue
        }
        if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
          return { ok: false, status: 'missing', reason: `package path ${specifier} is not exported` }
        }
        return { ok: false, status: 'unavailable', reason: `cannot resolve ${specifier}: ${(error as Error).message}` }
      }
      try {
        exports = nodeRequire(resolvedPath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
          return {
            ok: false,
            status: 'unavailable',
            reason: `${specifier} is an ESM namespace; runtime mixins can only patch CJS exports or class prototypes reachable through a Cordis service`,
          }
        }
        return { ok: false, status: 'unavailable', reason: `cannot load ${specifier}: ${(error as Error).message}` }
      }
      try {
        const resolvedPath = nodeRequire.resolve(specifier)
        const resolution = findFunction(target, exports, resolvedPath, options)
        if (resolution.ok) return resolution
        lastError = resolution.reason
        lastStatus = resolution.status
        if (resolution.status === 'missing') continue   // try the next filePaths entry
        return resolution
      } catch (error) {
        return { ok: false, status: 'unavailable', reason: `cannot resolve ${specifier}: ${(error as Error).message}` }
      }
    }
    // custom resolver path has no file path for package.json discovery; version
    // check still runs through options.readVersion below.
    if (exports !== undefined && exports !== null) {
      const resolution = findFunction(target, exports, '', options)
      if (resolution.ok || resolution.status !== 'missing') return resolution
      lastError = resolution.reason
      lastStatus = resolution.status
      continue
    }
  }
  return {
    ok: false,
    status: lastStatus === 'missing' ? 'missing' : 'pending',
    reason: lastError ?? 'target module is not loaded yet',
  }
}

function describeTarget(holder: object, key: PropertyKey): string {
  const name = (holder as { name?: unknown }).name
  const ctor = (holder as { constructor?: { name?: unknown } }).constructor?.name
  const prefix = typeof name === 'string' && name ? name : ctor ?? 'object'
  return `${prefix}.${String(key)}`
}

/** Snapshot/restore patch session with exclusive target ownership. */
export function createPatchSession(
  mixin: Mixin,
  owner: unknown,
  wrap: (original: Function, state: { active: boolean }) => Function,
) {
  const patched = new Map<object, Map<PropertyKey, Entry>>()

  type AttachResult = 'bound' | 'missing' | 'unavailable'

  const attach = (holder: object, key: PropertyKey): AttachResult => {
    const desc = ownFunctionDesc(holder, key)
    if (!desc) return 'missing'
    const existing = patched.get(holder)?.get(key)
    if (existing) return 'bound'
    const mark = (desc.value as { [kPatched]?: { id?: unknown; owner?: unknown } } | undefined)?.[kPatched]
    if (mark) {
      if (mark.id === mixin.id && mark.owner === owner) return 'bound'
      throw new Error(
        `neoforge: runtime mixin "${mixin.id}" conflicts with "${String(mark.id)}" on ` +
        `${describeTarget(holder, key)} — a runtime patch target is exclusive; ` +
        `the same target cannot be patched by multiple third-party packages`,
      )
    }
    const orig = desc.value
    const state = { active: true }
    const wrapper = wrap(orig, state)
    Object.defineProperty(wrapper, kPatched, {
      value: { id: mixin.id, owner, original: orig, holder, key },
      configurable: true,
    })
    try {
      Object.defineProperty(holder, key, { ...desc, value: wrapper })
    } catch {
      return 'unavailable'
    }
    let table = patched.get(holder)
    if (!table) patched.set(holder, (table = new Map()))
    table.set(key, { wrapper, state, desc })
    return 'bound'
  }

  const retire = (holder: object, key: PropertyKey) => {
    const entry = patched.get(holder)?.get(key)
    if (!entry) return
    const current = Object.getOwnPropertyDescriptor(holder, key)
    if (current?.value === entry.wrapper) {
      Object.defineProperty(holder, key, entry.desc)   // restore the exact snapshot
    } else {
      entry.state.active = false                        // another layer is on top: go inert
    }
    patched.get(holder)!.delete(key)
    if (patched.get(holder)!.size === 0) patched.delete(holder)
  }

  const retireAll = () => {
    for (const [holder, table] of [...patched]) {
      for (const key of [...table.keys()]) retire(holder, key)
    }
  }

  const replaceWith = (holder: object, key: PropertyKey): 'bound' | 'missing' | 'unavailable' => {
    const old = [...patched.keys()]
    const result = attach(holder, key)
    if (result !== 'bound') return result
    for (const oldHolder of old) {
      if (oldHolder !== holder) {
        for (const oldKey of [...(patched.get(oldHolder)?.keys() ?? [])]) retire(oldHolder, oldKey)
      }
    }
    return 'bound'
  }

  return { attach, retireAll, replaceWith }
}

export function mixinOwner(ctx: Context): unknown {
  const fiber = ctx.fiber as { entry?: unknown; runtime?: { callback?: unknown } }
  return fiber.entry ?? fiber.runtime?.callback ?? ctx.fiber
}

function canUseServiceFallback(target: FabricTargetRef): boolean {
  const query = queryOf(target)
  return !!(query.methodName && !query.privateMethodName)
}

/**
 * Runtime mixin backend: instead of load-time AST transformation it resolves
 * the target module synchronously at registration/verify time, snapshots the
 * exact property descriptor, installs a wrapper, and restores that snapshot on
 * unload. CJS exports and class prototypes are mutable and fully supported;
 * ESM namespace bindings and `#private` members are runtime-unreachable and
 * report `unavailable` loudly.
 */
export function createRuntimeMixinBackend(options: RuntimeMixinOptions = {}): Backend {
  return {
    name: 'runtime-mixin',
    available: () => true,
    bind(ctx, point, hooks, bindOptions) {
      const mixin = point.mixin!
      const operation = mixin.operation
      const query = queryOf(mixin.target)
      const session = createPatchSession(mixin, mixinOwner(ctx), (original, state) => {
        const wrapper = wrapOperation(original, operation, createEventPhases(hooks, point, ctx, bindOptions.mutate, operation)) as
          (this: unknown, ...args: unknown[]) => unknown
        return function (this: unknown, ...args: unknown[]) {
          if (!state.active) return original.apply(this, args)
          return wrapper.apply(this, args)
        }
      })

      let status: BindStatus = 'pending' as BindStatus
      let reason: string | undefined = 'target module has not been resolved yet'
      let serviceDispose: (() => boolean) | undefined

      const tryAttachService = (value: unknown): boolean => {
        if (!canUseServiceFallback(mixin.target) || !value) return false
        const raw = (value as { [kOriginal]?: unknown })?.[kOriginal] ?? value
        if ((typeof raw !== 'object' || raw === null) && typeof raw !== 'function') return false
        const proto = Object.getPrototypeOf(raw)
        if (!proto || proto === Object.prototype) return false
        if (query.className && (proto as { constructor?: { name?: string } }).constructor?.name !== query.className) return false
        const method = query.methodName!
        const desc = ownFunctionDesc(proto, method)
        if (!desc) return false
        const bound = session.replaceWith(proto, method)
        if (bound === 'bound') {
          status = 'bound'
          reason = undefined
        }
        return bound === 'bound'
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
        const bound = session.replaceWith(resolution.holder, resolution.key)
        if (bound === 'bound') {
          status = 'bound'
          reason = undefined
        } else if (bound !== 'missing') {
          status = 'unavailable'
          reason = 'target descriptor is not writable at runtime'
        }
      }

      tryResolution()
      if (canUseServiceFallback(mixin.target)) {
        // Always keep this listener: HMR re-imports produce a NEW class and
        // `internal/service` is the official synchronous generation signal.
        serviceDispose = ctx.on('internal/service', (_name, value) => {
          if (value) tryAttachService(value)
        })
      }

      const verify = (): BindStatus => {
        if (status !== 'bound') {
          tryResolution()
          return status
        }
        // Bound targets still refresh on verify(): a module re-evaluation can
        // expose a new holder; adopt it and retire the stale snapshot.
        const resolution = loadTarget(mixin.target, options)
        if (resolution.ok) {
          const adopted = session.replaceWith(resolution.holder, resolution.key)
          if (adopted === 'bound') return 'bound'
          if (adopted === 'unavailable') return 'unavailable'
        }
        const version = options.readVersion?.(mixin.target.module)
        if (version !== undefined && !satisfies(version, mixin.target.versionRange)) return 'stale'
        return status
      }

      return {
        status,
        reason,
        verify,
        dispose: () => {
          serviceDispose?.()
          session.retireAll()
        },
      }
    },
  }
}

interface RawCall {
  arguments: unknown[]
  self: unknown
  result?: unknown
}

/**
 * Low-level runtime mixin registration without event projection. The handler
 * receives the same `(call, invoke?)` contract as cordis-fabric and the patch
 * is snapshot/restore based, owned by the calling fiber through `ctx.effect`.
 */
export function installRuntimeMixin(ctx: Context, mixin: Mixin, handler: (call: RawCall, invoke?: () => unknown) => unknown, options: RuntimeMixinOptions = {}): BindResult {
  const phases = createRawPhases(handler)
  const session = createPatchSession(mixin, mixinOwner(ctx), (original, state) => {
    const wrapper = wrapOperation(original, mixin.operation, phases) as
      (this: unknown, ...args: unknown[]) => unknown
    return function (this: unknown, ...args: unknown[]) {
      if (!state.active) return original.apply(this, args)
      return wrapper.apply(this, args)
    }
  })

  let status: BindStatus = 'pending' as BindStatus
  let reason: string | undefined = 'target module has not been resolved yet'
  let serviceDispose: (() => boolean) | undefined

  const tryAttachService = (value: unknown): boolean => {
    if (!canUseServiceFallback(mixin.target) || !value) return false
    const raw = (value as { [kOriginal]?: unknown })?.[kOriginal] ?? value
    if ((typeof raw !== 'object' || raw === null) && typeof raw !== 'function') return false
    const query = queryOf(mixin.target)
    const proto = Object.getPrototypeOf(raw)
    if (!proto || proto === Object.prototype) return false
    if (query.className && (proto as { constructor?: { name?: string } }).constructor?.name !== query.className) return false
    const method = query.methodName!
    const desc = ownFunctionDesc(proto, method)
    if (!desc) return false
    const bound = session.replaceWith(proto, method)
    if (bound === 'bound') {
      status = 'bound'
      reason = undefined
    }
    return bound === 'bound'
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
    const bound = session.replaceWith(resolution.holder, resolution.key)
    if (bound === 'bound') {
      status = 'bound'
      reason = undefined
    } else if (bound !== 'missing') {
      status = 'unavailable'
      reason = 'target descriptor is not writable at runtime'
    }
  }

  tryResolution()
  if (canUseServiceFallback(mixin.target)) {
    serviceDispose = ctx.on('internal/service', (_name, value) => {
      if (value) tryAttachService(value)
    })
  }

  return {
    status,
    reason,
    verify: () => {
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
    },
    dispose: () => {
      serviceDispose?.()
      session.retireAll()
    },
  }
}
