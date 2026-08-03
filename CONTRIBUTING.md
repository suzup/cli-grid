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
npm run package    # produces a .vsix
```

CI runs the first two on every release tag.

## Layout of the source

| File | |
| --- | --- |
| `extension.ts` | activation and command wiring |
| `project.ts` | reads and writes `.vscode/agentry.json`, watches for changes |
| `launcher.ts` | the folder → CLI → terminal flow |
| `registry.ts` | which terminal is which agent |
| `tree.ts` | the Agents view |
| `files.ts` | the Files view, scoped to the focused agent |
| `layout.ts` / `layoutView.ts` | splits, pane assignment, the Layout view |
| `git.ts` | a thin read-only wrapper over the built-in Git extension's API |
| `profiles.ts` | CLI profiles and PATH detection |

## Things worth knowing

- **Agentry never touches conversation state.** It decides which arguments to
  pass — `--continue`, `resume --last`, or nothing — and the CLI owns the rest.
  Please keep it that way.
- **Terminals launch through a login shell by default** so that CLIs installed
  via nvm, mise or `~/.local/bin` resolve. `agentry.launchStrategy: exec` runs
  the binary directly when accurate exit codes matter more.
- **Config paths are relative to the project root**, with `"."` meaning the root
  itself. Absolute paths are allowed for repositories elsewhere.
- **Never insert a workspace folder at index 0** — VS Code restarts the
  extension host when the first folder changes.

## Adding a CLI

Add an entry to `BUILT_IN` in `profiles.ts` with its `new` and `resume`
arguments, taken from that CLI's own documentation. Users can already do this
without a code change through `agentry.profiles`, so a built-in entry is only
worth it for CLIs many people use.
