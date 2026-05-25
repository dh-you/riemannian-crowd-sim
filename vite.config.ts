import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        twoAgents: resolve(__dirname, 'pages/two-agents.html'),
        overtaking: resolve(__dirname, 'pages/overtaking.html'),
        bidirectional: resolve(__dirname, 'pages/bidirectional.html'),
        bottleneck: resolve(__dirname, 'pages/bottleneck.html'),
        circleAntipodal: resolve(__dirname, 'pages/circle-antipodal.html'),
        fpsBenchmark: resolve(__dirname, 'pages/fps-benchmark.html'),
      },
    },
  },
});
