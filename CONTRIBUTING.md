# Contributing

Node 20+ is the only requirement — there is no native code and no Rust
toolchain.

```bash
npm install
npm run watch     # esbuild, rebuilds on save
# press F5 for an Extension Development Host
```

`Ctrl+R` reloads the host after a source change. Editing `package.json` needs a
full F5 restart, because the manifest is only read at startup.

## Checks

```bash
npm run typecheck
npm run lint
npm test           # unit, in plain node
npm run test:ui    # integration, in a real VS Code
npm run package    # produces a .vsix
```

CI runs all of these on every push and pull request.

There are two test suites, and which one a thing belongs in is decided by
whether it needs a window.

`src/test` runs in plain node. `src/test/vscode.ts` stands in for the `vscode`
module and throws on any member it has not been taught, so reaching for the real
API fails loudly rather than passing against an empty stub. This is where layout
maths, path handling, config parsing and profile merging are covered — and where
`activate` is called, to check that every command the manifest declares is
actually registered.

`src/integration` runs inside a real VS Code that `npm run test:ui` downloads on
first use. This is for claims that are only true of a workbench: that a split
produces the groups it says it does, that a file lands beside the grid, that a
pane holding an agent refuses one. On a headless machine, run it under
`xvfb-run -a`; under WSL, WSLg supplies the display already.

The extension itself is loaded in that window and applies a layout on startup,
so a new integration test should let the editor area settle before arranging
anything — see `quiet()` in `grid.test.ts`.

## Layout of the source

| File | |
| --- | --- |
| `extension.ts` | activation, and the table of what every command does |
| `commands.ts` / `config.ts` | registering commands; every setting, with its default |
| `grid.ts` | the editor area: agent panes, the file pane beside them, pane locks |
| `project.ts` | reads and writes `.vscode/cli-grid.json`, watches for changes |
| `launcher.ts` | the folder → CLI → terminal flow |
| `registry.ts` | which terminal is which agent |
| `tree.ts` | the Agents view |
| `files.ts` / `fileops.ts` | the Files view, and its Explorer-parity operations |
| `layout.ts` / `layouts.ts` | split maths; the Layout view and applying a split |
| `git.ts` | a thin read-only wrapper over the built-in Git extension's API |
| `profiles.ts` | CLI profiles and PATH detection |
| `paths.ts` | uri path arithmetic, with no workbench in it |

## Things worth knowing

- **CLI Grid never touches conversation state.** It decides which arguments to
  pass — `--continue`, `resume --last`, or nothing — and the CLI owns the rest.
  Please keep it that way.
- **Terminals launch through a login shell by default** so that CLIs installed
  via nvm, mise or `~/.local/bin` resolve. `cliGrid.launchStrategy: exec` runs
  the binary directly when accurate exit codes matter more.
- **Config paths are relative to the project root**, with `"."` meaning the root
  itself. Absolute paths are allowed for repositories elsewhere.
- **Never insert a workspace folder at index 0** — VS Code restarts the
  extension host when the first folder changes.

## Adding a CLI

Add an entry to `BUILT_IN` in `profiles.ts` with its `new` and `resume`
arguments, taken from that CLI's own documentation. Users can already do this
without a code change through `cliGrid.profiles`, so a built-in entry is only
worth it for CLIs many people use.
