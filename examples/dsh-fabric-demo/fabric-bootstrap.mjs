// Host-wiring substitute: install fabric's load-time transformation hooks
// before any dsh module is imported. Usage:
//   NODE_OPTIONS="--import /home/rosen/workspace/dsh_forge/examples/dsh-fabric-demo/fabric-bootstrap.mjs" dsh --profile cc-tui
//
// CRITICAL: import the SAME physical cordis-fabric copy the in-profile plugin
// resolves. Two copies = two runtime/bridge listener sets = handlers never fire.
import { appendFileSync } from 'node:fs'
import { bootstrapFabric } from 'file:///home/rosen/.dsh/profiles/cc-tui/node_modules/cordis-fabric/lib/index.js'

bootstrapFabric([{
  id: 'demo/permission-fold',
  target: {
    module: '@deepseek-ai/dsh-permission-presets',
    versionRange: '>=0.0.0-0',
    filePath: 'lib/index.js',
    functionQuery: { functionName: 'effectivePermissionPreset', kind: 'Sync' },
  },
  operation: 'after',
  required: true,
}])

appendFileSync('/home/rosen/.dsh/fabric-demo.log', `${new Date().toISOString()} transformation hooks installed\n`)
