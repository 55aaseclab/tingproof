import { createDemoIntegration } from './demo.mjs';
import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
export function createDeploymentIntegration() { return {
  demo: createDemoIntegration(),
  unsignedProbe: { operation: 'list_assignments', resourceId: 'assignments' },
  stack: createStackIntegration(),
  localCompose,
  "dataId": "tingproof",
  "volumes": [
    "tingproof"
  ],
  "adapterPort": 15173,
  "runtime": {
    "TINGPROOF_LEGACY_SPACE_ID": "${spaceId}",
    "TINGPROOF_MANAGED": "0",
    "TINGPROOF_BUSINESS_KEY_FILE": "/config/key",
    "TINGPROOF_DATA_DIR": "/data/tingproof"
  },
  "businessBindings": {},
  "initialFiles": [],
  "native": {
    "dockerfile": "Dockerfile.praxis",
    "command": [
      "node",
      "praxis/native-entry.mjs"
    ]
  },
  writerPorts: [5173, 15173]
}; }
