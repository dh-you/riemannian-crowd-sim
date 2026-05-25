import { defineConfig, loadEnv } from 'vite';

declare const process: { cwd(): string; env: Record<string, string | undefined> };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    base: env.VITE_BASE_PATH || '/',
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
  };
});
