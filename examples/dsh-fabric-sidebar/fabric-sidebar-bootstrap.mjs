// Load-time transform hooks for the tier-3 sidebar demo. Same-copy rule:
// this MUST import the profile's physical cordis-fabric (shared bridge).
// Usage:
//   NODE_OPTIONS="--import .../fabric-sidebar-bootstrap.mjs" dsh --profile cc-tui
import { bootstrapFabric } from 'file:///home/rosen/.dsh/profiles/cc-tui/node_modules/cordis-fabric/lib/index.js'

bootstrapFabric([{
  id: 'demo/tui-sidebar',
  target: {
    module: 'dsh-cc-tui',
    versionRange: '>=0.0.0-0',
    filePath: 'lib/types/screens/Chat.js',
    functionQuery: { functionName: 'Chat', kind: 'Sync' },
  },
  operation: 'around',
  required: true,
}])
