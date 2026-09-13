# CLI Grid

Run several CLI coding agents side by side — Claude Code, Codex, Gemini CLI —
without losing track of which repository each one is sitting in.

VS Code already has a file tree, git decorations, a terminal grid and per-folder
configuration. CLI Grid does not rebuild any of that. It supplies the thin
layer those pieces are missing: a binding between **an agent, a folder and a
pane**.

```
┌ CLI GRID ───────────┬──────────────────┬──────────────────┐
│ ▾ AGENTS       + ⟳  │ ✨ api · Claude   │ 🚀 api · Codex    │
│  ▾ work    main ↑2  │                  │                  │
│    ✨ api      Claude│                  │                  │
│    🚀 api      Codex ├──────────────────┼──────────────────┤
│    ▷ web      Gemini │ ⭐ web · Gemini   │                  │
│                     │                  │                  │
│ ▾ LAYOUT            │                  │                  │
│ ✓ ▣▣    Auto        │                  │                  │
│   ▣▣╱▣▣ 2 × 2       │                  │                  │
│                     │                  │                  │
│ ▾ EXPLORER          │                  │                  │
│  ▸ work             │                  │                  │
│  ▸ api              │  ← the agents'   │                  │
│  ▸ web              │    folders, open │                  │
└─────────────────────┴──────────────────┴──────────────────┘
```

## What it adds

Without it, launching four agents across two repositories means answering
*"Select current working directory for new terminal"* four times, ending up with
tabs named `claude`, `claude (2)` and `claude (3)`, and setting the whole thing
up again tomorrow.

- **One command per agent** — pick a folder, pick a CLI. The choice is written to
  the project, so it is there next time.
- **Tabs that say where they are** — `api · Claude Code`, not `claude (2)`.
- **Rows named after the folder they work in**, with the CLI as the description
  — the question you have looking at the list is *which repository is this*.
  Drag rows to reorder them, which also decides which pane each agent opens in,
  and use the gear for that agent's own settings: a display name, a different
  CLI, or how it starts.
- **Every agent's folder is a folder of the window.** Adding an agent adds its
  folder to the workspace, so the Explorer shows it, Source Control lists its
  repository — stage, commit, push, publish a branch — and `Ctrl+P` and
  `Ctrl+Shift+F` search it. Nothing here is a copy of those views: they are the
  real ones, working on folders they would otherwise never have been told
  about. Remove the folder from the workspace and CLI Grid offers to drop the
  agent with it.
- **A pin on each row, for which agents come up together.** Four agents in a
  project is rarely four you want running every time, and the odd one out costs
  a pane and a session. Un-pin it and the project's ▶ leaves it alone — it keeps
  its place in the list, says `manual only`, and still starts when you start it.
  The split is sized for the pinned ones, so nothing comes up with a hole in it.
- **Groups, for when four panes are not enough.** Past four agents a pane is too
  small to read, and the usual answer is a second folder in a second window. A
  group is that second folder brought inside this one: each group is a project
  folder with its own agents and its own split, one is on screen at a time, and
  the others keep running behind it with their conversations intact. Switch with
  the layers button above the list, `Ctrl+Alt+G`, or `Ctrl+Alt+]` and
  `Ctrl+Alt+[`.
- **Real git**, from VS Code's own Git extension: branch, ahead/behind and
  change count on each row, and the usual colours on changed files.
- **Layouts that actually split** — 2 × 1, 2 × 2, 3 × 2 and so on, with the
  terminals distributed into the panes rather than stacked in the first one.
  `Auto` picks the smallest split that fits the agents you have.
- **Files open beside the grid, never inside it.** The panes holding agents are
  locked, so a file — from the Explorer, quick open, or go to definition — lands
  in one pane of its own next to the grid. They are ordinary editors: drag the
  tab where you want it, or split it.
- **The image an agent names, opened by clicking it.** A pane a third of the
  window wide is narrower than the paths a CLI prints, so it wraps them itself
  and the workbench is left with two halves of a name, neither of which is a
  file — on WSL that ends as a Windows dialog saying the file cannot be found.
  Clicking either half opens the image beside the grid: the piece on the line
  is the start or the end of a real path, and that is enough to find it.

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
    { "folder": "web", "cli": "gemini", "mode": "resume", "name": "storefront" },
    { "folder": "docs", "cli": "claude", "pinned": false }
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

`pinned: false` keeps an agent in the list but out of the project's start
button; it is what the pin on the row writes.

Agents are listed but **not started** until you select them, so opening a folder
never launches a CLI you did not ask for. Set `cliGrid.autoStart` for the
opposite — it starts the pinned ones, the same set the button does.

Opening the project puts each agent's folder into the window alongside it, which
is what gives them an Explorer root, a Source Control entry and a place in quick
open. The window then calls itself `Untitled (Workspace)` — that is VS Code's
name for a window with more than one folder in it, and nothing about the way you
opened the project changes: the folder list is rebuilt from the project file
every time, so there is no workspace file to save or reopen.

## Groups

More than about four agents and every pane is too small to read. The way round
that used to be a second project folder in a second VS Code window; a group is
that second folder, in this window.

Use **Add Group...** from the `...` menu above the Agents list and pick a
folder. It is recorded in the folder you opened:

```jsonc
{
  "layout": "grid-2x2",
  "groups": ["../work-b"],
  "agents": [ /* ... */ ]
}
```

Each group is a project folder in its own right, with its own
`.vscode/cli-grid.json`, its own agents and its own split — four agents in a
2 × 2 in one, two in a 2 × 1 in the next. The Agents view lists them all, with a
filled dot on the one the grid is showing; select another row, press the layers
button in the view title, or use `Ctrl+Alt+G` (`Ctrl+Alt+]` / `Ctrl+Alt+[` to go
straight to the next or previous one).

**Switching does not stop anything, and mostly does not move anything either.**
When the group you are switching to fills the grid, it simply takes the front
tab of each pane and the one you were on stays behind it — same processes, same
conversations, and the tab is still there to click if you want to look in on it.
Two groups laid out the same way switch in a tab's worth of work, with no split
re-applied and nothing to redraw.

A group too small to cover the grid would leave a pane showing the wrong agents,
so in that case the outgoing ones go down into the terminal panel instead, still
running. The panel is put away again afterwards, so the grid keeps the whole
window — press ``Ctrl+` `` to look in on them. Which group you were last on is
remembered per folder, along with each group's split.

Only the folder you opened is read for a `groups` list, so the way in is still
opening a folder — and opening a group folder directly gives you that group on
its own, exactly as it always did.

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
- An agent's folder is added to the window, never the other way round: a folder
  you add yourself is not adopted as an agent.

## License

MIT
