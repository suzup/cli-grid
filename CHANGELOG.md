# Changelog

## 0.1.0 — unreleased

First release.

### Added

- **Agent Grid view container** in the Activity Bar, holding three views:
  **Agents**, **Files** and **Layout**.
- **Per-folder configuration** in `.vscode/agent-grid.json`. Opening a folder
  restores its agents and split; a different set of agents is a different
  folder. Commit the file to share a setup, or gitignore it to keep it local.
- **Built-in CLI profiles** for Claude Code, Codex and Gemini, with a
  new-vs-resume choice per launch, per profile or per agent. Arguments are
  passed through untouched, and `agentGrid.profiles` adds or hides entries.
- **Files view scoped to the focused agent** — selecting an agent, or clicking
  its terminal tab, switches the tree to the folder that CLI runs in. File icons
  and git colours come from the icon theme and the built-in Git extension.
- **Git for folders outside the workspace**, registered through the Git API's
  `openRepository`, so agents pointed anywhere still show branch, ahead/behind
  and change counts.
- **Layouts that distribute terminals** into their panes: 1, 2 × 1, 1 × 2,
  3 × 1, 2 × 2, 3 × 2, 4 × 2, plus `Auto`, which picks the smallest split that
  fits the running agents. More agents than panes wrap into tabs.
- **Remote support** — declared as a workspace extension, so under Remote-WSL,
  Remote-SSH or a dev container the folder picker, CLI detection and terminals
  all run on the remote host.
- Korean localisation.
