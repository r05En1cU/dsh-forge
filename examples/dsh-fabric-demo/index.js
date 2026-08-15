// dsh-fabric-demo: tier-3 source patch on a REAL official package.
// Target: effectivePermissionPreset(events) — a module-level function in
// @deepseek-ai/dsh-permission-presets (no service, no prototype → genuinely
// runtime-unreachable, a legitimate tier-3 case).
//
// Two halves:
//   fabric-bootstrap.mjs — installed via NODE_OPTIONS=--import BEFORE any dsh
//     code loads; transforms the target at load time (host-wiring substitute).
//   this plugin — mounts the fabric registry and binds a handler that appends
//     a marker line on every fold call.
import { appendFileSync } from 'node:fs'
import { FabricService } from 'cordis-fabric'

export const name = 'dsh-fabric-demo'

export const MARKER = '/home/rosen/.dsh/fabric-demo.log'

export function apply(ctx) {
  const fabric = new FabricService(ctx)
  fabric.register({
    id: 'demo/permission-fold',
    target: {
      module: '@deepseek-ai/dsh-permission-presets',
      versionRange: '>=0.0.0-0',
      filePath: 'lib/index.js',
      functionQuery: { functionName: 'effectivePermissionPreset', kind: 'Sync' },
    },
    operation: 'after',
    handler(call) {
      try {
        appendFileSync(MARKER, `${new Date().toISOString()} fold → ${String(call.result)}\n`)
      } catch {}
    },
  })
  ctx.logger('fabric-demo').info('source patch handler registered')
  try { appendFileSync(MARKER, `${new Date().toISOString()} handler registered (bindings: ${JSON.stringify(fabric.list().map(p => p.bindings))})\n`) } catch {}
  // bindings flush when the target module loads, which may be after our apply
  setTimeout(() => {
    try { appendFileSync(MARKER, `${new Date().toISOString()} bindings@5s: ${JSON.stringify(fabric.list().map(p => p.bindings))}\n`) } catch {}
  }, 5000)
}
