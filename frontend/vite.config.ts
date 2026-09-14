import { defineConfig, type Plugin } from 'vite';

// `vite build --mode profiling` swaps in React's profiling bundle so the
// DevTools Profiler (and our CommitRecorder) works (production React strips
// those hooks). All other modes are unaffected.
//
// React 19 ships profiling as a wrapper that requires production react-dom
// for shared internals (`ReactDOM.__DOM_INTERNALS...` at module scope), so a
// plain `react-dom -> react-dom/profiling` alias also rewrites that inner
// request and the bundle imports itself (startup crash reading internals of
// undefined). The swap is therefore importer-scoped: app code gets the
// profiling entry, while the profiling bundle's own `react-dom` request
// keeps the production copy it was built against.
function profilingSwap(): Plugin {
  const pattern = /^react-dom(\/client)?$/;
  const insideReactDom = /node_modules[/\\]react-dom[/\\]/;
  return {
    name: 'maia-board-profiling-swap',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!pattern.test(source)) return null;
      if (importer && insideReactDom.test(importer)) return null;
      return this.resolve('react-dom/profiling', importer, { skipSelf: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `MAIA_API_TARGET=http://<lan-host>:<port> npm run dev` (or preview)
  // proxies /move + /evaluate at the backend, so a local frontend runs
  // against real data and cached evaluations prime faithfully.
  const apiProxy: Record<string, string> = process.env.MAIA_API_TARGET
    ? { '/move': process.env.MAIA_API_TARGET, '/evaluate': process.env.MAIA_API_TARGET, '/evaluations': process.env.MAIA_API_TARGET, '/games': process.env.MAIA_API_TARGET }
    : {};
  return {
    build: {
      outDir: process.env.MAIA_BUILD_DIR || 'dist',
      emptyOutDir: true,
    },
    plugins: mode === 'profiling' ? [profilingSwap()] : [],
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});
