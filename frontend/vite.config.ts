import { defineConfig } from 'vite';

// `vite build --mode profiling` swaps in React's profiling bundle so the
// DevTools Profiler works (production React strips those hooks). All other
// modes are unaffected.
export default defineConfig(({ mode }) => ({
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
  // `MAIA_API_TARGET=http://<lan-host>:<port> npx vite preview --outDir dist-profiling`
  // serves the profiling build with /move + /evaluate proxied at the backend,
  // so cached evaluations prime and render costs reproduce faithfully.
  preview: process.env.MAIA_API_TARGET
    ? { proxy: { '/move': process.env.MAIA_API_TARGET, '/evaluate': process.env.MAIA_API_TARGET, '/evaluations': process.env.MAIA_API_TARGET, '/analyses': process.env.MAIA_API_TARGET, '/games': process.env.MAIA_API_TARGET } }
    : {},
}));
