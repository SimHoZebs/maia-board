import { defineConfig } from 'vite';

// `vite build --mode profiling` swaps in React's profiling bundle so the
// DevTools Profiler works (production React strips those hooks). All other
// modes are unaffected.
export default defineConfig(({ mode }) => {
  // `MAIA_API_TARGET=http://<lan-host>:<port> npm run dev` (or preview)
  // proxies /move + /evaluate at the backend, so a local frontend runs
  // against real data and cached evaluations prime faithfully.
  const apiProxy: Record<string, string> = process.env.MAIA_API_TARGET
    ? { '/move': process.env.MAIA_API_TARGET, '/evaluate': process.env.MAIA_API_TARGET, '/evaluations': process.env.MAIA_API_TARGET, '/analyses': process.env.MAIA_API_TARGET, '/games': process.env.MAIA_API_TARGET }
    : {};
  return {
    build: {
      outDir: process.env.MAIA_BUILD_DIR || 'dist',
      emptyOutDir: true,
    },
    resolve: {
      alias:
        mode === 'profiling'
          ? [{ find: /^react-dom(\/client)?$/, replacement: 'react-dom/profiling' }]
          : [],
    },
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});
