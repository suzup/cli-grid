# CLI Grid

Run several CLI coding agents side by side — Claude Code, Codex, Gemini CLI —
without losing track of which repository each one is sitting in.

VS Code already has a file tree, git decorations, a terminal grid and per-folder
configuration. CLI Grid does not rebuild any of that. It supplies the thin
layer those pieces are missing: a binding between **an agent, a folder and a
pane**.

```
┌ CLI GRID ───────────┬──────────────────┬──────────────────┐
│ ▾ AGENTS       + ⟳  │ ✨ Claude · api   │ 🚀 Codex · api    │
│  ▾ work    main ↑2  │                  │                  │
│    ✨ api      Claude│                  │                  │
│    🚀 api      Codex ├──────────────────┼──────────────────┤
│    ▷ web      Gemini │ ⭐ Gemini · web   │                  │
│                     │                  │                  │
│ ▾ FILES  api—main ↑2│                  │                  │
│  ▾ src              │                  │                  │
│      index.ts     M │                  │                  │
│      auth.ts      U │                  │                  │
│    package.json     │                  │                  │
│                     │                  │                  │
│ ▾ LAYOUT            │                  │                  │
│ ✓ ▣▣    Auto        │                  │                  │
│   ▣▣╱▣▣ 2 × 2       │                  │                  │
└─────────────────────┴──────────────────┴──────────────────┘
```

## What it adds

Without it, launching four agents across two repositories means answering
*"Select current working directory for new terminal"* four times, ending up with
tabs named `claude`, `claude (2)` and `claude (3)`, and setting the whole thing
up again tomorrow.

- **One command per agent** — pick a folder, pick a CLI. The choice is written to
  the project, so it is there next time.
- **Tabs that say where they are** — `Claude Code · api`, not `claude (2)`.
- **Rows named after the folder they work in**, with the CLI as the description
  — the question you have looking at the list is *which repository is this*.
  Drag rows to reorder them, which also decides which pane each agent opens in,
  and use the gear for that agent's own settings: a display name, a different
  CLI, or how it starts.
- **A Files view that follows the agent you are looking at.** Select an agent —
  or just click its terminal tab — and the tree switches to the folder that CLI
  is working in, with the branch in the header.
- **`Ctrl+P` finds a file in that folder, not in the wrapper.** In a CLI Grid
  project the folder you opened is a container; the work is in the agents'
  folders, so that is where the search goes — wherever they are, including
  outside the workspace. Until an agent is focused, `Ctrl+P` is Quick Open as
  usual.
- **Real git**, from VS Code's own Git extension: branch, ahead/behind, change
  count, and the usual colours on changed files. Folders outside the workspace
  are registered explicitly, so agents pointed anywhere still get all of it.
- **Layouts that actually split** — 2 × 1, 2 × 2, 3 × 2 and so on, with the
  terminals distributed into the panes rather than stacked in the first one.
  `Auto` picks the smallest split that fits the agents you have.
- **Files open beside the grid, never inside it.** The panes holding agents are
  locked, so a file — from the Files view, quick open, or go to definition —
  lands in one pane of its own next to the grid. They are ordinary editors:
  drag the tab where you want it, split it, drag files out of the Files view.
- **Drop files into the Files view to copy them there** — from another agent's
  folder, from the Explorer, or from outside the window. Dropping on a folder
  copies into it; a name that is taken gets " copy" rather than overwriting.
- **The Explorer's operations, on that tree** — new file, new folder, rename
  (`F2`), delete to the trash, cut/copy/paste, copy path, reveal in the OS file
  manager, open in a terminal. Renaming goes through the workbench, so
  TypeScript and the like still fix up the imports that pointed at the old path,
  and it undoes with `Ctrl+Z`.

## How it is configured

CLI Grid is configured **per folder**, the same way `.vscode/settings.json` is.
There is nothing to name, nothing stored elsewhere, and nothing to find again.

```
File › Open Folder...   ~/work
```

Click the CLI Grid icon in the Activity Bar, make the folder a project, then
add agents. That writes `.vscode/cli-grid.json`:

```jsonc
{
  "layout": "auto",
  "agents": [
    { "folder": ".",   "cli": "claude" },
    { "folder": "api", "cli": "codex"  },
    { "folder": "web", "cli": "gemini", "mode": "resume", "name": "storefront" }
  ]
}
```

Reopen that folder later and everything comes back — same agents, same split.
A different set of agents is simply a different folder.

Because the file lives in the project, committing it shares the setup with your
team; adding it to `.gitignore` keeps it yours. `folder` is relative to the
project root, so `"."` is the root and `"api"` is a subdirectory — which makes
opening a parent directory full of repositories the natural shape. An absolute
path works too, for a repository that lives somewhere else entirely.

Agents are listed but **not started** until you select them, so opening a folder
never launches a CLI you did not ask for. Set `cliGrid.autoStart` for the
opposite.

## New vs resume

CLI Grid does not manage conversation state. It only chooses which arguments
to pass; the CLI owns everything after that.

| CLI | new | resume |
| --- | --- | --- |
| Claude Code | `claude` | `claude --continue` |
| Codex | `codex` | `codex resume --last` |
| Gemini | `gemini` | `gemini --resume` |

`Enter` uses the default mode; the **🕘 / +** button on each row uses the other
one. Change the default with `cliGrid.defaultMode`, per profile, or per agent
via `"mode"` in the project file.

Defaults ship as `new` because `claude --continue` exits with an error in a
folder that has no previous conversation.

## Custom CLIs

`cliGrid.profiles` is merged over the built-ins. Arguments are passed through
untouched, so anything the CLI accepts works here.

```jsonc
"cliGrid.profiles": {
  "claude": {
    "args": { "new": ["--model", "opus"], "resume": ["--continue"] },
    "defaultMode": "resume"
  },
  "gemini": { "hidden": true },
  "aider": {
    "label": "Aider",
    "command": "aider",
    "args": { "new": [], "resume": ["--restore-chat-history"] },
    "icon": "robot"
  }
}
```

## Remote, WSL and containers

The extension declares `"extensionKind": ["workspace"]`, so under Remote-WSL,
Remote-SSH or a dev container it runs on the remote side: the folder picker
browses the remote filesystem, CLI detection uses the remote `PATH`, and
terminals start on the remote machine.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `cliGrid.defaultMode` | `new` | `new` or `resume` |
| `cliGrid.launchStrategy` | `shell` | `shell` runs a login shell and types the command, so nvm/mise/`~/.local/bin` resolve. `exec` runs the binary directly for accurate exit codes. |
| `cliGrid.autoStart` | `false` | Start the folder's agents as soon as it opens |
| `cliGrid.revealOnFocus` | `true` | Point the Files view at the selected agent's folder |
| `cliGrid.showHiddenFiles` | `false` | Show dotfiles in the Files view |
| `cliGrid.lockAgentPanes` | `true` | Lock the panes holding an agent, so files open beside the grid |
| `cliGrid.profiles` | `{}` | Merged over the built-in CLI profiles |

## Development

```bash
npm install
npm run watch     # esbuild in watch mode
# then press F5 for an Extension Development Host
```

`npm run typecheck`, `npm run lint` and `npm test` cover the rest; `npm run
package` produces a `.vsix`. Changing `package.json` needs a full F5 restart
rather than `Ctrl+R`, since the manifest is read once at startup.

There are two suites: `npm test` runs in plain node, against a stand-in for the
`vscode` module, and covers layout maths, path handling, config parsing and
profile merging. `npm run test:ui` drives a real VS Code, and covers the things
only a workbench can answer — what a split produces, where a file lands, and
whether a pane holding an agent refuses one.

## Known limitations

- With `launchStrategy: shell` the terminal outlives the CLI, so an agent reads
  as "running" until you close its tab.
- Rearranging an existing grid moves terminals by walking the editor groups, as
  VS Code removed the `moveEditorToNthGroup` commands in 1.25.1. It is reliable
  but not instantaneous with many panes.
- More agents than panes wrap into tabs, so the last panes hold several agents.
- The Files view does not watch the filesystem, so a file an agent has just
  created appears after a refresh rather than on its own. Watching an arbitrary
  folder recursively is expensive on a large tree, and a cheap version of this
  is worse than none.

## License

MIT
