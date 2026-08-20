import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts', './src/agent/workflow/runtime/workflowWorker.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    neverBundle: [
      '@moonshot-ai/kimi-code-oauth',
      '@moonshot-ai/kimi-telemetry',
    ],
  },
});
