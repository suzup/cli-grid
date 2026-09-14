# Changelog

## Unreleased

### Added

- **Image paths in an agent's terminal are clickable**, including the ones the
  CLI broke over two lines to fit the pane. Neither half of a wrapped path is a
  file, so the workbench used to hand it to the operating system to open — which
  in a WSL window means a Linux path given to Windows, and a dialog saying the
  file cannot be found. The halves are matched back against the file system and
  the image opens in the pane beside the grid; where a piece names more than one
  file, CLI Grid asks rather than picking.

## 0.1.0 — 2026-08-07

First release.

### Added

- **CLI Grid view container** in the Activity Bar, holding **Agents** and
  **Layout**. Files and git are the workbench's own views, on folders CLI Grid
  puts in the window.
- **Per-folder configuration** in `.vscode/cli-grid.json`. Opening a folder
  restores its agents and split; a different set of agents is a different
  folder. Commit the file to share a setup, or gitignore it to keep it local.
- **Each agent's folder added to the window** as a workspace folder, so the
  Explorer, Source Control and quick open reach it — an agent regularly works
  outside the folder you opened, and none of those would otherwise know it
  exists. Adding an agent adds its folder; removing one takes it back out; and
  removing the folder yourself offers to remove the agents that worked in it,
  their settings included. The folder list is rebuilt from the project file on
  every open, so the way in is still File > Open Folder — there is no workspace
  file to save. Appending folders is deliberate: replacing the first one would
  restart the extension host and take every running agent with it.
- **Built-in CLI profiles** for Claude Code, Codex and Gemini, with a
  new-vs-resume choice per launch, per profile or per agent. Arguments are
  passed through untouched, and `cliGrid.profiles` adds or hides entries.
- **Agent rows named after their folder** — the last segment of it, with the CLI
  as the description and the whole path in the hover.
- **Layouts that distribute terminals** into their panes: 1, 2 × 1, 1 × 2,
  3 × 1, 2 × 2, 3 × 2, 4 × 2, plus `Auto`, which picks the smallest split that
  fits the running agents. More agents than panes wrap into tabs.
- **A file pane beside the grid.** Panes holding an agent are locked, so files
  opened from the Explorer — or from quick open, or go to definition — split off
  one pane next to the grid and stack there as ordinary tabs, leaving the grid
  its shape. Re-splitting the grid takes them along. Turn it off with
  `cliGrid.lockAgentPanes`.
- **Drag to reorder agents** in the Agents view. The order is the order in the
  project file, which is also the order `startAll` hands out panes in and the
  order re-applying a split arranges them in, so dragging a row is how you
  decide which pane an agent comes up in — whichever order they were started in.
- **A pin per agent**, deciding which of them the project's start button brings
  up. Un-pinned agents keep their place in the list and start on their own; the
  split is sized for the pinned ones. Written as `"pinned": false`, so a project
  file that says nothing about pins starts everything, as it always did.
- **Per-agent settings** (the gear on each row): a display name, which CLI it
  runs, and whether it starts new or resumed. Each is written to that agent's
  own entry in the project file — `cliGrid.profiles` remains the place for a
  change meant for every agent of one kind.
- **Remote support** — declared as a workspace extension, so under Remote-WSL,
  Remote-SSH or a dev container the folder picker, CLI detection and terminals
  all run on the remote host.
- Korean localisation.
