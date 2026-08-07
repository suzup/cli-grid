import { defineConfig } from '@vscode/test-cli';

/**
 * Integration tests: a real VS Code, with the extension loaded, running test
 * code inside its extension host.
 *
 * This is the only way to check the part of CLI Grid that is genuinely about
 * the workbench — how many editor groups a split produces, which one a file
 * lands in, whether a locked pane refuses one. The unit tests under
 * `src/test` cover everything that does not need a window.
 */
export default defineConfig({
  files: 'out/integration/*.test.js',
  // A clean profile, so whatever the developer has installed cannot change the
  // layout the assertions are about.
  launchArgs: ['--disable-extensions', '--disable-gpu'],
  mocha: {
    ui: 'bdd',
    // The workbench takes a moment to apply a layout, and the first run also
    // pays for downloading VS Code.
    timeout: 30_000,
  },
});
