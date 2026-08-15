// Load-time transform hooks for the plugin-demo TUI sidebar (tier 3).
// Same-copy rule: this MUST import the profile's physical cordis-fabric
// (shared bridge), otherwise the bootstrap stubs and the plugin's
// fabric.register() land on different bridge instances and handlers never fire.
//
// Usage:
//   NODE_OPTIONS="--import .../dsh-plugin-demo/fabric-bootstrap.mjs" dsh --profile cc-tui
import { bootstrapFabric } from 'cordis-fabric'

bootstrapFabric([{
  id: 'plugin-demo/tui-sidebar',
  target: {
    module: 'dsh-cc-tui',
    versionRange: '>=0.0.0-0',
    filePath: 'lib/types/screens/Chat.js',
    functionQuery: { functionName: 'Chat', kind: 'Sync' },
  },
  operation: 'around',
  required: true,
}])
