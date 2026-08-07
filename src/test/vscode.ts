import Module from 'node:module';
import { URI } from 'vscode-uri';

/**
 * Makes `import * as vscode from 'vscode'` resolve to a stand-in, so the pure
 * parts of the extension can be tested in plain node.
 *
 * `vscode` is injected by the extension host and does not exist on disk, which
 * is normally why extensions can only be tested inside a real workbench. Only
 * the members the modules under test touch are provided here — anything else
 * throws rather than quietly returning undefined, so a test can never pass by
 * exercising a stub that does nothing.
 *
 * `Uri` is not a stub at all: `vscode-uri` is the implementation VS Code itself
 * exports, so `fsPath`, `with` and the parsing rules behave identically. That
 * matters, because path handling is most of what these tests are about.
 *
 * Import this module first — the compiler keeps `require` calls in source
 * order, so it patches before anything asks for `vscode`.
 */
const api = new Proxy(
  { Uri: URI },
  {
    get(target: Record<string, unknown>, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      // The compiler's interop helpers probe for these before anything real is
      // read; they are not part of the API surface and must not be a failure.
      if (name.startsWith('__') || name === 'default' || name === 'then') return undefined;
      throw new Error(
        `The vscode stub has no "${String(name)}". Add it in src/test/vscode.ts, ` +
          'or test something that does not reach the workbench.',
      );
    },
  },
);

interface Loader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

const loader = Module as unknown as Loader;
const original = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') return api;
  return original.call(this, request, parent, isMain);
};
