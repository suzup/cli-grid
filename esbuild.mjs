import { context, build } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Emits the markers `.vscode/tasks.json` watches for.
 *
 * VS Code needs to know when a background build starts and finishes, otherwise
 * it warns that the task never exits. Printing our own markers keeps this
 * self-contained instead of depending on an external problem-matcher extension.
 */
const watchMarkers = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const error of result.errors) {
        const { file = '<unknown>', line = 0, column = 0 } = error.location ?? {};
        console.error(`✘ [ERROR] ${file}:${line}:${column}: ${error.text}`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  // Provided by the extension host at runtime; bundling it would break the API.
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  // In watch mode the plugin owns the output so the problem matcher sees a
  // single predictable line per error.
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [watchMarkers] : [],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
