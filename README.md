# CLI Grid

Run several CLI coding agents side by side — Claude Code, Codex, Gemini CLI,
Devin, opencode — without losing track of which repository each one is sitting in.

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
  its place in the list, is greyed with an `M` at the edge of its row, and still
  starts when you start it. The split is sized for the pinned ones, so nothing
  comes up with a hole in it.
- **Real git**, from VS Code's own Git extension: branch, ahead/behind and
  change count on each row, and the usual colours on changed files.
- **Layouts that actually split** — 2 × 1, 2 × 2, 3 × 2 and so on, with the
  terminals distributed into the panes rather than stacked in the first one.
  `Auto` picks the smallest split that fits the agents you have.
- **Files open beside the grid, never inside it.** The panes holding agents are
  locked, so a file — from the Explorer, quick open, or go to definition — lands
  in one pane of its own next to the grid. They are ordinary editors: drag the
  tab where you want it, or split it.
- **The path an agent names, opened by clicking it — wrapped or not.** A pane a
  third of the window wide is narrower than the paths a CLI prints, so it wraps
  them itself and the workbench is left with two halves of a name, neither of
  which is a file — on WSL that ends as a Windows dialog saying the file cannot
  be found. Clicking either half opens the file beside the grid, whatever kind
  of file it is and wherever it is. CLI Grid keeps the lines each agent's
  terminal is sent, so it knows what the line above ended on and the line below
  starts with, for any CLI. Where it could not listen — `launchStrategy` set to
  `exec`, or shell integration turned off — it looks the piece up in the
  conversation Claude Code, Codex and Devin keep on disk, and failing that
  searches the folders around the agent for an image whose path starts or ends
  that way.

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

## New vs resume

CLI Grid does not manage conversation state. It only chooses which arguments
to pass; the CLI owns everything after that.

| CLI | new | resume |
| --- | --- | --- |
| Claude Code | `claude` | `claude --continue` |
| Codex | `codex` | `codex resume --last` |
| Gemini | `gemini` | `gemini --resume` |
| Devin | `devin` | `devin --continue` |
| opencode | `opencode` | `opencode --continue` |

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

## Answering an agent from outside VS Code

An agent waiting at its prompt can only be answered through its terminal, and
the terminal belongs to the window. With `cliGrid.remoteInput` on, the window
types for anything that asks — a script, a chat bridge on your phone, another
agent.

Every terminal CLI Grid opens carries these environment variables, and so does
whatever the CLI runs in it, such as a hook:

| Variable | What it is |
|---|---|
| `CLI_GRID_AGENT` | A name for that terminal, unique across windows |
| `CLI_GRID_SOCKET` | Where the window that owns it listens: a socket file, or a named pipe on Windows |
| `CLI_GRID_PROFILE` | Which CLI it is: the profile id, such as `claude` |

To answer an agent, connect there and send one line of JSON. One line comes
back, and the window hangs up:

```
→ {"agent": "3fa9c2e1", "text": "go ahead with the migration"}
← {"ok": true}
```

```python
import json, socket

def answer(sock, agent, text):
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(sock)
        s.sendall((json.dumps({"agent": agent, "text": text}) + "\n").encode())
        return json.loads(s.makefile().readline())
```

The window types the text and presses Enter; several lines go in as a paste.
That is right for an agent waiting at its prompt. One that is working would
hold the message until it is done; add `"now": true` to have it stop and read
it instead (see [Wrapping up](#wrapping-up-before-closing-the-window) for the
keys that takes).
A request it cannot carry out is answered `{"ok": false, "error": "…"}` — no
such agent in this window, empty text, or a CLI that has exited and left its
shell behind, where the text would run as a command. A window that has been
closed is not listening at all, so the connection itself fails. Each window has
its own socket and each session carries the address of its own window, so any
number of windows can be open at once.

A session knows its own name and no one else's. To reach whoever is working in
a folder — one agent telling another its change is pushed, say — ask the window
who it has:

```
→ {"list": true}
← {"ok": true, "agents": [{"agent": "3fa9c2e1", "profile": "claude", "cwd": "/work/site", "exited": false}]}
```

`cwd` is the folder the terminal was opened in, and `exited` marks a CLI that
has left its shell behind. The agent may be in another window, so ask them all:
every window's socket is a file named `cli-grid-*.sock` in `$XDG_RUNTIME_DIR`,
or in the temporary directory where that is not set (on Windows, a pipe named
`cli-grid-*`). A file nothing answers on is a window that did not shut down
cleanly.

The setting is off by default because it lets any process running as you drive
a terminal. It applies to agents started after it is turned on.

## Wrapping up before closing the window

A CLI that is cut off in the middle of something — a subagent still running, a
build in the background — often cannot carry on from there when it is resumed.
**CLI Grid: Ask All Agents to Wrap Up** types one message into every running
agent, asking it to stop and note where it is, so that closing the window and
starting everything resumed picks up cleanly. The message is
`cliGrid.wrapUpMessage`.

A busy CLI holds a typed message until its current work is done, which is too
late here, so the message is followed by the keys that CLI's own prompt offers
for sending at once: ctrl+enter for Claude Code, esc for Codex, a second enter
for Devin. A profile can name its own in `cliGrid.profiles` as `sendNow`, a
list of the raw sequences to send (`["\u001b"]` is esc).

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
| `cliGrid.followSwitchedCli` | `ask` | When an agent's terminal starts another CLI, whether the project file switches that folder to it (`never`, `ask`, `always`) |
| `cliGrid.remoteInput` | `false` | Listen for messages to type into an agent, from scripts outside the window |
| `cliGrid.wrapUpMessage` | *(see above)* | What **Ask All Agents to Wrap Up** types |
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
