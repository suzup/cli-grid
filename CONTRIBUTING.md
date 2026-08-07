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
npm test
npm run package    # produces a .vsix
```

CI runs all four on every push and pull request.

The tests run in plain node, not in a workbench: `src/test/vscode.ts` stands in
for the `vscode` module, so anything that reaches the real API is out of scope
by construction. That is the point — it keeps the logic worth testing (layout
maths, path handling) in modules that do not need one. Put new logic of that
kind in `layout.ts` or `paths.ts` and it is testable for free.

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
