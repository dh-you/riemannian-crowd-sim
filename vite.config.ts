import { defineConfig } from 'vite';

export default defineConfig({
  base: '/riemannian-crowd-sim/',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        twoAgents: 'pages/two-agents.html',
        overtaking: 'pages/overtaking.html',
        bidirectional: 'pages/bidirectional.html',
        bottleneck: 'pages/bottleneck.html',
        circleAntipodal: 'pages/circle-antipodal.html',
        fpsBenchmark: 'pages/fps-benchmark.html',
      },
    },
  },
});
