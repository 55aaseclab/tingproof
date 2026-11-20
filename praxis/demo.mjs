import { join } from 'node:path';

// The caller provides only fresh, isolated demo paths and a loopback port.
export function createDemoIntegration() {
  return {
    supported: true, module: 'praxis/demo.mjs',
    plan({ dataDir, port }) {
      return {
        steps: [{ command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] }, { command: 'npm', args: ['run', 'build'] }],
        server: { args: ['dist-server/main.js'], environment: { TINGPROOF_DATA_DIR: dataDir } },
      };
    },
  };
}
