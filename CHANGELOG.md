# Changelog

## Unreleased

### Added

- **A built-in profile for opencode** (`opencode`). Resume passes
  `--continue`, opencode's flag for the last session; it has no session picker
  to open instead. Its paths cut in two are found in the conversations it keeps
  in its database, read with the SQLite the VS Code server's runtime has. Wrap
  Up reaches it mid-task by stopping it first: opencode has no key that sends a
  queued message at once, and stopping it leaves that message unanswered, so a
  profile can now name keys to press before the message (`interrupt`) as well
  as after it (`sendNow`).

- **An agent follows the CLI its terminal is running.** Quit Devin and start
  Claude at the prompt it leaves, and the row, `{"list": true}` and the keys
  that make a busy agent read a message now are Claude's — before, a terminal
  opened for codex could press codex's Esc into the Claude that replaced it,
  which stops Claude's work. Whether the project file starts the new CLI for
  that folder from then on is `cliGrid.followSwitchedCli`: `ask` (default),
  `always` or `never`. Read off the process table, so Linux and WSL only, and
  only for terminals opened through the shell.

- **Answering an agent from outside VS Code** (`cliGrid.remoteInput`, off by
  default). Every terminal CLI Grid opens carries `CLI_GRID_AGENT` and
  `CLI_GRID_SOCKET`; a line of JSON sent to that socket is typed into that
  agent and submitted, so a script — a chat bridge, a scheduler, another agent —
  can answer a CLI that is waiting at its prompt without a terminal multiplexer
  in between. Each window listens on its own socket, so several can be open.
  `{"list": true}` asks a window which agents it has and the folder each was
  opened in, so a sender that knows only a folder — one agent notifying
  another — can find who to type to.

- **Ask All Agents to Wrap Up**, for before the window is closed: one message
  (`cliGrid.wrapUpMessage`) typed into every running agent, asking it to stop
  background work and note where it is so that resuming picks up cleanly. An
  agent in the middle of something reads it at once rather than after: each
  profile names the keys that take (`sendNow`).

- **A built-in profile for Devin** (`devin`), alongside Claude Code, Codex and
  Gemini. Resume passes `--continue`, which is Devin's shortcut to the most
  recent conversation in the folder rather than its session picker — the same
  pair of flags Claude Code has.

- **Image paths in an agent's terminal are clickable**, including the ones the
  CLI broke over two lines to fit the pane. Neither half of a wrapped path is a
  file, so the workbench used to hand it to the operating system to open — which
  in a WSL window means a Linux path given to Windows, and a dialog saying the
  file cannot be found. The halves are matched back against the file system and
  the image opens in the pane beside the grid; where a piece names more than one
  file, CLI Grid asks rather than picking.

- **A wrapped path of any kind opens from either half**, not only an image, and
  wherever the file is. The halves used to be matched against the folders around
  the agent, which found nothing for a file elsewhere on the machine and did not
  try for anything but an image. Now the lines an agent's terminal is sent are
  kept as they go by — shell integration lets an extension read what a command
  writes — so the piece under the cursor is put back against the line it was cut
  from, with any CLI: a path from the root or a relative one, cut inside a
  folder's name or a file's, over two lines or four. A terminal that could not
  be listened to falls back on the conversation Claude Code, Codex and Devin
  write to disk, where every path is whole, and then on the old search.

### Changed

- **An agent that is only started by hand is greyed in the list**, with an `M`
  at the edge of its row. `manual only` at the end of a line of grey text did
  not set a row apart from the ones around it.

- **Resuming a Claude agent closes the same folder's Claude running elsewhere in
  VS Code first** — panes in other windows, VS Code terminals, and the Claude
  extension panel. Two processes on one conversation split Remote Control
  between them and neither works right, so the resumed agent now starts against
  a clean session. Terminals opened outside VS Code are the user's own and are
  left alone; the check is Linux only.

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
