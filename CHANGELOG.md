# Changelog

## 0.1.0 — 2026-08-07

First release.

### Added

- **CLI Grid view container** in the Activity Bar, holding three views:
  **Agents**, **Files** and **Layout**.
- **Per-folder configuration** in `.vscode/cli-grid.json`. Opening a folder
  restores its agents and split; a different set of agents is a different
  folder. Commit the file to share a setup, or gitignore it to keep it local.
- **Built-in CLI profiles** for Claude Code, Codex and Gemini, with a
  new-vs-resume choice per launch, per profile or per agent. Arguments are
  passed through untouched, and `cliGrid.profiles` adds or hides entries.
- **Agent rows named after their folder** — the last segment of it, with the CLI
  as the description and the whole path in the hover.
- **Files view scoped to the focused agent** — selecting an agent, or clicking
  its terminal tab, switches the tree to the folder that CLI runs in. File icons
  and git colours come from the icon theme and the built-in Git extension.
- **Find a file by name in the focused agent's folder** — `Ctrl+P` anywhere in a
  CLI Grid project, the search button on the Files view, or _CLI Grid: Find File
  in the Agent's Folder_. It walks the folder itself rather than going through
  the workbench's search, so it reaches agents working outside the opened
  folder, and what it finds opens in the file pane beside the grid. With no
  agent focused there is nothing more specific to search than the folder the
  window was opened on, so `Ctrl+P` hands back to Quick Open.
- **Git for folders outside the workspace**, registered through the Git API's
  `openRepository`, so agents pointed anywhere still show branch, ahead/behind
  and change counts.
- **Layouts that distribute terminals** into their panes: 1, 2 × 1, 1 × 2,
  3 × 1, 2 × 2, 3 × 2, 4 × 2, plus `Auto`, which picks the smallest split that
  fits the running agents. More agents than panes wrap into tabs.
- **A file pane beside the grid.** Panes holding an agent are locked, so files
  opened from the Files view — or from quick open, or go to definition — split
  off one pane next to the grid and stack there as ordinary tabs, leaving the
  grid its shape. Re-splitting the grid takes them along. Turn it off with
  `cliGrid.lockAgentPanes`.
- **Drag out of the Files view** — onto an editor group, onto a terminal, which
  pastes the path, or into another window. Multi-select works.
- **Drop into the Files view to copy** — from another agent's folder, from the
  Explorer, or from outside the window. The drop target's folder receives the
  copy, and a name already in use gets " copy" appended, so nothing is
  overwritten and nothing is moved out of where it was.
- **A context menu on the empty part of the Files view** — new file, new folder,
  paste, find, open in terminal — all acting on the folder the view is showing,
  which is where you reach for New when no row is the one you mean.
- **File operations on the Files view**: new file, new folder, rename (`F2`),
  delete to the trash, cut/copy/paste (`Ctrl+X`/`C`/`V`), copy path, copy
  relative path, reveal in the OS file manager, reveal in VS Code's Explorer,
  open in the integrated terminal. Where the workbench already has the command
  it is forwarded to it; rename and paste-after-cut go through `WorkspaceEdit`,
  so the file-operation participants run — imports get updated — and the change
  is undoable. Delete honours `explorer.confirmDelete` and asks once for a whole
  selection rather than once per file.
- **Drag to reorder agents** in the Agents view. The order is the order in the
  project file, which is also the order `startAll` hands out panes in, so
  dragging a row is how you decide which pane an agent comes up in.
- **Per-agent settings** (the gear on each row): a display name, which CLI it
  runs, and whether it starts new or resumed. Each is written to that agent's
  own entry in the project file — `cliGrid.profiles` remains the place for a
  change meant for every agent of one kind.
- **Remote support** — declared as a workspace extension, so under Remote-WSL,
  Remote-SSH or a dev container the folder picker, CLI detection and terminals
  all run on the remote host.
- Korean localisation.
